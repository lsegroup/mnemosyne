// What the REAL Node code makes of the corpus and of diagram answers, so the Go tests can prove the Go engine does exactly the same.
//   node testdata/gen/engine.mjs corpus <nodesDir>       notes, fingerprints, masked bodies, prompts of a few projects
//   node testdata/gen/engine.mjs diagrams <answers.json>  for each raw AI answer: the plan set, and every picture laid out and drawn
//   node testdata/gen/engine.mjs auto <cases.json>        schedule, agreement and summary arithmetic of Auto
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve(process.env.MNEMOSYNE_NODE_DIST ?? '../packages/server/dist');
const imp = (f) => import(pathToFileURL(`${dist}/${f}`).href);
const [, , mode, arg] = process.argv;

if (mode === 'corpus') {
  const { NodeIndex, redact } = await imp('docs.js');
  const { buildWikiPrompt } = await imp('docgen.js');
  const { noteHash, noteHashes } = await imp('auto.js');
  const index = new NodeIndex(arg);
  const all = await index.all();
  const projects = (await index.projects()).map((p) => p.project);
  const prompts = {};
  for (const p of projects.slice(0, 6)) {
    const pr = buildWikiPrompt(p, null, await index.inProject(p), {});
    prompts[p] = { system: pr.system, user: pr.user, noteCount: pr.noteCount, inputTokens: pr.inputTokens };
  }
  console.log(
    JSON.stringify({
      count: all.length,
      projects: await index.projects(),
      notes: all.map((n) => ({ id: n.id, project: n.project, title: n.title, observed_at: n.observed_at, components: n.components, hash: noteHash(n), bodyLen: n.body.length, redacted: redact(n.body) })),
      hashes: Object.fromEntries(projects.slice(0, 3).map((p) => [p, null])),
      prompts,
      order: all.map((n) => n.id),
      unused: noteHashes([]) && null,
    }),
  );
} else if (mode === 'diagrams') {
  const { parsePlanSet, layout, renderSvg, PlanError } = await imp('diagram.js');
  const answers = JSON.parse(readFileSync(arg, 'utf8'));
  const out = answers.map((raw) => {
    try {
      const set = parsePlanSet(raw, 'My Project');
      return { ok: true, set, svgs: set.pictures.map((p) => renderSvg(layout(p.plan), p.plan)), scenes: set.pictures.map((p) => { const s = layout(p.plan); return { width: s.width, height: s.height, ops: s.ops.length }; }) };
    } catch (err) {
      if (!(err instanceof PlanError)) throw err;
      return { ok: false, error: err.message };
    }
  });
  console.log(JSON.stringify(out));
} else if (mode === 'auto') {
  const auto = await imp('auto.js');
  const cases = JSON.parse(readFileSync(arg, 'utf8'));
  const out = {
    next: cases.next.map((c) => {
      const r = auto.nextRun(c.schedule, new Date(c.after));
      return r ? r.toISOString() : null;
    }),
    describe: cases.next.map((c) => auto.describeSchedule(c.schedule)),
    runsPerMonth: cases.next.map((c) => auto.runsPerMonth(c.schedule)),
    keys: cases.keys.map((c) => auto.agreementKey(c.cfg, c.modelKey)),
    parsed: cases.parse.map((c) => {
      try {
        return { ok: auto.parseAutoInput(c.input, c.known, new Date(c.now)) };
      } catch (err) {
        return { error: err.message };
      }
    }),
    inspect: cases.inspect.map((c) => auto.inspectProject(c.project, c.notes, c.wiki, c.diagram)),
    summary: cases.summary.map((c) => auto.summarize(c.cfg, c.rows, c.label)),
    duration: cases.durations.map((ms) => auto.formatDuration(ms)),
    modelKeys: await Promise.all(
      cases.modelKeys.map(async (c) => {
        const { effectiveJob } = await imp('ai-jobs.js');
        const { createHash } = await import('node:crypto');
        return createHash('sha256').update(JSON.stringify([c.providerId, c.model, effectiveJob('text', c.text), effectiveJob('image', c.image)])).digest('hex');
      }),
    ),
  };
  console.log(JSON.stringify(out));
} else {
  throw new Error('mode must be corpus, diagrams or auto');
}
