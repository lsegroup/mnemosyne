import { DEFAULT_PLAN_SYSTEM, DEFAULT_PLAN_USER, DEFAULT_WIKI_SYSTEM, DEFAULT_WIKI_USER } from './docgen.js';
import { ProviderValidationError, type Role } from './provider-store.js';

/**
 * Everything an administrator can set for one AI job (Admin -> LLM, step 3): how much the AI may write, how it
 * samples, how long a call may take, and the words it is given. Nothing here is hard-coded in the generators:
 * they read the effective values, which are the stored settings or, where nothing is stored, the defaults below.
 */
export interface JobSettings {
  /** Upper limit of the answer (output tokens). You pay per token written, so this is the cost ceiling of one call. */
  maxTokens?: number;
  /** 0-2. Unset = the provider's own default (not sent). Lower = more factual and repeatable. */
  temperature?: number;
  /** 0-1 nucleus sampling. Unset = the provider's own default (not sent). */
  topP?: number;
  /** Time limit of one call to the provider. */
  timeoutMinutes?: number;
  /** Tells the AI who it is and the rules it must follow. */
  systemPrompt?: string;
  /** The request itself, with {{placeholders}} that the server fills in. */
  userPrompt?: string;
}

/** Highest output limit an administrator may set per call (Meta's Muse models accept up to 1 million output tokens). */
export const MAX_OUTPUT_TOKENS = 1_000_000;

export type JobsFile = Partial<Record<Role, JobSettings>>;

export interface Placeholder {
  name: string;
  meaning: string;
  required: boolean;
}

export interface JobDef {
  role: Role;
  title: string;
  /** What this job is for and when it runs. */
  summary: string;
  /** The job makes a (paid) AI call that these settings control. */
  usesAi: boolean;
  /** Which prompt belongs to which call. */
  systemLabel: string;
  userLabel: string;
  placeholders: Placeholder[];
  defaults: Required<Pick<JobSettings, 'maxTokens' | 'timeoutMinutes' | 'systemPrompt' | 'userPrompt'>> & Pick<JobSettings, 'temperature' | 'topP'>;
}

export const JOB_DEFS: Record<Role, JobDef> = {
  text: {
    role: 'text',
    title: 'Text',
    summary:
      'Writes the project documentation page from all notes of a project (product description, hardware and software requirements, disaster recovery). Runs when an administrator presses “Generate documentation” and agrees to the cost.',
    usesAi: true,
    systemLabel: 'System prompt - who the AI is and the rules it must follow',
    userLabel: 'Instruction - what the AI is asked to write',
    placeholders: [
      { name: 'project', meaning: 'the project name (GitLab project name when one matches)', required: false },
      { name: 'notes_count', meaning: 'how many notes are sent', required: false },
      { name: 'notes', meaning: 'all notes of the project, newest first, credentials masked', required: true },
    ],
    defaults: { maxTokens: 50_000, timeoutMinutes: 20, systemPrompt: DEFAULT_WIKI_SYSTEM, userPrompt: DEFAULT_WIKI_USER },
  },
  image: {
    role: 'image',
    title: 'Images',
    summary:
      'Creates the architecture diagram. The text model (the one chosen for Text) reads the article and writes a PLAN of the picture as data (columns of boxes and the arrows between them) using the prompts below; Mnemosyne itself then draws the picture from that plan, so every word is spelled exactly and the layout is always the same. No image model is called for diagrams, so the model chosen here is not used by them. Runs when an administrator presses “Create workflow diagram” and agrees to the cost. The limit, sampling values and prompts below belong to the text call that writes the plan.',
    usesAi: true,
    systemLabel: 'System prompt for the diagram plan - who the AI is and the rules',
    userLabel: 'Instruction for the diagram plan - what the picture must show (the AI must answer with the JSON plan)',
    placeholders: [
      { name: 'project', meaning: 'the project name', required: false },
      { name: 'article', meaning: 'the generated documentation article (first 60,000 characters)', required: true },
    ],
    defaults: { maxTokens: 50_000, timeoutMinutes: 20, systemPrompt: DEFAULT_PLAN_SYSTEM, userPrompt: DEFAULT_PLAN_USER },
  },
  pdf: {
    role: 'pdf',
    title: 'PDF',
    summary:
      'Today the PDF handbook is built from the article and the diagram without any AI call (it costs nothing), so the values below are not used yet and are left empty. They are here, like for the other jobs, so an AI-written PDF handbook can be controlled the same way as soon as it exists: whatever you save now will be used then.',
    usesAi: false,
    systemLabel: 'System prompt - who the AI is and the rules (not used yet)',
    userLabel: 'Instruction - what the AI is asked to write (not used yet)',
    placeholders: [
      { name: 'project', meaning: 'the project name', required: false },
      { name: 'article', meaning: 'the generated documentation article', required: false },
    ],
    defaults: { maxTokens: 50_000, timeoutMinutes: 20, systemPrompt: '', userPrompt: '' },
  },
};

export interface EffectiveJob {
  maxTokens: number;
  temperature?: number;
  topP?: number;
  timeoutMinutes: number;
  systemPrompt: string;
  userPrompt: string;
}

/** Stored settings over the defaults; a blank prompt means the default. */
export function effectiveJob(role: Role, s: JobSettings | undefined): EffectiveJob {
  const d = JOB_DEFS[role].defaults;
  return {
    maxTokens: s?.maxTokens ?? d.maxTokens,
    temperature: s?.temperature ?? d.temperature,
    topP: s?.topP ?? d.topP,
    timeoutMinutes: s?.timeoutMinutes ?? d.timeoutMinutes,
    systemPrompt: s?.systemPrompt?.trim() ? s.systemPrompt : d.systemPrompt,
    userPrompt: s?.userPrompt?.trim() ? s.userPrompt : d.userPrompt,
  };
}

function num(v: unknown, field: string, min: number, max: number, integer: boolean): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw new ProviderValidationError(`${field} must be a number`);
  if (integer && !Number.isInteger(n)) throw new ProviderValidationError(`${field} must be a whole number`);
  if (n < min || n > max) throw new ProviderValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}

/** Validates the admin form; values equal to the default are not stored, so later default improvements still apply. */
export function validateJobSettings(role: Role, input: Record<string, unknown>): JobSettings {
  const def = JOB_DEFS[role];
  const out: JobSettings = {};
  const maxTokens = num(input.maxTokens, 'Max output tokens', 256, MAX_OUTPUT_TOKENS, true);
  if (maxTokens !== undefined && maxTokens !== def.defaults.maxTokens) out.maxTokens = maxTokens;
  const temperature = num(input.temperature, 'Temperature', 0, 2, false);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = num(input.topP, 'Top-p', 0.01, 1, false);
  if (topP !== undefined) out.topP = topP;
  const timeout = num(input.timeoutMinutes, 'Time limit', 1, 60, true);
  if (timeout !== undefined && timeout !== def.defaults.timeoutMinutes) out.timeoutMinutes = timeout;

  for (const [key, label, dflt] of [
    ['systemPrompt', 'System prompt', def.defaults.systemPrompt],
    ['userPrompt', 'Instruction', def.defaults.userPrompt],
  ] as const) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new ProviderValidationError(`${label} must be text`);
    const t = v.replace(/\r\n?/g, '\n');
    if (t.length > 30_000) throw new ProviderValidationError(`${label} is too long (30,000 characters at most)`);
    if (!t.trim() || t.trim() === dflt.trim()) continue; // blank or unchanged = the built-in default
    out[key] = t;
  }
  if (out.userPrompt) {
    for (const p of def.placeholders.filter((x) => x.required)) {
      if (!out.userPrompt.includes(`{{${p.name}}}`)) throw new ProviderValidationError(`The instruction must contain {{${p.name}}} - it is replaced by ${p.meaning}`);
    }
    const known = new Set(def.placeholders.map((x) => x.name));
    for (const m of out.userPrompt.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!known.has(m[1]!)) throw new ProviderValidationError(`Unknown placeholder {{${m[1]}}} (known: ${[...known].map((n) => `{{${n}}}`).join(', ')})`);
    }
  }
  return out;
}
