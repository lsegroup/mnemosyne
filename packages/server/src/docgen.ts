import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryNode } from '@mnemosyne/core';
import { redact } from './docs.js';
import type { ImageResult } from './llm-call-image.js';

/**
 * Generated project documentation: a Wikipedia-style document written from a project's notes, an
 * optional workflow-diagram image, and a PDF built from both. Every artefact is stored with its
 * date stamp, so earlier versions stay available.
 *
 * This file builds prompts and stores results; the actual model calls live in llm-call-chat.ts and
 * llm-call-image.ts (the only places that spend money).
 */

export type DocKind = 'wiki' | 'diagram' | 'pdf';

export interface DocMeta {
  kind: DocKind;
  /** Compact UTC timestamp, also the version id: 20261029T170500Z */
  id: string;
  /** ISO-8601 UTC. */
  generatedAt: string;
  project: string;
  /** Provider label + model, e.g. "Meta Model API / muse-spark-1.3". Empty for PDFs (no AI). */
  model: string;
  by: string;
  noteCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** The wiki version a diagram or PDF was made from. */
  basedOn?: string;
  /** The diagram a PDF embeds, if there was one. */
  diagram?: string;
  ext: string;
}

export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

const safe = (s: string) => s.replace(/[^a-z0-9._-]/gi, '-').toLowerCase() || 'misc';

export class DocStore {
  constructor(private readonly root: string) {}

  private dir(project: string) {
    return join(this.root, safe(project));
  }

  async save(meta: Omit<DocMeta, 'id' | 'generatedAt'> & { id?: string }, content: string | Buffer): Promise<DocMeta> {
    const now = new Date();
    const full: DocMeta = { ...meta, id: meta.id ?? stamp(now), generatedAt: now.toISOString() };
    const dir = this.dir(meta.project);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${meta.kind}-${full.id}.${meta.ext}`), content, { mode: 0o640 });
    await writeFile(join(dir, `${meta.kind}-${full.id}.json`), JSON.stringify(full, null, 2), { mode: 0o640 });
    return full;
  }

  /** Newest first. */
  async list(project: string, kind: DocKind): Promise<DocMeta[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir(project));
    } catch {
      return [];
    }
    const metas: DocMeta[] = [];
    for (const n of names.filter((x) => x.startsWith(`${kind}-`) && x.endsWith('.json'))) {
      try {
        metas.push(JSON.parse(await readFile(join(this.dir(project), n), 'utf8')) as DocMeta);
      } catch {
        /* skip a torn file */
      }
    }
    return metas.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  async latest(project: string, kind: DocKind): Promise<DocMeta | null> {
    return (await this.list(project, kind))[0] ?? null;
  }

  async get(project: string, kind: DocKind, id: string): Promise<DocMeta | null> {
    if (!/^\d{8}T\d{6}Z$/.test(id)) return null;
    return (await this.list(project, kind)).find((m) => m.id === id) ?? null;
  }

  async read(meta: DocMeta): Promise<Buffer> {
    return readFile(join(this.dir(meta.project), `${meta.kind}-${meta.id}.${meta.ext}`));
  }
}

// ----------------------------------------------------------------------------
// Cost estimate shown in the confirmation dialog (Meta's published list prices, USD per 1M tokens).
// ----------------------------------------------------------------------------
const PRICES: Record<string, { in: number; out: number }> = {
  'muse-spark-1.3': { in: 1.25, out: 4.25 },
  'muse-spark-1.2': { in: 1.25, out: 4.25 },
  'muse-spark-1.3-contributor': { in: 0.1, out: 0.2 },
  'muse-wonder-1.0': { in: 4.0, out: 20.0 },
};
export const IMAGE_PRICE_USD = 0.01; // muse-image-1.0, per image

export const approxTokens = (chars: number) => Math.ceil(chars / 4);

export function estimateText(model: string, inputTokens: number, outputTokens: number): { usd: number | null; text: string } {
  const p = PRICES[model];
  if (!p) return { usd: null, text: `about ${inputTokens.toLocaleString('en-US')} tokens in and up to ${outputTokens.toLocaleString('en-US')} out (no list price known for ${model})` };
  const usd = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
  return {
    usd,
    text: `about ${inputTokens.toLocaleString('en-US')} tokens in and up to ${outputTokens.toLocaleString('en-US')} out, roughly $${usd < 0.01 ? '<0.01' : usd.toFixed(2)} at the list price ($${p.in} / $${p.out} per 1M tokens)`,
  };
}

// ----------------------------------------------------------------------------
// Prompts
// ----------------------------------------------------------------------------
const MAX_NOTE_CHARS = 3_000_000; // ~750k tokens: stays inside a 1M-token context

export interface WikiPrompt {
  system: string;
  user: string;
  noteCount: number;
  inputTokens: number;
}

/** The notes are masked (credentials) before they ever leave this server. */
export function buildWikiPrompt(project: string, gitlabName: string | null, notes: MemoryNode[]): WikiPrompt {
  const ordered = [...notes].sort((a, b) => (b.observed_at ?? '').localeCompare(a.observed_at ?? ''));
  let used = 0;
  const parts: string[] = [];
  for (const n of ordered) {
    const block = [
      `### NOTE ${n.id}`,
      `title: ${n.title}`,
      `type: ${n.type}   status: ${n.status}   observed: ${n.observed_at ?? 'unknown'}`,
      n.components.length ? `components: ${n.components.join(', ')}` : '',
      '',
      redact(n.body),
    ]
      .filter((l) => l !== '')
      .join('\n');
    if (used + block.length > MAX_NOTE_CHARS) break;
    used += block.length;
    parts.push(block);
  }
  const system = [
    'You are a technical writer producing encyclopedia-style product and disaster-recovery documentation for one software project.',
    'Write ONLY from the notes you are given. Do not invent facts, versions, numbers or names. If something important is not covered by the notes, say it is "not documented".',
    'Never write passwords, tokens, API keys or private keys, even if a note seems to contain one.',
    'Output GitHub-flavoured Markdown only, with no preamble and no closing remarks.',
  ].join(' ');
  const user = [
    `Project: ${gitlabName ?? project}`,
    '',
    'Write the project documentation page. Do NOT write a title heading (the page already shows the name) and do NOT write a change history or timeline (the server adds the list of the latest notes itself). Use exactly this structure:',
    '1. FIRST, with no heading: one product-description paragraph (3 to 6 sentences) saying what the product is, who uses it, what it does and its current state.',
    '2. "## Hardware and software requirements": one paragraph or short bullet list of the hardware (hosts, CPU/RAM/disk/network where the notes say) and software (OS, runtimes, databases, services, versions, licences, external dependencies) it needs. Say "not documented" for anything the notes do not state.',
    '3. "## Disaster recovery": complete recovery documentation, written so an engineer who has never seen the system can rebuild it. Use these sub-headings:',
    '   "### What is required" (accounts, repositories, secrets by NAME only and where they are stored, DNS/certificates, backups, hosts)',
    '   "### Installation / rebuild steps" (a numbered list in the order to execute, with the real hostnames, paths, service names and commands from the notes)',
    '   "### Access" (how to reach it: URLs, ports, login method, which role/account type, which host to connect to; never write passwords or tokens)',
    '   "### Testing and verification" (numbered checks that prove the system works after a rebuild, with the expected result)',
    '   "### Known gotchas" (only issues from the notes that matter for a rebuild)',
    'Keep it factual and scannable: short paragraphs, numbered steps, tables where they help. Where the notes conflict, prefer the newer note.',
    '',
    `There are ${parts.length} notes. Here they are, newest first:`,
    '',
    parts.join('\n\n'),
  ].join('\n');
  return { system, user, noteCount: parts.length, inputTokens: approxTokens(system.length + user.length) };
}

export function buildDiagramBriefPrompt(project: string, wiki: string): { system: string; user: string } {
  return {
    system:
      'You write prompts for an image-generation model. Output only the prompt text, in English, no quotes, no markdown, no explanations.',
    user: [
      `Below is an article about the software project "${project}".`,
      'Write ONE prompt that makes an image model draw a clear WORKFLOW / ARCHITECTURE DIAGRAM of it:',
      '- a clean flow chart on a plain white background, dark navy lines and boxes with violet and teal accent colours, flat vector style, landscape orientation',
      '- boxes for the main components or steps (at most 12), connected by labelled arrows that show the real flow of work or data from start to finish',
      '- short, legible English labels taken from the article; no paragraphs of text, no logos, no people, no photographs',
      '- a title at the top with the project name',
      'Name each box and each arrow label explicitly in the prompt so the model does not invent its own.',
      '',
      '--- ARTICLE ---',
      wiki.slice(0, 60_000),
    ].join('\n'),
  };
}

/** PDFs cannot embed WebP; convert it (or pass PNG/JPEG through). Returns null if conversion is impossible. */
export async function toPdfImage(img: ImageResult): Promise<Buffer | null> {
  if (img.mime === 'image/png' || img.mime === 'image/jpeg') return img.bytes;
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(img.bytes).png().toBuffer();
  } catch (err) {
    console.error('docgen: WebP to PNG conversion failed:', (err as Error).message);
    return null;
  }
}

// ----------------------------------------------------------------------------
// Change history: built by the server from the newest notes, never written by the AI.
// ----------------------------------------------------------------------------
export interface HistoryEntry {
  id: string;
  date: string;
  title: string;
  type: string;
  status: string;
}

export const HISTORY_LIMIT = 20;

export function changeHistory(notes: MemoryNode[], limit = HISTORY_LIMIT): HistoryEntry[] {
  return [...notes]
    .sort((a, b) => (b.observed_at ?? '').localeCompare(a.observed_at ?? '') || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map((n) => ({ id: n.id, date: n.observed_at ? `${n.observed_at.slice(0, 10)} ${n.observed_at.slice(11, 16)}`.trim() : 'unknown', title: redact(n.title), type: n.type, status: n.status }));
}

/** Markdown for the PDF: a rule, the heading and a table (the web page renders its own, linked, version). */
export function historyMarkdown(entries: HistoryEntry[]): string {
  const cell = (t: string) => t.replace(/\|/g, '/').replace(/\s+/g, ' ');
  return [
    '',
    '---',
    '',
    '## Change history',
    '',
    `The ${entries.length} most recently submitted notes, newest first, show what was changed or deployed last.`,
    '',
    '| Date (UTC) | Note | Type |',
    '| --- | --- | --- |',
    ...entries.map((e) => `| ${e.date} | ${cell(e.title)} | ${e.type} |`),
    '',
  ].join('\n');
}

/** The sections the owner's layout requires; the AI is asked for them but cannot be forced, so the result is checked. */
export function missingSections(markdown: string): string[] {
  const need: [string, RegExp][] = [
    ['Hardware and software requirements', /^##\s+Hardware and software requirements\b/im],
    ['Disaster recovery', /^##\s+Disaster recovery\b/im],
    ['Installation / rebuild steps', /^###\s+Installation/im],
    ['Access', /^###\s+Access\b/im],
    ['Testing and verification', /^###\s+Testing/im],
  ];
  return need.filter(([, re]) => !re.test(markdown)).map(([n]) => n);
}
