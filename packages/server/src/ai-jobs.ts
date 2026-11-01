import { DEFAULT_PLAN_SYSTEM, DEFAULT_PLAN_USER, DEFAULT_WIKI_SYSTEM, DEFAULT_WIKI_USER } from './docgen.js';
import type { Role } from './provider-store.js';

/**
 * Everything an administrator can set for one AI job (Admin -> LLM, step 4): how much the AI may write, how it
 * samples, how long a call may take, and the words it is given. Nothing here is hard-coded in the generators:
 * they read the effective values, which are the stored settings or, where nothing is stored, the defaults below.
 */
/** The levels OpenAI-style APIs know for `reasoning_effort`. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface JobSettings {
  /** Upper limit of the answer (output tokens). You pay per token written, so this is the cost ceiling of one call. */
  maxTokens?: number;
  /** 0-2. Unset = the provider's own default (not sent). Lower = more factual and repeatable. */
  temperature?: number;
  /** 0-1 nucleus sampling. Unset = the provider's own default (not sent). */
  topP?: number;
  /**
   * How long a reasoning model thinks before it answers. The thinking is written as output tokens: it is waited for and paid for, and it can be
   * most of what a call produces. Unset = the provider's own default (not sent). Sent as `reasoning_effort` to OpenAI-compatible providers only.
   */
  reasoningEffort?: ReasoningEffort;
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
  defaults: Required<Pick<JobSettings, 'maxTokens' | 'timeoutMinutes' | 'systemPrompt' | 'userPrompt'>> & Pick<JobSettings, 'temperature' | 'topP' | 'reasoningEffort'>;
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
      'Creates the architecture diagrams. The text model (the one chosen for Text) reads the article and writes a PLAN as data using the prompts below: an overview picture and, for a bigger system, detail pictures by topic (at most 5 pictures, each with at most 10 boxes and 14 arrows, columns of boxes and the arrows between them); Mnemosyne itself then draws every picture from that plan, so every word is spelled exactly and the layout is always the same. No image model is called for diagrams, so the model chosen here is not used by them. Runs when an administrator presses “Create workflow diagram” and agrees to the cost. The limit, sampling values and prompts below belong to the text call that writes the plan.',
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
  reasoningEffort?: ReasoningEffort;
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
    reasoningEffort: s?.reasoningEffort ?? d.reasoningEffort,
    timeoutMinutes: s?.timeoutMinutes ?? d.timeoutMinutes,
    systemPrompt: s?.systemPrompt?.trim() ? s.systemPrompt : d.systemPrompt,
    userPrompt: s?.userPrompt?.trim() ? s.userPrompt : d.userPrompt,
  };
}
