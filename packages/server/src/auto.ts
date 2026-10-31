/**
 * AUTO - scheduled documentation updates (Admin -> Auto).  *** CAN SPEND MONEY, BUT ONLY WHAT AN ADMINISTRATOR AGREED TO ***
 *
 * This file makes no model call itself. It decides WHEN a run starts and WHICH projects need work, and then asks the injected
 * `generate()` (web.ts: the very code the project page buttons use, which calls llm-call-chat.ts) to run ONE AI job at a time.
 * What keeps the spending bounded:
 *   - nothing runs without an agreement: the administrator agreed in a popup to the exact setup (projects, what is created, schedule,
 *     model, token limits, dollar limit); the agreement is a fingerprint of that setup, and when anything it covers changes the
 *     schedule PAUSES instead of running;
 *   - every run has a dollar limit: before each call the worst case of that call is added to what the run has already cost, and when
 *     the sum would pass the limit the run stops and lists the projects it did not reach;
 *   - only projects whose notes changed since their last article are touched (a fingerprint of every note is stored with the article);
 *   - one AI job at a time, the switch in the Admin stops everything, and a run that was missed by more than 12 hours is skipped;
 *   - when the provider cannot be reached at all the run waits a minute and sends the same call again, for at most 15 minutes, then stops
 *     (such a call never arrived, so it costs nothing; an answer that is merely bad is never retried).
 * The cost of a call is counted from the tokens the provider reports, times the price list in docgen.ts. Every run also keeps what it used
 * per model and per kind (TEXT = the articles, IMAGES = the AI flow charts) and how long the calls took.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MemoryNode } from '@mnemosyne/core';
import type { AuditInput } from './audit.js';
import type { DocMeta } from './docgen.js';
import { ProviderUnreachableError } from './provider-store.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const RUN_HISTORY = 30;
/** A run that is later than this when the server finally looks at it is skipped, not started in the middle of the working day. */
export const MAX_LATE_MS = 12 * 3600 * 1000;
/** A project whose call was cut off (service restarted) this many times is given up on. */
export const MAX_ATTEMPTS = 2;
/**
 * When the connection to the provider fails (its name does not resolve, the connection is refused or reset) the run waits this long and
 * sends the SAME call again, for at most OUTAGE_MAX_WAIT_MS in total, and then stops. A minute is deliberate: resolvers keep a failed
 * lookup for about that long, so retrying faster only reads the same cached failure. Such a call never reached the provider, so it costs nothing.
 */
export const OUTAGE_WAIT_MS = 60_000;
export const OUTAGE_MAX_WAIT_MS = 15 * 60_000;

export type AutoKind = 'wiki' | 'diagram';

export interface AutoSchedule {
  mode: 'weekly' | 'once';
  /** 0 = Sunday ... 6 = Saturday (weekly). */
  days: number[];
  /** YYYY-MM-DD, in `tz` (once). */
  date?: string;
  /** HH:MM, in `tz`. */
  time: string;
  /** IANA time zone, e.g. "UTC" or "Europe/Zurich". */
  tz: string;
}

export interface AutoConfig {
  /** The switch. Off: nothing runs and nothing is spent. */
  enabled: boolean;
  schedule: AutoSchedule;
  /** Notes projects that are kept up to date. */
  projects: string[];
  /** Every project that existed when this was saved: a project not in here is "new" and not included. */
  known: string[];
  /** TEXT: the documentation article. */
  text: boolean;
  /** AI flow charts: the architecture diagrams. */
  charts: boolean;
  /** A run stops when the next call could take it over this many US dollars. */
  limitUsd: number;
  /** Who agreed, when, and to which setup (a fingerprint). */
  agreement?: { by: string; at: string; key: string };
}

/** What one kind of AI call of one model used in one run (Admin -> Auto, Runs). `wiki` is TEXT, `diagram` is IMAGES (the AI flow charts). */
export interface AutoUsage {
  model: string;
  kind: AutoKind;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** How long the calls took. Waiting for the provider to come back is not in it. */
  ms: number;
}

export interface AutoRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  scheduledFor: string;
  trigger: string;
  status: 'running' | 'completed' | 'nothing' | 'limit' | 'missed' | 'stopped';
  updated: string[];
  unchanged: string[];
  failed: { project: string; error: string }[];
  notReached: string[];
  /** Still to do (first = current). */
  queue: { project: string; text: boolean; charts: boolean; attempts: number; wikiDone?: boolean; chartsDone?: boolean }[];
  total: number;
  current?: { project: string; kind: AutoKind; since: string; /** set while waiting for the provider to come back */ waiting?: string };
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** The same tokens and cost split by model and kind. Runs made before this was recorded get it from the audit log (`backfillUsage`). */
  usage?: AutoUsage[];
  note?: string;
  warnings: string[];
}

export interface AutoFile {
  config?: AutoConfig;
  /** ISO instant of the next run (null = nothing planned). */
  nextRunAt?: string | null;
  /** Why the schedule is not running although it is switched on. */
  pausedReason?: string | null;
  run?: AutoRun | null;
  runs: AutoRun[];
}

export class AutoValidationError extends Error {}

// ----------------------------------------------------------------------------
// Time: next run in a time zone (DST-safe, no libraries)
// ----------------------------------------------------------------------------
const formatters = new Map<string, Intl.DateTimeFormat>();

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.length > 0 && tz.length <= 64;
  } catch {
    return false;
  }
}

function zoned(ts: number, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ts))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { year: o.year!, month: o.month!, day: o.day!, hour: o.hour === 24 ? 0 : o.hour!, minute: o.minute!, second: o.second! };
}

/** How far the wall clock of `tz` is ahead of UTC at this instant. */
function offsetMs(ts: number, tz: string): number {
  const p = zoned(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

/** The instant at which the wall clock of `tz` shows this date and time. */
function zonedInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = offsetMs(guess, tz);
  const t = guess - off;
  const off2 = offsetMs(t, tz);
  return off2 === off ? t : guess - off2;
}

/** The first run strictly after `after`; null when a one-time schedule is over. */
export function nextRun(s: AutoSchedule, after: Date): Date | null {
  const [hh, mm] = s.time.split(':').map(Number) as [number, number];
  if (s.mode === 'once') {
    const [y, m, d] = (s.date ?? '').split('-').map(Number) as [number, number, number];
    const t = zonedInstant(y, m, d, hh, mm, s.tz);
    return t > after.getTime() ? new Date(t) : null;
  }
  const base = zoned(after.getTime(), s.tz);
  for (let i = 0; i < 9; i++) {
    const day = new Date(Date.UTC(base.year, base.month - 1, base.day + i));
    if (!s.days.includes(day.getUTCDay())) continue;
    const t = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, s.tz);
    if (t > after.getTime()) return new Date(t);
  }
  return null;
}

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export function describeSchedule(s: AutoSchedule): string {
  const at = `${s.time} ${s.tz}`;
  if (s.mode === 'once') return `once, on ${s.date} at ${at}`;
  // in the order of the week, Monday first ("Saturday and Sunday", not "Sunday and Saturday")
  return `every ${list([...s.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]!))} at ${at}`;
}

/** How many runs a month the schedule can make at most (for the monthly ceiling). */
export function runsPerMonth(s: AutoSchedule): number {
  return s.mode === 'once' ? 1 : Math.ceil((s.days.length * 52) / 12);
}

function triggerName(s: AutoSchedule, scheduledFor: Date): string {
  if (s.mode === 'once') return `One-time schedule ${s.date} ${s.time}`;
  const p = zoned(scheduledFor.getTime(), s.tz);
  return `${DAY_NAMES[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]} ${s.time} schedule`;
}

// ----------------------------------------------------------------------------
// Which projects changed: a fingerprint of every note is stored with the article
// ----------------------------------------------------------------------------
/** Fingerprint of everything the documentation is written from. */
export function noteHash(n: MemoryNode): string {
  return createHash('sha256').update(JSON.stringify([n.id, n.title, n.type, n.status, n.observed_at ?? null, [...n.components].sort(), n.body])).digest('hex').slice(0, 12);
}

export function noteHashes(notes: MemoryNode[]): Record<string, string> {
  return Object.fromEntries(notes.map((n) => [n.id, noteHash(n)]));
}

export interface ProjectState {
  project: string;
  notes: number;
  hasArticle: boolean;
  /** ISO time of the newest article. */
  lastArticle: string | null;
  /** The notes changed since the newest article (or there is none): the article should be rewritten. */
  textDue: boolean;
  /** The newest diagram is missing or was not made from the newest article. */
  chartsDue: boolean;
  /** Plain words for the list, e.g. "6 notes new or changed". */
  detail: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What a run would do for one project. Articles made with the fingerprints are compared note by note. An older article has none:
 * it counts as changed when a note is dated after it or the number of notes differs (a note's date has no time of day, so a change
 * on the very day of the article cannot be seen that way; the next article stores fingerprints).
 */
export function inspectProject(project: string, notes: MemoryNode[], wiki: DocMeta | null, diagram: DocMeta | null): ProjectState {
  const base = { project, notes: notes.length, hasArticle: Boolean(wiki), lastArticle: wiki?.generatedAt ?? null };
  if (!wiki) return { ...base, textDue: true, chartsDue: true, detail: 'no article yet' };
  let changed = 0;
  let how = '';
  if (wiki.noteHashes) {
    const now = noteHashes(notes);
    changed = Object.keys(now).filter((id) => wiki.noteHashes![id] !== now[id]).length + Object.keys(wiki.noteHashes).filter((id) => !(id in now)).length;
    how = plural(changed, 'note new or changed', 'notes new or changed');
  } else {
    const day = wiki.generatedAt.slice(0, 10);
    const newer = notes.filter((n) => n.observed_at && n.observed_at.slice(0, 10) > day).length;
    changed = newer || (wiki.noteCount !== undefined && wiki.noteCount !== notes.length ? 1 : 0);
    how = newer ? plural(newer, 'note newer than the article', 'notes newer than the article') : 'the number of notes differs';
  }
  if (changed) return { ...base, textDue: true, chartsDue: true, detail: how };
  const stale = !diagram || diagram.basedOn !== wiki.id;
  return { ...base, textDue: false, chartsDue: stale, detail: stale ? (diagram ? 'charts older than the article' : 'no charts yet') : 'up to date' };
}

/** What one run would do for a project with these ticks. */
export function wouldRun(s: ProjectState, cfg: Pick<AutoConfig, 'text' | 'charts'>): { text: boolean; charts: boolean } {
  const text = cfg.text && s.textDue;
  const charts = cfg.charts && (s.chartsDue || text) && (s.hasArticle || text);
  return { text, charts };
}

// ----------------------------------------------------------------------------
// The setup an administrator submits, and the fingerprint the agreement is bound to
// ----------------------------------------------------------------------------
export function parseAutoInput(input: unknown, known: string[], now: Date): Pick<AutoConfig, 'schedule' | 'projects' | 'known' | 'text' | 'charts' | 'limitUsd'> {
  const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const s = (b.schedule && typeof b.schedule === 'object' ? b.schedule : {}) as Record<string, unknown>;
  const mode = s.mode === 'once' ? 'once' : 'weekly';
  const time = typeof s.time === 'string' ? s.time.trim() : '';
  const hm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!hm) throw new AutoValidationError('The start time must be on the 24-hour clock and look like 02:00 or 23:30.');
  const tz = typeof s.tz === 'string' ? s.tz.trim() : '';
  if (!validTimeZone(tz)) throw new AutoValidationError('Choose a time zone from the list.');
  const schedule: AutoSchedule = { mode, days: [], time, tz };
  if (mode === 'weekly') {
    const days = Array.isArray(s.days) ? s.days : [];
    schedule.days = [...new Set(days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((x, y) => x - y);
    if (!schedule.days.length) throw new AutoValidationError('Pick at least one weekday.');
  } else {
    const date = typeof s.date === 'string' ? s.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new AutoValidationError('Choose the date of the one-time run.');
    schedule.date = date;
    if (!nextRun(schedule, now)) throw new AutoValidationError('That date and time is already in the past.');
  }
  const wanted = Array.isArray(b.projects) ? b.projects.filter((p): p is string => typeof p === 'string') : [];
  const all = new Set(known);
  const projects = [...new Set(wanted)].filter((p) => all.has(p)).sort();
  if (!projects.length) throw new AutoValidationError('Tick at least one project.');
  const text = b.text === true;
  const charts = b.charts === true;
  if (!text && !charts) throw new AutoValidationError('Tick TEXT, AI flow charts, or both.');
  const limitRaw = typeof b.limitUsd === 'number' ? b.limitUsd : Number(String(b.limitUsd ?? '').replace(',', '.'));
  if (!Number.isFinite(limitRaw) || limitRaw <= 0 || limitRaw > 100_000) throw new AutoValidationError('The spending limit must be a positive amount in US dollars.');
  return { schedule, projects, known: [...known].sort(), text, charts, limitUsd: Math.round(limitRaw * 100) / 100 };
}

/** Everything the agreement covers. `modelKey` stands for the model and the token limits and prompts of the jobs. */
export function agreementKey(cfg: Pick<AutoConfig, 'schedule' | 'projects' | 'text' | 'charts' | 'limitUsd'>, modelKey: string): string {
  const { mode, days, date, time, tz } = cfg.schedule;
  return createHash('sha256')
    .update(JSON.stringify({ p: [...cfg.projects].sort(), t: cfg.text, c: cfg.charts, l: cfg.limitUsd, s: { mode, days, date: date ?? null, time, tz }, m: modelKey }))
    .digest('hex');
}

// ----------------------------------------------------------------------------
// Cost summary shown live and in the agreement popup
// ----------------------------------------------------------------------------
export interface ProjectEstimate {
  textTypical: number | null;
  textWorst: number | null;
  chartsTypical: number | null;
  chartsWorst: number | null;
}

const usd = (n: number) => `$${n < 0.01 ? '<0.01' : n.toFixed(2)}`;
const sum = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0));

export interface AutoSummary {
  /** Rows for the Auto tab, step 4. */
  live: [string, string][];
  /** Rows for the agreement popup. */
  agree: [string, string][];
  /** Worst case of one run, US dollars. */
  worstRun: number | null;
}

export function summarize(
  cfg: Pick<AutoConfig, 'schedule' | 'projects' | 'text' | 'charts' | 'limitUsd'>,
  rows: { state: ProjectState; est: ProjectEstimate }[],
  modelLabel: string,
): AutoSummary {
  const n = rows.length;
  const typicalOne = rows.map((r) => sum([cfg.text ? r.est.textTypical : 0, cfg.charts ? r.est.chartsTypical : 0]));
  const worstOne = rows.map((r) => sum([cfg.text ? r.est.textWorst : 0, cfg.charts ? r.est.chartsWorst : 0]));
  const now = rows.map((r) => {
    const w = wouldRun(r.state, cfg);
    return { w, usd: sum([w.text ? r.est.textTypical : 0, w.charts ? r.est.chartsTypical : 0]) };
  });
  const changed = now.filter((x) => x.w.text || x.w.charts).length;
  const typicalNow = sum(now.map((x) => x.usd));
  const worstRun = sum(worstOne);
  const avgTypical = sum(typicalOne) === null ? null : sum(typicalOne)! / Math.max(1, n);
  const maxWorst = worstOne.some((x) => x === null) ? null : Math.max(0, ...(worstOne as number[]));
  const avg = (pick: (e: ProjectEstimate) => number | null) => {
    const v = sum(rows.map((r) => pick(r.est)));
    return v === null ? null : v / Math.max(1, n);
  };
  const parts: string[] = [];
  const t = avg((e) => e.textTypical);
  const c = avg((e) => e.chartsTypical);
  if (cfg.text) parts.push(`text ${t === null ? '?' : usd(t)}`);
  if (cfg.charts) parts.push(`charts ${c === null ? '?' : usd(c)}`);
  const runs = runsPerMonth(cfg.schedule);
  const ceiling = cfg.limitUsd * runs;
  const creates = [cfg.text ? 'TEXT' : '', cfg.charts ? 'AI flow charts' : ''].filter(Boolean).join(' and ');
  const names = cfg.projects.length > 12 ? `${cfg.projects.slice(0, 12).join(', ')} and ${cfg.projects.length - 12} more` : cfg.projects.join(', ');
  return {
    worstRun,
    live: [
      ['Model for TEXT and charts', modelLabel],
      ['One project, typical', avgTypical === null ? 'unknown (no list price for this model)' : `about ${usd(avgTypical)} (${parts.join(' + ')})`],
      ['One project, worst case', maxWorst === null ? 'unknown' : `at most ${usd(maxWorst)} (every token limit fully used)`],
      ['This run if started now', typicalNow === null ? 'unknown' : `about ${usd(typicalNow)} for the ${n} selected projects, ${changed} of them with changes`],
      ['Worst case of one run', worstRun === null ? 'unknown' : `at most ${usd(worstRun)} (all ${n} selected projects change)`],
    ],
    agree: [
      ['Schedule', describeSchedule(cfg.schedule)],
      ['Provider / model', modelLabel],
      ['Projects', `${n} selected (${names})`],
      ['Creates', `${creates}, only for projects whose notes changed`],
      ['Estimated cost of one run', typicalNow === null || worstRun === null ? 'unknown' : `about ${usd(typicalNow)} now, at most ${usd(worstRun)}`],
      ['Your spending limit', `a run stops at ${usd(cfg.limitUsd)} → at most ${usd(ceiling)} a month (${runs} ${runs === 1 ? 'run' : 'runs'})`],
    ],
  };
}

// ----------------------------------------------------------------------------
// Store: one JSON file next to the other portal state (no secrets in it)
// ----------------------------------------------------------------------------
export class AutoStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async get(): Promise<AutoFile> {
    try {
      const f = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AutoFile>;
      return { ...f, runs: f.runs ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [] };
      throw err;
    }
  }

  /** Serialised read-modify-write, written atomically. */
  update(fn: (s: AutoFile) => void): Promise<AutoFile> {
    const run = this.queue.then(async () => {
      const s = await this.get();
      fn(s);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
      return s;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// ----------------------------------------------------------------------------
// The runner
// ----------------------------------------------------------------------------
export interface GenOutcome {
  /** The model that answered (its id, e.g. "muse-spark-1.3-contributor"). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cost counted from the reported tokens; null when the model has no list price. */
  usd: number | null;
  warning?: string;
}

export interface RunnerDeps {
  store: AutoStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The agreement fingerprint of this setup under the current model and limits; null when no model is chosen or it has no price. */
  keyFor(cfg: AutoConfig): Promise<string | null>;
  /** Every project that has notes. */
  projects(): Promise<string[]>;
  inspect(project: string): Promise<ProjectState>;
  /** The worst case in US dollars of the next call of this kind for this project; null when unknown. */
  worst(project: string, kind: AutoKind): Promise<number | null>;
  /** Runs ONE AI job and returns what it used. Throws an Error with a plain message when it fails; a ProviderUnreachableError when the connection itself failed (the run waits and sends it again). */
  generate(project: string, kind: AutoKind, by: string): Promise<GenOutcome>;
  /** A job started by a person is running. */
  busy(): boolean;
  log(e: AuditInput): void;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Adds one call to the per-model, per-kind list of a run. */
export function addUsage(list: AutoUsage[], e: AutoUsage): void {
  const row = list.find((u) => u.model === e.model && u.kind === e.kind);
  if (!row) {
    list.push({ ...e, usd: round(e.usd) });
    return;
  }
  row.calls += e.calls;
  row.inputTokens += e.inputTokens;
  row.outputTokens += e.outputTokens;
  row.usd = round(row.usd + e.usd);
  row.ms += e.ms;
}

/** "67 min 19 s", "2 h 17 min", "42 s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const usd4 = (n: number) => `$${n.toFixed(4)}`;

/** The TEXT / IMAGES split of a run in words, for the audit trail. */
function usageWords(u: AutoUsage[] | undefined): string {
  if (!u?.length) return '';
  const parts = (['wiki', 'diagram'] as const)
    .map((k) => ({ k, rows: u.filter((x) => x.kind === k) }))
    .filter((x) => x.rows.length)
    .map(({ k, rows }) => `${k === 'wiki' ? 'TEXT' : 'IMAGES'} ${usd4(rows.reduce((a, x) => a + x.usd, 0))} in ${rows.reduce((a, x) => a + x.calls, 0)} calls (${[...new Set(rows.map((x) => x.model))].join(', ')})`);
  return ` (${parts.join('; ')})`;
}

// ----------------------------------------------------------------------------
// Runs made before the split was recorded: rebuilt from the audit trail, which has one `auto_start` and one `ai_done` per successful call
// ----------------------------------------------------------------------------
export interface AuditLike {
  time: string;
  event: string;
  entityType: string;
  entityName: string;
  user: string;
  description: string;
}

const TOKENS = /(\d+) tokens in, (\d+) out/;

/**
 * The split of a finished run, or null when the audit trail cannot give it. It is only given when the calls found add up to exactly the
 * tokens the run recorded (so a trail that was rotated away or cut can never produce a wrong picture) and every model has a price.
 */
export function usageFromAudit(
  events: AuditLike[],
  run: Pick<AutoRun, 'startedAt' | 'finishedAt' | 'inputTokens' | 'outputTokens'>,
  priceOf: (model: string, inputTokens: number, outputTokens: number) => number | null,
): AutoUsage[] | null {
  if (!run.finishedAt) return null;
  const from = Date.parse(run.startedAt);
  const to = Date.parse(run.finishedAt) + 1000;
  const calls = events.filter((e) => e.user === 'auto' && (e.entityType === 'docs_wiki' || e.entityType === 'docs_diagram')).sort((a, b) => a.time.localeCompare(b.time));
  const startedAt = new Map<string, number>();
  const usage: AutoUsage[] = [];
  let inTok = 0;
  let outTok = 0;
  for (const e of calls) {
    const t = Date.parse(e.time);
    if (t < from || t > to) continue;
    const key = `${e.entityType}:${e.entityName}`;
    if (e.event === 'auto_start') startedAt.set(key, t);
    if (e.event !== 'ai_done') continue;
    const tok = TOKENS.exec(e.description);
    if (!tok) return null;
    const kind: AutoKind = e.entityType === 'docs_wiki' ? 'wiki' : 'diagram';
    // "Article written by Meta Model API / muse-spark-1.3 from 3 notes (...)" or "...diagrams drawn by Mnemosyne from a plan written by muse-spark-1.3 (...)"
    const named = kind === 'wiki' ? /written by (.+?) from \d+ notes/.exec(e.description)?.[1]?.split(' / ').pop() : /plan written by (\S+) \(/.exec(e.description)?.[1];
    if (!named) return null;
    const cost = priceOf(named, Number(tok[1]), Number(tok[2]));
    if (cost === null) return null;
    addUsage(usage, { model: named, kind, calls: 1, inputTokens: Number(tok[1]), outputTokens: Number(tok[2]), usd: cost, ms: Math.max(0, t - (startedAt.get(key) ?? t)) });
    startedAt.delete(key);
    inTok += Number(tok[1]);
    outTok += Number(tok[2]);
  }
  return inTok === run.inputTokens && outTok === run.outputTokens ? usage : null;
}

/** Gives every finished run that has no split the one the audit trail can prove. Returns how many runs were filled in. Never replaces a split. */
export async function backfillUsage(
  store: AutoStore,
  loadEvents: (sinceIso: string) => Promise<AuditLike[]>,
  priceOf: (model: string, inputTokens: number, outputTokens: number) => number | null,
): Promise<number> {
  const todo = (await store.get()).runs.filter((r) => !r.usage && r.finishedAt);
  if (!todo.length) return 0;
  const events = await loadEvents(todo.map((r) => r.startedAt).sort()[0]!);
  const found = new Map<string, AutoUsage[]>();
  for (const r of todo) {
    const u = usageFromAudit(events, r, priceOf);
    if (u) found.set(r.id, u);
  }
  if (!found.size) return 0;
  await store.update((s) => {
    for (const r of s.runs) if (!r.usage && found.has(r.id)) r.usage = found.get(r.id);
  });
  return found.size;
}

export class AutoRunner {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private executing = false;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: RunnerDeps) {
    this.now = d.now ?? (() => new Date());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** An automatic run is going: a person's AI button is refused meanwhile. */
  get active(): boolean {
    return this.executing;
  }

  start(everyMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async agreementOk(cfg: AutoConfig): Promise<boolean> {
    return Boolean(cfg.agreement) && (await this.d.keyFor(cfg)) === cfg.agreement!.key;
  }

  /** One look at the clock. Never throws: a problem here must not take the portal down. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } catch (err) {
      console.error('auto: tick failed:', (err as Error).message);
    } finally {
      this.ticking = false;
    }
  }

  private async setPaused(reason: string | null): Promise<void> {
    const st = await this.d.store.get();
    if ((st.pausedReason ?? null) !== reason) await this.d.store.update((s) => void (s.pausedReason = reason));
  }

  private async step(): Promise<void> {
    const st = await this.d.store.get();
    const cfg = st.config;
    if (!cfg) return;
    if (st.run?.status === 'running') {
      // a run that was cut off by a restart goes on with the projects it had not done
      if (cfg.enabled && (await this.agreementOk(cfg))) {
        this.executing = true;
        await this.execute(st.run.id);
      } else await this.finish(st.run.id, 'stopped', cfg.enabled ? 'The agreement no longer matches the setup' : 'Switched off during the run');
      return;
    }
    if (!cfg.enabled) return;
    if (!(await this.agreementOk(cfg))) {
      await this.setPaused('The agreement no longer matches: the model, its token limits or the setup changed. Open Auto and agree again.');
      return;
    }
    await this.setPaused(null);
    if (!st.nextRunAt) return;
    const due = Date.parse(st.nextRunAt);
    const now = this.now();
    if (due > now.getTime()) return;
    if (this.d.busy()) return; // a person's job is running: look again in 30 seconds

    const next = nextRun(cfg.schedule, new Date(Math.max(now.getTime(), due)))?.toISOString() ?? null;
    const late = now.getTime() - due;
    const base = { id: stamp(now), scheduledFor: st.nextRunAt, trigger: triggerName(cfg.schedule, new Date(due)), updated: [], unchanged: [], failed: [], notReached: [], queue: [], total: 0, inputTokens: 0, outputTokens: 0, usd: 0, usage: [], warnings: [] };
    if (late > MAX_LATE_MS) {
      const hours = Math.round(late / 3600_000);
      await this.d.store.update((s) => {
        s.nextRunAt = next;
        s.runs = [{ ...base, startedAt: now.toISOString(), finishedAt: now.toISOString(), status: 'missed' as const, note: `The server was not running at the planned time; this was ${hours} hours late (the limit is 12), so the run was skipped.` }, ...s.runs].slice(0, RUN_HISTORY);
      });
      this.d.log({ event: 'auto_run', entityType: 'auto', entityName: 'Automatic update', user: 'auto', description: `Run skipped: ${hours} hours late (the server was not running at the planned time)` });
      return;
    }

    // From here on a person's AI button is refused, until the run is over.
    this.executing = true;
    let run: AutoRun;
    try {
      // decide which projects need work (reads only, no AI)
      const existing = new Set(await this.d.projects());
      const queue: AutoRun['queue'] = [];
      const unchanged: string[] = [];
      for (const project of cfg.projects.filter((p) => existing.has(p))) {
        const w = wouldRun(await this.d.inspect(project), cfg);
        if (w.text || w.charts) queue.push({ project, text: w.text, charts: w.charts, attempts: 0 });
        else unchanged.push(project);
      }
      run = { ...base, startedAt: now.toISOString(), status: 'running', unchanged, queue, total: queue.length };
      await this.d.store.update((s) => {
        s.run = run;
        s.nextRunAt = next;
      });
      this.d.log({ event: 'auto_run', entityType: 'auto', entityName: 'Automatic update', user: 'auto', description: `Run started (${run.trigger}): ${queue.length} projects to update, ${unchanged.length} unchanged, spending limit ${usd(cfg.limitUsd)}, agreed by ${cfg.agreement!.by}` });
    } catch (err) {
      this.executing = false;
      throw err;
    }
    await this.execute(run.id);
  }

  private async mutate(id: string, fn: (r: AutoRun) => void): Promise<void> {
    await this.d.store.update((s) => {
      if (s.run && s.run.id === id) fn(s.run);
    });
  }

  private async finish(id: string, status: AutoRun['status'], note?: string): Promise<void> {
    let done: AutoRun | undefined;
    await this.d.store.update((s) => {
      const r = s.run;
      if (!r || r.id !== id) return;
      const left = r.queue.map((q) => q.project);
      done = { ...r, status, finishedAt: this.now().toISOString(), notReached: [...r.notReached, ...left], queue: [], current: undefined, note: note ?? r.note, usd: round(r.usd) };
      s.runs = [done, ...s.runs].slice(0, RUN_HISTORY);
      s.run = null;
    });
    if (done) {
      const r = done;
      this.d.log({
        event: 'auto_run',
        entityType: 'auto',
        entityName: 'Automatic update',
        user: 'auto',
        description: `Run ${status}: ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.failed.length} failed, ${r.notReached.length} not reached; ${r.inputTokens} tokens in, ${r.outputTokens} out; cost ${usd4(r.usd)}${usageWords(r.usage)}; ran ${formatDuration(Date.parse(r.finishedAt!) - Date.parse(r.startedAt))}${note ? `; ${note}` : ''}`,
      });
    }
  }

  /** Why the run must stop now, or null. */
  private async stopReason(): Promise<string | null> {
    const cfg = (await this.d.store.get()).config;
    if (!cfg || !cfg.enabled) return 'Switched off during the run';
    if (!(await this.agreementOk(cfg))) return 'The agreement no longer matches the setup';
    return null;
  }

  /** Waits (at most half an hour) while a person's job is running; it is never started on top of it. */
  private async waitIdle(): Promise<boolean> {
    for (let i = 0; i < 360 && this.d.busy(); i++) await this.sleep(5000);
    return !this.d.busy();
  }

  /** One minute of waiting for the provider, in 5-second steps so the switch is noticed quickly. Returns why the run must stop, or null. */
  private async waitOutage(): Promise<string | null> {
    for (let i = 0; i < OUTAGE_WAIT_MS / 5000; i++) {
      await this.sleep(5000);
      const stop = await this.stopReason();
      if (stop) return stop;
    }
    return null;
  }

  /** The caller has set `executing`; it is cleared when the run is over, however it ends. */
  private async execute(id: string): Promise<void> {
    try {
      for (;;) {
        const st = await this.d.store.get();
        const run = st.run;
        if (!run || run.id !== id || run.status !== 'running') return;
        const cfg = st.config;
        if (!cfg || !cfg.enabled) return await this.finish(id, 'stopped', 'Switched off during the run');
        if (!(await this.agreementOk(cfg))) return await this.finish(id, 'stopped', 'The agreement no longer matches the setup');
        const item = run.queue[0];
        if (!item) return await this.finish(id, run.updated.length || run.failed.length ? 'completed' : 'nothing');

        if (item.attempts >= MAX_ATTEMPTS) {
          await this.mutate(id, (r) => {
            r.failed.push({ project: item.project, error: 'The service was restarted during this project twice; it was skipped.' });
            r.queue.shift();
          });
          continue;
        }
        await this.mutate(id, (r) => void r.queue[0]!.attempts++);

        let failure: string | null = null;
        let did = 0;
        /** Ends the run in the middle of a project: what was saved of it counts as updated, the rest is listed as not reached. */
        const stopHere = async (status: AutoRun['status'], note: string) => {
          await this.mutate(id, (r) => {
            r.current = undefined;
            if (did || item.wikiDone || item.chartsDone) {
              r.queue.shift();
              r.updated.push(item.project);
            }
          });
          return this.finish(id, status, note);
        };
        for (const kind of ['wiki', 'diagram'] as const) {
          if (kind === 'wiki' ? !item.text || item.wikiDone : !item.charts || item.chartsDone) continue;
          // the switch and the agreement are looked at again before EVERY call, not only between projects
          const stop = await this.stopReason();
          if (stop) return await stopHere('stopped', stop);
          if (!(await this.waitIdle())) {
            failure = 'A job started by a person kept the AI busy for half an hour.';
            break;
          }
          const worst = await this.d.worst(item.project, kind);
          const spent = (await this.d.store.get()).run?.usd ?? 0;
          if (worst === null) {
            failure = 'The cost of this call cannot be limited: the model has no list price.';
            break;
          }
          if (spent + worst > cfg.limitUsd) return await stopHere('limit', `Stopped before ${item.project}: its next call could cost up to ${usd(worst)} and the run had used ${usd(spent)} of the ${usd(cfg.limitUsd)} limit.`);
          await this.mutate(id, (r) => void (r.current = { project: item.project, kind, since: this.now().toISOString() }));
          this.d.log({ event: 'auto_start', entityType: `docs_${kind}`, entityName: item.project, user: 'auto', description: `Automatic update (agreed by ${cfg.agreement!.by}): ${kind === 'wiki' ? 'article' : 'diagrams'} for ${item.project}; at most ${usd(worst)}; run so far ${usd(spent)} of ${usd(cfg.limitUsd)}` });
          let waited = 0;
          for (;;) {
            try {
              const began = this.now().getTime();
              const out = await this.d.generate(item.project, kind, cfg.agreement!.by);
              const took = Math.max(0, this.now().getTime() - began);
              did++;
              await this.mutate(id, (r) => {
                const cost = out.usd ?? worst;
                r.inputTokens += out.inputTokens;
                r.outputTokens += out.outputTokens;
                r.usd = round(r.usd + cost);
                addUsage((r.usage ??= []), { model: out.model, kind, calls: 1, inputTokens: out.inputTokens, outputTokens: out.outputTokens, usd: cost, ms: took });
                if (out.warning) r.warnings.push(`${item.project}: ${out.warning}`);
                if (r.current) r.current.waiting = undefined;
                if (kind === 'wiki') r.queue[0]!.wikiDone = true;
                else r.queue[0]!.chartsDone = true;
              });
              if (waited) this.d.log({ event: 'auto_run', entityType: 'auto', entityName: 'Automatic update', user: 'auto', description: `The provider is reachable again after ${Math.round(waited / 60_000)} minute(s); the run goes on` });
              break;
            } catch (err) {
              if (!(err instanceof ProviderUnreachableError)) {
                failure = `${kind === 'wiki' ? 'article' : 'diagrams'}: ${(err as Error).message}`;
                break;
              }
              // The connection itself failed, so nothing reached the provider and nothing was billed: wait and send the same call again.
              const why = err.message.replace(/\.$/, '');
              if (waited >= OUTAGE_MAX_WAIT_MS) {
                return await stopHere('stopped', `${why} for ${OUTAGE_MAX_WAIT_MS / 60_000} minutes, so the run was stopped. Nothing was lost: what was not done is listed as not reached and is still due at the next run.`);
              }
              if (!waited) this.d.log({ event: 'auto_run', entityType: 'auto', entityName: 'Automatic update', user: 'auto', description: `${why} while working on ${item.project}; the run waits one minute and tries again, for at most ${OUTAGE_MAX_WAIT_MS / 60_000} minutes` });
              waited += OUTAGE_WAIT_MS;
              await this.mutate(id, (r) => {
                if (r.current) r.current.waiting = `${why}: waiting one minute (retry ${waited / OUTAGE_WAIT_MS} of ${OUTAGE_MAX_WAIT_MS / OUTAGE_WAIT_MS})`;
              });
              const stopNow = await this.waitOutage();
              if (stopNow) return await stopHere('stopped', stopNow);
            }
          }
          if (failure) break;
        }
        await this.mutate(id, (r) => {
          r.current = undefined;
          r.queue.shift();
          if (failure) r.failed.push({ project: item.project, error: did ? `${failure} (the earlier step was saved)` : failure });
          else r.updated.push(item.project);
        });
      }
    } finally {
      this.executing = false;
    }
  }
}

/** Compact UTC timestamp, like the document store's version ids. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
