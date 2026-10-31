import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PICTURE_LIMITS, PlanError, drawScene, layout, parsePlan, parsePlanSet, renderSvg, type Scene } from '../src/diagram.js';
import { DEFAULT_PLAN_SYSTEM, DEFAULT_PLAN_USER, buildDiagramPlanPrompt } from '../src/docgen.js';
import { buildPdf } from '../src/pdf.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/plan-${name}.json`, import.meta.url), 'utf8');

type Rect = { x: number; y: number; w: number; h: number };
const boxesOf = (s: Scene): Rect[] => s.ops.filter((o) => o.t === 'rect' && o.r === 10).map((o) => o as unknown as Rect);
const halosOf = (s: Scene): Rect[] => s.ops.filter((o) => o.t === 'rect' && o.r === 3 && o.h > 8).map((o) => o as unknown as Rect);
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const textX = (s: Scene, text: string): number => {
  const t = s.ops.find((o) => o.t === 'text' && o.text === text);
  if (!t || t.t !== 'text') throw new Error(`no text “${text}” in the drawing`);
  return t.x;
};

describe('reading the plan the AI wrote', () => {
  it('finds the JSON in fences and prose, and shortens and tidies the text', () => {
    const raw = 'Here is the plan:\n```json\n' + fixture('mnemosyne') + '\n```\nHope this helps!';
    const plan = parsePlan(raw, 'x');
    expect(plan.title).toBe('Mnemosyne');
    expect(plan.columns.map((c) => c.title)).toEqual(['Clients', 'Endpoint :40000/tcp', 'Service', 'Storage']);
    expect(plan.links.length).toBe(14);
    expect(plan.dropped).toEqual([]);
  });

  it('masks credentials, drops unknown arrows and extra columns, and makes every arrow touching a control box dashed', () => {
    const plan = parsePlan(
      JSON.stringify({
        columns: [
          { title: 'A', nodes: [{ id: 'a', label: 'API password: hunter2hunter2' }, { id: 'c', label: 'Config', lane: 'control' }] },
          { title: 'B', nodes: [{ id: 'b', label: 'B' }, { id: 'b', label: 'Duplicate id' }] },
          ...Array.from({ length: 8 }, (_, i) => ({ title: `X${i}`, nodes: [{ label: `Extra ${i}` }] })),
        ],
        links: [{ from: 'a', to: 'b', label: 'ok' }, { from: 'a', to: 'ghost', label: 'bad' }, { from: 'c', to: 'a' }, { from: 'a', to: 'a' }],
      }),
      'Fallback',
    );
    expect(plan.title).toBe('Fallback');
    expect(JSON.stringify(plan)).not.toContain('hunter2');
    expect(plan.columns.length).toBe(8);
    expect(new Set(plan.columns.flatMap((c) => c.nodes.map((n) => n.id))).size).toBe(plan.columns.flatMap((c) => c.nodes).length); // ids stay unique
    expect(plan.links.map((l) => `${l.from}>${l.to}`)).toEqual(['a>b', 'c>a']);
    expect(plan.links.find((l) => l.from === 'c')!.dashed).toBe(true);
    expect(plan.links.find((l) => l.from === 'a')!.dashed).toBe(false);
    expect(plan.dropped.join(' ')).toMatch(/ghost/);
    expect(plan.dropped.join(' ')).toMatch(/more than 8 columns/);
  });

  it('refuses an answer that is not a usable plan, saying why', () => {
    expect(() => parsePlan('A clean flow chart: Notes -> Article -> PDF', 'x')).toThrow(/no JSON object.*A clean flow chart/);
    expect(() => parsePlan('{"columns": [', 'x')).toThrow(PlanError);
    expect(() => parsePlan('{"title":"x"}', 'x')).toThrow(/no "columns"/);
    expect(() => parsePlan('{"columns":[{"nodes":[{"label":"Only one"}]}]}', 'x')).toThrow(/fewer than two boxes/);
    expect(() => parsePlan('{"columns":[{"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}],"links":[]}', 'x')).toThrow(/no arrows/);
  });
});

describe('reading a set of pictures (overview + details)', () => {
  const pic = (name: string, boxes: number, arrows = boxes - 1) => ({
    name,
    columns: Array.from({ length: Math.ceil(boxes / 5) }, (_, c) => ({
      title: `C${c}`,
      nodes: Array.from({ length: Math.min(5, boxes - c * 5) }, (_, k) => ({ id: `b${c * 5 + k}`, label: `Box ${c * 5 + k}`, lane: 'path' })),
    })),
    links: Array.from({ length: arrows }, (_, i) => ({ from: `b${i % boxes}`, to: `b${(i + 1) % boxes}`, label: `arrow ${i}` })),
  });

  it('reads an overview and detail pictures; the details are titled with their topic, the overview with the project', () => {
    const set = parsePlanSet(JSON.stringify({ title: 'centest', diagrams: [pic('Overview', 4), pic('Request path', 5), pic('Data and storage', 3)] }), 'x');
    expect(set.pictures.map((p) => p.name)).toEqual(['Overview', 'Request path', 'Data and storage']);
    expect(set.pictures.map((p) => p.plan.title)).toEqual(['centest', 'centest - Request path', 'centest - Data and storage']);
    expect(set.dropped).toEqual([]);
  });

  it('still reads the old single-picture answer as one overview', () => {
    const set = parsePlanSet(fixture('mnemosyne'), 'x');
    expect(set.pictures.length).toBe(1);
    expect(set.pictures[0]!.name).toBe('Overview');
  });

  it('holds every picture to the limits: at most 12 boxes, 16 arrows, 5 pictures; what is cut is reported', () => {
    expect(PICTURE_LIMITS).toMatchObject({ nodes: 12, links: 16, pictures: 5 });
    const set = parsePlanSet(JSON.stringify({ diagrams: [pic('Overview', 20, 30), ...Array.from({ length: 6 }, (_, i) => pic(`D${i}`, 3))] }), 'x');
    expect(set.pictures.length).toBe(5);
    const big = set.pictures[0]!.plan;
    expect(big.columns.flatMap((c) => c.nodes).length).toBe(12);
    expect(big.links.length).toBeLessThanOrEqual(16);
    expect(set.dropped.join(' ')).toMatch(/too many boxes/);
    expect(set.dropped.join(' ')).toMatch(/more than 5 pictures/);
  });

  it('leaves out a picture that cannot be used but keeps the others; refuses an answer with nothing usable', () => {
    const set = parsePlanSet(JSON.stringify({ diagrams: [pic('Overview', 3), { name: 'Broken', columns: [{ nodes: [{ label: 'Only one' }] }] }, pic('Good detail', 3)] }), 'p');
    expect(set.pictures.map((p) => p.name)).toEqual(['Overview', 'Good detail']);
    expect(set.dropped.join(' ')).toMatch(/Broken.*fewer than two boxes/);
    expect(() => parsePlanSet(JSON.stringify({ diagrams: [{ name: 'Broken', columns: [] }] }), 'p')).toThrow(/none of the pictures/);
    expect(() => parsePlanSet('{"title":"x"}', 'p')).toThrow(/no "diagrams" list/);
    expect(() => parsePlanSet('A clean flow chart', 'p')).toThrow(/no JSON object/);
  });
});

describe('drawing the plan', () => {
  // 'real-*' are plans the AI actually wrote on 2026-10-30/31 (addresses removed): the busiest diagrams we have; real-centest-dense is the 21-arrow
  // single picture the owner saw with labels on top of each other and cut off at the edge
  for (const name of ['mnemosyne', 'load-balancer', 'real-aequitas', 'real-mnemosyne', 'real-centest-dense']) {
    it(`${name}: boxes never overlap, no label covers a box or another label, no arrow runs behind a box, everything stays inside the picture`, () => {
      const plan = parsePlan(fixture(name), name);
      const scene = layout(plan);
      const boxes = boxesOf(scene);
      const halos = halosOf(scene);
      for (const [i, a] of halos.entries()) for (const b of halos.slice(i + 1)) expect(overlap(a, b), 'two arrow labels overlap').toBe(false);
      for (const o of scene.ops) {
        if (o.t !== 'path') continue;
        for (let k = 0; k + 1 < o.pts.length; k++) {
          const [x1, y1] = o.pts[k]!;
          const [x2, y2] = o.pts[k + 1]!;
          const seg = { x: Math.min(x1, x2) - 0.5, y: Math.min(y1, y2) - 0.5, w: Math.abs(x2 - x1) + 1, h: Math.abs(y2 - y1) + 1 };
          for (const b of boxes) expect(overlap(seg, { x: b.x + 3, y: b.y + 3, w: b.w - 6, h: b.h - 6 }), 'an arrow runs behind a box').toBe(false);
        }
      }
      expect(boxes.length).toBe(plan.columns.reduce((s, c) => s + c.nodes.length, 0));
      for (const [i, a] of boxes.entries()) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(scene.width);
        expect(a.y + a.h).toBeLessThanOrEqual(scene.height);
        for (const b of boxes.slice(i + 1)) expect(overlap(a, b), 'two boxes overlap').toBe(false);
      }
      for (const h of halosOf(scene)) for (const b of boxes) expect(overlap(h, b), 'an arrow label covers a box').toBe(false);
      for (const h of halosOf(scene)) {
        expect(h.x, 'an arrow label sticks out on the left').toBeGreaterThanOrEqual(0);
        expect(h.x + h.w, 'an arrow label sticks out on the right (cut off)').toBeLessThanOrEqual(scene.width);
      }
      for (const o of scene.ops) {
        if (o.t !== 'text') continue;
        expect(o.x).toBeGreaterThan(0);
        expect(o.x).toBeLessThan(scene.width);
      }
    });
  }

  it('centest split into an overview and four topic pictures: every picture is clean (the one-picture version had 25 arrows and unreadable labels)', () => {
    const set = parsePlanSet(fixture('real-centest-set'), 'centest');
    expect(set.pictures.map((p) => p.name)).toEqual(['Overview', 'Request path', 'Data and storage', 'Monitoring and satellites', 'Sign-in and security']);
    expect(set.dropped).toEqual([]);
    for (const { name, plan } of set.pictures) {
      expect(plan.columns.flatMap((c) => c.nodes).length, `${name}: boxes`).toBeLessThanOrEqual(10);
      expect(plan.links.length, `${name}: arrows`).toBeLessThanOrEqual(14);
      const scene = layout(plan);
      const boxes = boxesOf(scene);
      const halos = halosOf(scene);
      for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(overlap(a, b), `${name}: two boxes overlap`).toBe(false);
      for (const [i, a] of halos.entries()) for (const b of halos.slice(i + 1)) expect(overlap(a, b), `${name}: two arrow labels overlap`).toBe(false);
      for (const h of halos) for (const b of boxes) expect(overlap(h, b), `${name}: a label covers a box`).toBe(false);
      for (const o of scene.ops) {
        if (o.t !== 'path') continue;
        for (let k = 0; k + 1 < o.pts.length; k++) {
          const [x1, y1] = o.pts[k]!;
          const [x2, y2] = o.pts[k + 1]!;
          const seg = { x: Math.min(x1, x2) - 0.5, y: Math.min(y1, y2) - 0.5, w: Math.abs(x2 - x1) + 1, h: Math.abs(y2 - y1) + 1 };
          for (const b of boxes) expect(overlap(seg, { x: b.x + 3, y: b.y + 3, w: b.w - 6, h: b.h - 6 }), `${name}: an arrow runs behind a box`).toBe(false);
        }
      }
    }
  });

  it('puts the components in the order of the plan, closest to the user first: client, VRRP, frontend, TLS, WAF, load balancer, pools', () => {
    const scene = layout(parsePlan(fixture('load-balancer'), 'lb'));
    const order = ['Client', 'VRRP virtual IP', 'FE frontend / VIP service', 'ACC TLS accelerator', 'WAF rule engine', 'BE backend / load', 'Aggregator backend'];
    const xs = order.map((t) => textX(scene, t));
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    // the VRRP box is in the request path (same band as the client), not in the management band below
    const y = (t: string) => (scene.ops.find((o) => o.t === 'text' && o.text === t) as { y: number }).y;
    expect(y('VRRP virtual IP')).toBeLessThan(y('keepalived'));
    expect(scene.ops.some((o) => o.t === 'text' && o.text === 'MANAGEMENT AND CONTROL')).toBe(true);
  });

  it('is the same picture every time (no randomness) and the SVG is plain drawing instructions with escaped text', () => {
    const plan = parsePlan(fixture('mnemosyne'), 'x');
    const a = renderSvg(layout(plan), plan);
    expect(renderSvg(layout(plan), plan)).toBe(a);
    expect(a.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(a.trimEnd().endsWith('</svg>')).toBe(true);
    expect(a).not.toMatch(/NaN|undefined|<script|<foreignObject|href=/);
    for (const label of ['VS Code', 'JetBrains', 'GitLab SSO bridge', 'Git repository', 'SQLite search index']) expect(a).toContain(`>${label}<`);
    const evil = parsePlan(
      JSON.stringify({ title: '</title><script>x</script>', columns: [{ nodes: [{ id: 'a', label: '<b onload="x">&' }, { id: 'b', label: 'B' }] }], links: [{ from: 'a', to: 'b', label: '"><img>' }] }),
      'x',
    );
    const svg = renderSvg(layout(evil), evil);
    expect(svg).not.toMatch(/<script|<b |<img/);
    expect(svg).toContain('&lt;b onload=&quot;x&quot;&gt;&amp;');
  });

  it('a long chain stays one row; a single column and long words do not break the layout', () => {
    const one = parsePlan(JSON.stringify({ columns: [{ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] }], links: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c', label: 'skips b' }] }), 'x');
    const scene = layout(one);
    expect(scene.width).toBeGreaterThan(0);
    expect(JSON.stringify(scene)).not.toMatch(/NaN|null/);
    const word = parsePlan(JSON.stringify({ columns: [{ nodes: [{ id: 'a', label: 'x'.repeat(200), detail: 'y'.repeat(400) }, { id: 'b', label: 'B' }] }], links: [{ from: 'a', to: 'b' }] }), 'x');
    expect(JSON.stringify(layout(word))).not.toMatch(/NaN/);
  });
});

describe('the diagram in the PDF', () => {
  it('is painted as vectors, turned a quarter turn on a portrait page when it is wide: every page of the PDF stays portrait A4', async () => {
    const plan = parsePlan(fixture('load-balancer'), 'lb');
    const scene = layout(plan);
    let drawn = 0;
    const pdf = await buildPdf({
      title: 'LB',
      subtitle: '',
      generatedAt: new Date().toISOString(),
      model: 'm',
      noteCount: 1,
      markdown: '## Overview\n\nText.',
      compress: false,
      diagrams: [{ name: 'Workflow diagram', vector: { width: scene.width, height: scene.height, draw: (d, x, y, s) => (drawn++, drawScene(d, scene, x, y, s)) }, caption: 'Created now' }],
    });
    expect(drawn).toBe(1);
    const text = pdf.toString('latin1');
    expect(text).not.toContain('/MediaBox [0 0 841.89 595.28]'); // no landscape page
    expect((text.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g) ?? []).length).toBeGreaterThanOrEqual(4); // cover, index, diagram, article
    expect(text).toMatch(/\b0 -1 1 0 [\d.]+ [\d.]+ cm\b/); // the quarter turn (counter-clockwise: text reads bottom to top)
    expect(text).not.toContain('NaN');

    // a diagram that is not wide stays upright on its page
    const small = parsePlan(JSON.stringify({ columns: [{ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }] }], links: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }] }), 'x');
    const sc = layout(small);
    expect(sc.width / sc.height).toBeLessThan(1.25);
    const upright = await buildPdf({ title: 'T', subtitle: '', generatedAt: new Date().toISOString(), model: 'm', noteCount: 1, markdown: '## Overview\n\nText.', compress: false, diagrams: [{ name: 'Workflow diagram', vector: { width: sc.width, height: sc.height, draw: (d, x, y, s) => drawScene(d, sc, x, y, s) }, caption: 'c' }] });
    expect(upright.toString('latin1')).not.toMatch(/\b0 -1 1 0 [\d.]+ [\d.]+ cm\b/);
  });
});

describe('several pictures in the PDF', () => {
  it('every picture gets a page after the index: overview first, then the details; wide ones turned, tall ones upright', async () => {
    const wide = layout(parsePlan(fixture('load-balancer'), 'lb'));
    const tall = layout(parsePlan(JSON.stringify({ columns: [{ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }] }], links: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }] }), 'x'));
    const vec = (sc: Scene) => ({ width: sc.width, height: sc.height, draw: (d: Parameters<typeof drawScene>[0], x: number, y: number, s: number) => drawScene(d, sc, x, y, s) });
    const make = async (n: number) =>
      (
        await buildPdf({
          title: 'T',
          subtitle: '',
          generatedAt: new Date().toISOString(),
          model: 'm',
          noteCount: 1,
          markdown: '## Overview\n\nText.',
          compress: false,
          diagrams: [
            { name: 'Workflow diagram', caption: 'c', vector: vec(wide) },
            { name: 'Diagram: Request path', caption: 'c', vector: vec(tall) },
            { name: 'Diagram: Storage', caption: 'c', vector: vec(wide) },
          ].slice(0, n),
        })
      ).toString('latin1');
    const pages = (t: string) => (t.match(/\/Type \/Page\b/g) ?? []).length;
    const one = await make(1);
    const three = await make(3);
    expect(pages(three) - pages(one)).toBe(2); // two more pictures, two more pages
    expect((three.match(/\b0 -1 1 0 [\d.]+ [\d.]+ cm\b/g) ?? []).length).toBe(2); // the two wide ones are turned, the tall one is not
    expect(three).not.toContain('/MediaBox [0 0 841.89 595.28]');
  });
});

describe('the prompts that ask the AI for the plan', () => {
  it('ask for JSON only, closest-to-the-user-first order, VRRP at the entry, every interface and truthful authentication', () => {
    expect(DEFAULT_PLAN_SYSTEM).toContain('solutions architect');
    expect(DEFAULT_PLAN_SYSTEM).toContain('ONLY one JSON object');
    for (const must of ['CLOSEST TO THE USER FIRST', 'VRRP', 'EVERY interface', 'port', 'single sign-on', 'optional or not switched on', '"lane":"control"', '{{article}}', '{{project}}', '"diagrams"', 'SPLIT, DO NOT CROWD', 'OVERVIEW', 'DETAIL pictures', 'at most 10 boxes', 'at most 14 arrows', 'At most 5 pictures']) expect(DEFAULT_PLAN_USER, must).toContain(must);
    const p = buildDiagramPlanPrompt('alpha', 'THE ARTICLE TEXT');
    expect(p.user).toContain('"alpha"');
    expect(p.user).toContain('THE ARTICLE TEXT');
    expect(p.user).not.toContain('{{');
    expect(buildDiagramPlanPrompt('alpha', 'x', { system: 'MY SYSTEM', user: 'MY {{article}}' })).toEqual({ system: 'MY SYSTEM', user: 'MY x' });
  });
});
