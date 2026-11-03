// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The cost center of the AI: one JSON line for every AI job that ran. This server writes the jobs people start with a button on a project page,
 * the admin program writes the automatic ones; both append to the same file and the admin page "LLM usage" reads it. The cost is counted from
 * the tokens the provider reports (and one price per picture) at the list price of the model: providers answer with token counts, not with an
 * amount of money.
 */
export interface UsageLine {
  /** TEXT (an article), IMAGES (the text call that plans the diagram) or PICTURES (the image model painting it). */
  what: 'TEXT' | 'IMAGES' | 'PICTURES';
  model: string;
  calls: number;
  in: number;
  out: number;
  reasoning?: number;
  usd: number;
  ms: number;
}

export interface UsageEntry {
  id?: string;
  /** ISO-8601 UTC start. */
  time: string;
  end: string;
  ms: number;
  trigger: 'person' | 'auto';
  /** The GitLab user who pressed the button. */
  by: string;
  project: string;
  kind: 'wiki' | 'diagram';
  status: 'done' | 'failed';
  lines: UsageLine[];
  note?: string;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Appends one job. Never throws: a logging problem must not stop an AI job. */
export async function appendUsage(file: string, e: UsageEntry): Promise<void> {
  try {
    const lines = e.lines.map((l) => ({ ...l, usd: round6(l.usd) }));
    const full = {
      id: e.id ?? `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      time: e.time,
      end: e.end,
      ms: e.ms,
      trigger: e.trigger,
      by: e.by,
      project: e.project,
      kind: e.kind,
      status: e.status,
      usd: round6(lines.reduce((s, l) => s + l.usd, 0)),
      in: lines.reduce((s, l) => s + l.in, 0),
      out: lines.reduce((s, l) => s + l.out, 0),
      lines,
      ...(e.note ? { note: e.note } : {}),
    };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(full)}\n`, { mode: 0o640 });
  } catch (err) {
    console.error('usage log:', (err as Error).message);
  }
}
