import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryNode } from '@mnemosyne/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AutoRunner,
  AutoStore,
  AutoValidationError,
  agreementKey,
  describeSchedule,
  inspectProject,
  nextRun,
  noteHashes,
  parseAutoInput,
  runsPerMonth,
  summarize,
  wouldRun,
  type AutoConfig,
  type AutoSchedule,
  type ProjectState,
} from '../src/auto.js';
import type { DocMeta } from '../src/docgen.js';

const note = (id: string, body = 'text', observed = '2026-10-20') =>
  ({ id, title: id, type: 'howto', status: 'working', project: 'p', components: [], links: [], code_refs: [], authors: [], observed_at: observed, body }) as unknown as MemoryNode;
const wiki = (notes: MemoryNode[], extra: Partial<DocMeta> = {}) =>
  ({ kind: 'wiki', id: '20261029T170000Z', generatedAt: '2026-10-29T17:00:00.000Z', project: 'p', model: 'm', by: 'x', noteCount: notes.length, noteHashes: noteHashes(notes), ext: 'md', ...extra }) as DocMeta;
const diagram = (basedOn: string) => ({ kind: 'diagram', id: '20261029T180000Z', generatedAt: '2026-10-29T18:00:00.000Z', project: 'p', model: 'm', by: 'x', basedOn, ext: 'svg' }) as DocMeta;

const weekly = (days: number[], time = '02:00', tz = 'UTC'): AutoSchedule => ({ mode: 'weekly', days, time, tz });

describe('the next run of a schedule', () => {
  it('finds the next Saturday or Sunday at the chosen time', () => {
    const s = weekly([6, 0]);
    // 2026-10-31 is a Saturday
    expect(nextRun(s, new Date('2026-10-31T12:00:00Z'))?.toISOString()).toBe('2026-11-01T02:00:00.000Z'); // Sunday 02:00
    expect(nextRun(s, new Date('2026-11-01T02:00:00Z'))?.toISOString()).toBe('2026-11-07T02:00:00.000Z'); // strictly after: the next Saturday
    expect(nextRun(s, new Date('2026-10-31T01:59:00Z'))?.toISOString()).toBe('2026-10-31T02:00:00.000Z'); // still today
    expect(nextRun(weekly([3]), new Date('2026-10-31T12:00:00Z'))?.toISOString()).toBe('2026-11-04T02:00:00.000Z'); // a Wednesday
  });

  it('counts in the schedule’s own time zone, across the change of the clocks', () => {
    // Zurich: summer time (UTC+2) until Sunday 25 October 2026, winter time (UTC+1) after
    const s = weekly([0], '03:30', 'Europe/Zurich');
    expect(nextRun(s, new Date('2026-10-12T00:00:00Z'))?.toISOString()).toBe('2026-10-18T01:30:00.000Z');
    expect(nextRun(s, new Date('2026-10-19T00:00:00Z'))?.toISOString()).toBe('2026-10-25T02:30:00.000Z');
    // Sunday 01:00 in Singapore (UTC+8) is still Saturday in UTC
    expect(nextRun(weekly([0], '01:00', 'Asia/Singapore'), new Date('2026-10-31T10:00:00Z'))?.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(nextRun(weekly([0], '01:00', 'Asia/Singapore'), new Date('2026-10-31T20:00:00Z'))?.toISOString()).toBe('2026-11-07T17:00:00.000Z'); // that Sunday has begun already: the next one
  });

  it('a one-time schedule runs once and is then over', () => {
    const once: AutoSchedule = { mode: 'once', days: [], date: '2026-11-07', time: '04:15', tz: 'UTC' };
    expect(nextRun(once, new Date('2026-10-31T00:00:00Z'))?.toISOString()).toBe('2026-11-07T04:15:00.000Z');
    expect(nextRun(once, new Date('2026-11-07T04:15:00Z'))).toBeNull();
  });

  it('describes a schedule in words and counts the runs a month', () => {
    expect(describeSchedule(weekly([6, 0]))).toBe('every Saturday and Sunday at 02:00 UTC');
    expect(describeSchedule(weekly([1, 3, 5], '22:30', 'Europe/Zurich'))).toBe('every Monday, Wednesday and Friday at 22:30 Europe/Zurich');
    expect(describeSchedule({ mode: 'once', days: [], date: '2026-11-07', time: '04:15', tz: 'UTC' })).toBe('once, on 2026-11-07 at 04:15 UTC');
    expect(runsPerMonth(weekly([6, 0]))).toBe(9);
    expect(runsPerMonth(weekly([0]))).toBe(5);
    expect(runsPerMonth({ mode: 'once', days: [], date: '2026-11-07', time: '04:15', tz: 'UTC' })).toBe(1);
  });
});

describe('which projects changed', () => {
  const notes = [note('a'), note('b'), note('c')];

  it('a project with no article is due, and so are its charts', () => {
    expect(inspectProject('p', notes, null, null)).toMatchObject({ hasArticle: false, textDue: true, chartsDue: true, detail: 'no article yet', notes: 3 });
  });

  it('compares the article note by note: an unchanged project is left alone', () => {
    const w = wiki(notes);
    expect(inspectProject('p', notes, w, diagram(w.id))).toMatchObject({ textDue: false, chartsDue: false, detail: 'up to date' });
    expect(inspectProject('p', notes, w, diagram('older'))).toMatchObject({ textDue: false, chartsDue: true, detail: 'charts older than the article' });
    expect(inspectProject('p', notes, w, null)).toMatchObject({ textDue: false, chartsDue: true, detail: 'no charts yet' });
  });

  it('sees a changed, a new and a removed note, even on the very day of the article', () => {
    const w = wiki(notes);
    const edited = [note('a', 'text changed the same day'), note('b'), note('c')];
    expect(inspectProject('p', edited, w, diagram(w.id))).toMatchObject({ textDue: true, chartsDue: true, detail: '1 note new or changed' });
    expect(inspectProject('p', [...notes, note('d')], w, null).detail).toBe('1 note new or changed');
    expect(inspectProject('p', [note('a'), note('b'), note('x')], w, null).detail).toBe('2 notes new or changed'); // c removed, x new
  });

  it('an article made before the fingerprints existed counts as changed by dates and note count', () => {
    const old = wiki(notes, { noteHashes: undefined });
    expect(inspectProject('p', notes, old, diagram(old.id))).toMatchObject({ textDue: false, detail: 'up to date' });
    expect(inspectProject('p', [note('a'), note('b', 'x', '2026-10-30'), note('c')], old, null)).toMatchObject({ textDue: true, detail: '1 note newer than the article' });
    expect(inspectProject('p', [note('a'), note('b', 'x', '2026-10-29'), note('c')], old, null).textDue).toBe(false); // the date has no time of day: same day is not "newer"
    expect(inspectProject('p', [...notes, note('d')], old, null)).toMatchObject({ textDue: true, detail: 'the number of notes differs' });
  });

  it('what a run does depends on what is ticked', () => {
    const base = { project: 'p', notes: 3, lastArticle: null };
    const changed: ProjectState = { ...base, hasArticle: true, textDue: true, chartsDue: true, detail: '' };
    const chartsOnly: ProjectState = { ...base, hasArticle: true, textDue: false, chartsDue: true, detail: '' };
    const fresh: ProjectState = { ...base, hasArticle: false, textDue: true, chartsDue: true, detail: '' };
    const ok: ProjectState = { ...base, hasArticle: true, textDue: false, chartsDue: false, detail: '' };
    expect(wouldRun(changed, { text: true, charts: true })).toEqual({ text: true, charts: true });
    expect(wouldRun(changed, { text: true, charts: false })).toEqual({ text: true, charts: false });
    expect(wouldRun(changed, { text: false, charts: true })).toEqual({ text: false, charts: true });
    expect(wouldRun(chartsOnly, { text: true, charts: true })).toEqual({ text: false, charts: true });
    expect(wouldRun(chartsOnly, { text: true, charts: false })).toEqual({ text: false, charts: false });
    expect(wouldRun(ok, { text: true, charts: true })).toEqual({ text: false, charts: false });
    expect(wouldRun(fresh, { text: true, charts: true })).toEqual({ text: true, charts: true });
    expect(wouldRun(fresh, { text: false, charts: true })).toEqual({ text: false, charts: false }); // no article to draw from
  });
});

describe('the setup an administrator submits', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const known = ['alpha', 'beta', 'gamma'];
  const good = { schedule: { mode: 'weekly', days: [6, 0], time: '02:00', tz: 'UTC' }, projects: ['beta', 'alpha'], text: true, charts: true, limitUsd: '10,5' };

  it('accepts a good setup and normalises it', () => {
    const c = parseAutoInput(good, known, now);
    expect(c.projects).toEqual(['alpha', 'beta']);
    expect(c.schedule.days).toEqual([0, 6]);
    expect(c.limitUsd).toBe(10.5);
    expect(c.known).toEqual(known);
  });

  it('refuses what cannot run, with a plain message', () => {
    const bad = (patch: object, re: RegExp) => expect(() => parseAutoInput({ ...good, ...patch }, known, now)).toThrow(re);
    bad({ projects: [] }, /at least one project/);
    bad({ projects: ['not-a-project'] }, /at least one project/);
    bad({ text: false, charts: false }, /TEXT, AI flow charts, or both/);
    bad({ limitUsd: 0 }, /positive amount/);
    bad({ limitUsd: 'lots' }, /positive amount/);
    bad({ limitUsd: 1_000_000 }, /positive amount/);
    bad({ schedule: { ...good.schedule, days: [] } }, /at least one weekday/);
    bad({ schedule: { ...good.schedule, time: '25:00' } }, /start time/);
    bad({ schedule: { ...good.schedule, tz: 'Mars/Olympus' } }, /time zone/);
    bad({ schedule: { mode: 'once', time: '02:00', tz: 'UTC', date: '2026-10-01' } }, /in the past/);
    bad({ schedule: { mode: 'once', time: '02:00', tz: 'UTC', date: 'tomorrow' } }, /date/);
    expect(() => parseAutoInput(null, known, now)).toThrow(AutoValidationError);
  });

  it('the agreement covers every part of the setup and the model with its limits', () => {
    const c = parseAutoInput(good, known, now);
    const k = agreementKey(c, 'model-1');
    expect(agreementKey({ ...c }, 'model-1')).toBe(k);
    expect(agreementKey({ ...c, projects: ['alpha'] }, 'model-1')).not.toBe(k);
    expect(agreementKey({ ...c, text: false }, 'model-1')).not.toBe(k);
    expect(agreementKey({ ...c, charts: false }, 'model-1')).not.toBe(k);
    expect(agreementKey({ ...c, limitUsd: 11 }, 'model-1')).not.toBe(k);
    expect(agreementKey({ ...c, schedule: { ...c.schedule, time: '03:00' } }, 'model-1')).not.toBe(k);
    expect(agreementKey({ ...c, schedule: { ...c.schedule, days: [0] } }, 'model-1')).not.toBe(k);
    expect(agreementKey(c, 'model-2')).not.toBe(k);
    expect(agreementKey({ ...c, projects: ['beta', 'alpha'] }, 'model-1')).toBe(k); // the order of the ticks does not matter
  });
});

describe('the cost shown live and in the agreement', () => {
  it('adds up typical and worst case per project, per run and per month', () => {
    const est = { textTypical: 0.1, textWorst: 0.3, chartsTypical: 0.05, chartsWorst: 0.2 };
    const base = { project: 'p', notes: 3, lastArticle: null, chartsDue: true, detail: '' };
    const rows = [
      { state: { ...base, hasArticle: true, textDue: true } as ProjectState, est },
      { state: { ...base, hasArticle: true, textDue: false, chartsDue: false } as ProjectState, est },
    ];
    const cfg = { schedule: weekly([6, 0]), projects: ['a', 'b'], text: true, charts: true, limitUsd: 10 };
    const s = summarize(cfg, rows, 'Meta Model API / muse-spark-1.3');
    const live = Object.fromEntries(s.live);
    expect(live['Model for TEXT and charts']).toBe('Meta Model API / muse-spark-1.3');
    expect(live['One project, typical']).toBe('about $0.15 (text $0.10 + charts $0.05)');
    expect(live['One project, worst case']).toBe('at most $0.50 (every token limit fully used)');
    expect(live['This run if started now']).toBe('about $0.15 for the 2 selected projects, 1 of them with changes');
    expect(live['Worst case of one run']).toBe('at most $1.00 (all 2 selected projects change)');
    expect(s.worstRun).toBeCloseTo(1, 6);
    const agree = Object.fromEntries(s.agree);
    expect(agree.Schedule).toBe('every Saturday and Sunday at 02:00 UTC');
    expect(agree.Creates).toBe('TEXT and AI flow charts, only for projects whose notes changed');
    expect(agree['Estimated cost of one run']).toBe('about $0.15 now, at most $1.00');
    expect(agree['Your spending limit']).toBe('a run stops at $10.00 → at most $90.00 a month (9 runs)');
  });
});

describe('the Auto store', () => {
  let dir: string;
  beforeAll(async () => void (dir = await mkdtemp(join(tmpdir(), 'mnemosyne-auto-'))));
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('starts empty and does not lose parallel updates', async () => {
    const store = new AutoStore(join(dir, 'a.json'));
    expect(await store.get()).toEqual({ runs: [] });
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.update((s) => void s.runs.push({ id: String(i) } as never))));
    expect((await new AutoStore(join(dir, 'a.json')).get()).runs).toHaveLength(25); // every update is in the file a second reader sees
  });
});

describe('the runner (no AI is called: the model call is a fake)', () => {
  let dir: string;
  beforeAll(async () => void (dir = await mkdtemp(join(tmpdir(), 'mnemosyne-autorun-'))));
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const state = (project: string, kind: 'changed' | 'ok' | 'new' | 'charts'): ProjectState => ({
    project,
    notes: 3,
    hasArticle: kind !== 'new',
    lastArticle: null,
    textDue: kind === 'changed' || kind === 'new',
    chartsDue: kind !== 'ok',
    detail: kind,
  });

  const AGREED: AutoConfig = {
    enabled: true,
    schedule: weekly([6, 0]),
    projects: ['a', 'b', 'c'],
    known: ['a', 'b', 'c'],
    text: true,
    charts: true,
    limitUsd: 10,
    agreement: { by: 'olaf', at: '2026-10-30T10:00:00.000Z', key: 'K1' },
  };

  let n = 0;
  async function harness(over: { cfg?: Partial<AutoConfig>; states?: Record<string, ProjectState>; clock?: string; due?: string; run?: object; gen?: (p: string, k: string) => Promise<void> | void } = {}) {
    const store = new AutoStore(join(dir, `run-${n++}.json`));
    const h = {
      store,
      clock: new Date(over.clock ?? '2026-11-01T02:00:30Z'),
      key: 'K1',
      busy: false,
      calls: [] as string[],
      activeDuring: [] as boolean[],
      logs: [] as { event: string; description?: string }[],
      states: over.states ?? { a: state('a', 'changed'), b: state('b', 'ok'), c: state('c', 'new') },
      worst: 0.25,
      cost: 0.2,
      runner: null as unknown as AutoRunner,
    };
    await store.update((s) => {
      s.config = { ...AGREED, ...over.cfg };
      s.nextRunAt = over.due ?? '2026-11-01T02:00:00.000Z';
      if (over.run) s.run = over.run as never;
    });
    h.runner = new AutoRunner({
      store,
      now: () => h.clock,
      sleep: async () => {},
      keyFor: async () => h.key,
      projects: async () => Object.keys(h.states),
      inspect: async (p) => h.states[p]!,
      worst: async () => h.worst,
      generate: async (p, k) => {
        h.calls.push(`${p}:${k}`);
        h.activeDuring.push(h.runner.active);
        await over.gen?.(p, k);
        return { inputTokens: 1000, outputTokens: 500, usd: h.cost };
      },
      busy: () => h.busy,
      log: (e) => h.logs.push(e),
    });
    return h;
  }

  it('runs nothing while switched off, before the time, or without the agreement; a changed setup pauses it', async () => {
    const off = await harness({ cfg: { enabled: false } });
    await off.runner.tick();
    expect(off.calls).toEqual([]);

    const early = await harness({ clock: '2026-11-01T01:59:00Z' });
    await early.runner.tick();
    expect(early.calls).toEqual([]);

    const none = await harness({ cfg: { agreement: undefined } });
    await none.runner.tick();
    expect(none.calls).toEqual([]);
    expect((await none.store.get()).pausedReason).toMatch(/agree again/);

    const drift = await harness();
    drift.key = 'K2'; // the model, its limits or the setup changed after the agreement
    await drift.runner.tick();
    expect(drift.calls).toEqual([]);
    expect((await drift.store.get()).pausedReason).toMatch(/no longer matches/);
    drift.key = 'K1'; // agreed again (or put back)
    await drift.runner.tick();
    expect((await drift.store.get()).pausedReason).toBeNull();
    expect(drift.calls.length).toBeGreaterThan(0);
  });

  it('updates only the projects that changed, article first, then charts; records the run and plans the next', async () => {
    const h = await harness();
    await h.runner.tick();
    expect(h.calls).toEqual(['a:wiki', 'a:diagram', 'c:wiki', 'c:diagram']); // b is up to date: not touched
    const st = await h.store.get();
    expect(st.run).toBeNull();
    expect(st.runs).toHaveLength(1);
    expect(st.runs[0]).toMatchObject({ status: 'completed', updated: ['a', 'c'], unchanged: ['b'], failed: [], notReached: [], inputTokens: 4000, outputTokens: 2000, trigger: 'Sunday 02:00 schedule' });
    expect(st.runs[0]!.usd).toBeCloseTo(0.8, 6);
    expect(st.nextRunAt).toBe('2026-11-07T02:00:00.000Z'); // next Saturday
    expect(h.activeDuring.every(Boolean)).toBe(true); // a person's AI button is refused while it runs
    expect(h.runner.active).toBe(false);
    expect(h.logs.filter((l) => l.event === 'auto_start')).toHaveLength(4);
    expect(h.logs.some((l) => l.event === 'auto_run' && /Run completed: 2 updated, 1 unchanged/.test(l.description ?? ''))).toBe(true);
    // the same moment does not start a second run
    await h.runner.tick();
    expect(h.calls).toHaveLength(4);
  });

  it('only creates what is ticked', async () => {
    const textOnly = await harness({ cfg: { charts: false } });
    await textOnly.runner.tick();
    expect(textOnly.calls).toEqual(['a:wiki', 'c:wiki']);
    const chartsOnly = await harness({ cfg: { text: false }, states: { a: state('a', 'changed'), b: state('b', 'charts'), c: state('c', 'new') } });
    await chartsOnly.runner.tick();
    expect(chartsOnly.calls).toEqual(['a:diagram', 'b:diagram']); // c has no article to draw from
    const nothing = await harness({ states: { a: state('a', 'ok'), b: state('b', 'ok'), c: state('c', 'ok') } });
    await nothing.runner.tick();
    expect(nothing.calls).toEqual([]);
    expect((await nothing.store.get()).runs[0]).toMatchObject({ status: 'nothing', unchanged: ['a', 'b', 'c'] });
  });

  it('stops at the dollar limit before a call that could pass it, and lists what it did not reach', async () => {
    const h = await harness({ cfg: { limitUsd: 0.6 } });
    await h.runner.tick();
    expect(h.calls).toEqual(['a:wiki', 'a:diagram']); // 0.2 + 0.2 spent; the next call could cost 0.25 more: 0.65 > 0.6
    const run = (await h.store.get()).runs[0]!;
    expect(run).toMatchObject({ status: 'limit', updated: ['a'], notReached: ['c'] });
    expect(run.note).toContain('Stopped before c');
    expect(run.usd).toBeCloseTo(0.4, 6);
  });

  it('never makes a call whose cost it cannot limit', async () => {
    const h = await harness();
    h.worst = null as unknown as number;
    await h.runner.tick();
    expect(h.calls).toEqual([]);
    expect((await h.store.get()).runs[0]!.failed.map((f) => f.project)).toEqual(['a', 'c']);
  });

  it('a failed project is reported and the run goes on with the next one; its charts are skipped', async () => {
    const h = await harness({
      gen: (p, k) => {
        if (p === 'a' && k === 'wiki') throw new Error('The AI answered, but not with a usable plan');
      },
    });
    await h.runner.tick();
    expect(h.calls).toEqual(['a:wiki', 'c:wiki', 'c:diagram']);
    const run = (await h.store.get()).runs[0]!;
    expect(run.status).toBe('completed');
    expect(run.failed).toEqual([{ project: 'a', error: 'article: The AI answered, but not with a usable plan' }]);
    expect(run.updated).toEqual(['c']);
  });

  it('skips a run that is more than 12 hours late instead of starting it in the middle of the working day', async () => {
    const h = await harness({ clock: '2026-11-01T16:00:00Z' });
    await h.runner.tick();
    expect(h.calls).toEqual([]);
    const st = await h.store.get();
    expect(st.runs[0]).toMatchObject({ status: 'missed' });
    expect(st.runs[0]!.note).toContain('14 hours late');
    expect(st.nextRunAt).toBe('2026-11-07T02:00:00.000Z');
    // a run that is only a little late still runs
    const late = await harness({ clock: '2026-11-01T10:00:00Z' });
    await late.runner.tick();
    expect(late.calls.length).toBe(4);
  });

  it('waits while a person’s AI job runs and never starts on top of it', async () => {
    const h = await harness();
    h.busy = true;
    await h.runner.tick();
    expect(h.calls).toEqual([]);
    expect((await h.store.get()).run).toBeFalsy();
    h.busy = false;
    await h.runner.tick();
    expect(h.calls.length).toBe(4);
  });

  it('goes on after a restart with the projects it had not done, and gives up on one that was cut off twice', async () => {
    const run = {
      id: '20261101T020000Z', startedAt: '2026-11-01T02:00:05.000Z', scheduledFor: '2026-11-01T02:00:00.000Z', trigger: 'Sunday 02:00 schedule', status: 'running',
      updated: [], unchanged: ['b'], failed: [], notReached: [], total: 3, inputTokens: 100, outputTokens: 50, usd: 0.2, warnings: [],
      queue: [
        { project: 'a', text: true, charts: true, attempts: 1, wikiDone: true },
        { project: 'c', text: true, charts: false, attempts: 2 },
      ],
    };
    const h = await harness({ run });
    await h.runner.tick();
    expect(h.calls).toEqual(['a:diagram']); // the article of a was already saved: not paid for again
    const done = (await h.store.get()).runs[0]!;
    expect(done.updated).toEqual(['a']);
    expect(done.failed).toEqual([{ project: 'c', error: 'The service was restarted during this project twice; it was skipped.' }]);
    expect(done.usd).toBeCloseTo(0.4, 6); // the 0.2 spent before the restart counts toward the limit
  });

  it('stops when it is switched off or the agreement stops matching in the middle of a run', async () => {
    const off = await harness({
      gen: async () => {
        await off.store.update((s) => void (s.config!.enabled = false));
      },
    });
    await off.runner.tick();
    expect(off.calls).toEqual(['a:wiki']);
    expect((await off.store.get()).runs[0]).toMatchObject({ status: 'stopped', updated: ['a'], notReached: ['c'] });

    const drift = await harness({
      gen: () => {
        drift.key = 'K2';
      },
    });
    await drift.runner.tick();
    expect(drift.calls).toEqual(['a:wiki']);
    expect((await drift.store.get()).runs[0]!.note).toContain('no longer matches');
  });

  it('a one-time schedule has no next run once it has run', async () => {
    const h = await harness({ cfg: { schedule: { mode: 'once', days: [], date: '2026-11-01', time: '02:00', tz: 'UTC' } } });
    await h.runner.tick();
    expect(h.calls.length).toBe(4);
    const st = await h.store.get();
    expect(st.nextRunAt).toBeNull();
    expect(st.runs[0]!.trigger).toBe('One-time schedule 2026-11-01 02:00');
  });

  it('keeps only the last 30 runs', async () => {
    const h = await harness({ states: { a: state('a', 'ok'), b: state('b', 'ok'), c: state('c', 'ok') } });
    for (let i = 0; i < 33; i++) {
      await h.store.update((s) => void (s.nextRunAt = '2026-11-01T02:00:00.000Z'));
      await h.runner.tick();
    }
    expect((await h.store.get()).runs).toHaveLength(30);
  });
});
