import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PlanError, drawScene, layout, parsePlan, renderSvg, type Scene } from '../src/diagram.js';
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

describe('drawing the plan', () => {
  for (const name of ['mnemosyne', 'load-balancer']) {
    it(`${name}: boxes never overlap, labels never cover a box, everything stays inside the picture`, () => {
      const plan = parsePlan(fixture(name), name);
      const scene = layout(plan);
      const boxes = boxesOf(scene);
      expect(boxes.length).toBe(plan.columns.reduce((s, c) => s + c.nodes.length, 0));
      for (const [i, a] of boxes.entries()) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(scene.width);
        expect(a.y + a.h).toBeLessThanOrEqual(scene.height);
        for (const b of boxes.slice(i + 1)) expect(overlap(a, b), 'two boxes overlap').toBe(false);
      }
      for (const h of halosOf(scene)) for (const b of boxes) expect(overlap(h, b), 'an arrow label covers a box').toBe(false);
      for (const o of scene.ops) {
        if (o.t !== 'text') continue;
        expect(o.x).toBeGreaterThan(0);
        expect(o.x).toBeLessThan(scene.width);
      }
    });
  }

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
  it('is painted as vectors on a landscape page when it is wide, and the other pages stay portrait', async () => {
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
      diagram: { vector: { width: scene.width, height: scene.height, draw: (d, x, y, s) => (drawn++, drawScene(d, scene, x, y, s)) }, caption: 'Created now' },
    });
    expect(drawn).toBe(1);
    const text = pdf.toString('latin1');
    expect(text).toContain('/MediaBox [0 0 841.89 595.28]'); // the landscape page
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]'); // cover and article stay portrait
    expect(text).not.toContain('NaN');
  });
});

describe('the prompts that ask the AI for the plan', () => {
  it('ask for JSON only, closest-to-the-user-first order, VRRP at the entry, every interface and truthful authentication', () => {
    expect(DEFAULT_PLAN_SYSTEM).toContain('solutions architect');
    expect(DEFAULT_PLAN_SYSTEM).toContain('ONLY one JSON object');
    for (const must of ['CLOSEST TO THE USER FIRST', 'VRRP', 'EVERY interface', 'port', 'single sign-on', 'optional or not switched on', '"lane":"control"', '{{article}}', '{{project}}']) expect(DEFAULT_PLAN_USER, must).toContain(must);
    const p = buildDiagramPlanPrompt('alpha', 'THE ARTICLE TEXT');
    expect(p.user).toContain('"alpha"');
    expect(p.user).toContain('THE ARTICLE TEXT');
    expect(p.user).not.toContain('{{');
    expect(buildDiagramPlanPrompt('alpha', 'x', { system: 'MY SYSTEM', user: 'MY {{article}}' })).toEqual({ system: 'MY SYSTEM', user: 'MY x' });
  });
});
