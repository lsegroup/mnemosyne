import PDFDocument from 'pdfkit';
import { redact } from './docs.js';
import { pdfText } from './pdf.js';

/**
 * The architecture diagram of a project. The AI never draws it: the text model reads the article and writes a
 * PLAN (columns of boxes, arrows between them, as JSON); this file validates the plan, lays it out and draws it
 * itself as SVG (for the page) or as vectors inside the PDF. Every word in the picture is therefore spelled
 * exactly as the plan says, the order is the order of the columns (closest to the user first) and the layout
 * does not change between runs.
 */

export class PlanError extends Error {}

export interface PlanNode {
  id: string;
  label: string;
  detail: string;
  /** "path" = a request passes through it; "control" = configures, monitors or signs people in, not in the path. */
  lane: 'path' | 'control';
}
export interface PlanColumn {
  title: string;
  nodes: PlanNode[];
}
export interface PlanLink {
  from: string;
  to: string;
  label: string;
  dashed: boolean;
}
export interface DiagramPlan {
  title: string;
  columns: PlanColumn[];
  links: PlanLink[];
  /** What was left out of the AI's answer (too many boxes, links to unknown boxes, ...). */
  dropped: string[];
}

const LIMITS = { columns: 8, pathPerColumn: 8, controlPerColumn: 6, nodes: 30, links: 45, title: 60, colTitle: 32, label: 44, detail: 96, linkLabel: 48 };

// ----------------------------------------------------------------------------
// Reading the AI's answer
// ----------------------------------------------------------------------------

/** One line of plain text: Latin-1 safe (the PDF fonts), no control characters, credentials masked, shortened. */
function clean(v: unknown, max: number): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const t = redact(pdfText(String(v)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim());
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new PlanError(`no JSON object in the answer (it begins: “${clean(text.slice(0, 90), 90)}”)`);
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch (err) {
    throw new PlanError(`the JSON is not valid (${(err as Error).message})`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates and tidies the AI's plan. Anything unusable is dropped and listed in `dropped`; a plan with nothing left to draw is an error. */
export function parsePlan(raw: string, fallbackTitle: string): DiagramPlan {
  const root = extractJson(raw);
  if (!isObj(root) || !Array.isArray(root.columns)) throw new PlanError('the JSON has no "columns" list');
  const dropped: string[] = [];
  const ids = new Map<string, string>(); // lower-case id -> id
  const columns: PlanColumn[] = [];
  let total = 0;
  let auto = 0;

  for (const rawCol of root.columns) {
    if (!isObj(rawCol) || !Array.isArray(rawCol.nodes)) continue;
    if (columns.length >= LIMITS.columns) {
      dropped.push(`column “${clean(rawCol.title, 30)}” (more than ${LIMITS.columns} columns)`);
      continue;
    }
    const nodes: PlanNode[] = [];
    let path = 0;
    let control = 0;
    for (const rawNode of rawCol.nodes) {
      if (!isObj(rawNode)) continue;
      const label = clean(rawNode.label ?? rawNode.name ?? rawNode.title, LIMITS.label);
      if (!label) continue;
      const lane = String(rawNode.lane ?? '').toLowerCase() === 'control' ? 'control' : 'path';
      if (total >= LIMITS.nodes || (lane === 'path' ? path : control) >= (lane === 'path' ? LIMITS.pathPerColumn : LIMITS.controlPerColumn)) {
        dropped.push(`box “${label}” (too many boxes)`);
        continue;
      }
      let id = clean(rawNode.id, 24) || `n${++auto}`;
      while (ids.has(id.toLowerCase())) id = `${id}_${++auto}`;
      ids.set(id.toLowerCase(), id);
      nodes.push({ id, label, detail: clean(rawNode.detail ?? rawNode.description, LIMITS.detail), lane });
      if (lane === 'path') path++;
      else control++;
      total++;
    }
    if (nodes.length) columns.push({ title: clean(rawCol.title, LIMITS.colTitle), nodes });
  }
  if (total < 2) throw new PlanError('the plan has fewer than two boxes');

  const laneOf = new Map(columns.flatMap((c) => c.nodes.map((n) => [n.id, n.lane] as const)));
  const links: PlanLink[] = [];
  const seen = new Set<string>();
  for (const rawLink of Array.isArray(root.links) ? root.links : []) {
    if (!isObj(rawLink)) continue;
    const from = ids.get(clean(rawLink.from, 24).toLowerCase());
    const to = ids.get(clean(rawLink.to, 24).toLowerCase());
    if (!from || !to || from === to) {
      dropped.push(`arrow “${clean(rawLink.from, 24)} -> ${clean(rawLink.to, 24)}” (unknown or identical boxes)`);
      continue;
    }
    const label = clean(rawLink.label, LIMITS.linkLabel);
    const key = `${from}>${to}>${label}`;
    if (seen.has(key) || links.length >= LIMITS.links) continue;
    seen.add(key);
    links.push({ from, to, label, dashed: rawLink.dashed === true || laneOf.get(from) === 'control' || laneOf.get(to) === 'control' });
  }
  if (!links.length) throw new PlanError('the plan has no arrows between its boxes');
  return { title: clean(root.title, LIMITS.title) || clean(fallbackTitle, LIMITS.title) || 'Architecture', columns, links, dropped };
}

// ----------------------------------------------------------------------------
// Laying out
// ----------------------------------------------------------------------------

type Op =
  | { t: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: string; stroke?: string; sw?: number }
  | { t: 'path'; pts: [number, number][]; dash: boolean; color: string }
  | { t: 'arrow'; pts: [number, number][]; color: string }
  | { t: 'text'; x: number; y: number; text: string; size: number; bold: boolean; anchor: 'start' | 'middle'; color: string };

export interface Scene {
  width: number;
  height: number;
  title: string;
  ops: Op[];
}

const C = { ink: '#14213d', violet: '#6d57d6', teal: '#17a3ad', muted: '#5b6480', soft: '#4b5470', band: '#f4f5fa', line: '#d8dbe6', grey: '#9aa3bd', white: '#ffffff' };
const NODE_W = 208;
const MARGIN = 36;
const ROW_GAP = 26;
const PAD = 10;

let meter: InstanceType<typeof PDFDocument> | null = null;
/** Text width with the same Helvetica metrics the PDF uses (Arial/Helvetica in a browser are the same widths). */
export function textWidth(s: string, size: number, bold: boolean): number {
  meter ??= new PDFDocument({ autoFirstPage: false });
  return meter.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).widthOfString(s);
}

function fit(s: string, maxW: number, size: number, bold: boolean): string {
  if (textWidth(s, size, bold) <= maxW) return s;
  let t = s;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function wrapText(text: string, maxW: number, size: number, bold: boolean, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ').filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (!cur || textWidth(next, size, bold) <= maxW) cur = next;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, maxLines).map((l) => fit(l, maxW, size, bold));
  if (lines.length > maxLines) out[maxLines - 1] = fit(`${out[maxLines - 1]!.replace(/…$/, '')}…`, maxW, size, bold);
  return out;
}

interface Box {
  node: PlanNode;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string[];
  detail: string[];
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Side = 'L' | 'R' | 'T' | 'B';

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Turns a plan into drawing instructions. Columns run left to right in the plan's order; boxes of the "control" lane sit in a band below. */
export function layout(plan: DiagramPlan): Scene {
  const n = plan.columns.length;
  const boxes = new Map<string, Box>();
  const order = new Map<string, number>(); // top-to-bottom position inside the column (path boxes, then control boxes)
  const stacks = plan.columns.map((c, col) => {
    const mk = (lane: 'path' | 'control') =>
      c.nodes
        .filter((nd) => nd.lane === lane)
        .map((node) => {
          const label = wrapText(node.label, NODE_W - 2 * PAD - 4, 15, true, 3);
          const detail = node.detail ? wrapText(node.detail, NODE_W - 2 * PAD - 4, 12, false, 4) : [];
          const h = Math.max(48, PAD + 12 + (label.length - 1) * 18 + (detail.length ? 17 + (detail.length - 1) * 15 : 0) + 4 + PAD);
          const b: Box = { node, col, x: 0, y: 0, w: NODE_W, h, label, detail };
          boxes.set(node.id, b);
          return b;
        });
    const path = mk('path');
    const control = mk('control');
    [...path, ...control].forEach((b, i) => order.set(b.node.id, i));
    return { path, control };
  });
  const stackH = (l: Box[]) => (l.length ? l.reduce((s, b) => s + b.h, 0) + ROW_GAP * (l.length - 1) : 0);
  const pathH = Math.max(...stacks.map((s) => stackH(s.path)), 48);
  const ctrlH = Math.max(...stacks.map((s) => stackH(s.control)), 0);
  const hasControl = ctrlH > 0;

  const lw = (lines: string[]) => Math.max(0, ...lines.map((l) => textWidth(l, 11.5, false))) + 10;
  const lh = (lines: string[]) => lines.length * 14 + 6;

  // ---- classify the arrows
  type Kind = 'vert' | 'gutter' | 'cross' | 'near' | 'skip';
  interface Edge {
    link: PlanLink;
    a: Box;
    b: Box;
    kind: Kind;
    lines: string[];
    sa: Side;
    sb: Side;
    /** The label sits on the stretch next to the end that has fewer arrows, so labels of arrows that fan in or out do not pile up. */
    atSource: boolean;
  }
  const edges: Edge[] = plan.links.map((link) => {
    const a = boxes.get(link.from)!;
    const b = boxes.get(link.to)!;
    const kind: Kind =
      a.col === b.col
        ? Math.abs(order.get(a.node.id)! - order.get(b.node.id)!) > 1
          ? 'gutter' // another box sits between them: go round it on the left
          : 'vert'
        : a.node.lane !== b.node.lane
          ? 'cross'
          : Math.abs(a.col - b.col) === 1
            ? 'near'
            : 'skip';
    let sa: Side;
    let sb: Side;
    if (kind === 'vert') {
      sa = order.get(a.node.id)! < order.get(b.node.id)! ? 'B' : 'T';
      sb = sa === 'B' ? 'T' : 'B';
    } else if (kind === 'gutter') {
      sa = 'L';
      sb = 'L';
    } else if (kind === 'cross') {
      sa = a.node.lane === 'path' ? 'B' : 'T';
      sb = sa === 'B' ? 'T' : 'B';
    } else {
      sa = b.col > a.col ? 'R' : 'L';
      sb = sa === 'R' ? 'L' : 'R';
    }
    return { link, a, b, kind, lines: link.label ? wrapText(link.label, 150, 11.5, false, 3) : [], sa, sb, atSource: true };
  });
  const skipGaps = (e: Edge): [number, number] => (e.b.col > e.a.col ? [e.a.col, e.b.col - 1] : [e.a.col - 1, e.b.col]);

  // ---- gaps between columns: wide enough for the widest label and for one lane per arrow
  const gapCount = new Array<number>(Math.max(0, n - 1)).fill(0);
  const gapLabel = new Array<number>(Math.max(0, n - 1)).fill(0);
  for (const e of edges) {
    if (e.kind === 'near') {
      const g = Math.min(e.a.col, e.b.col);
      gapCount[g]!++;
      gapLabel[g] = Math.max(gapLabel[g]!, lw(e.lines));
    } else if (e.kind === 'skip') {
      for (const g of skipGaps(e)) gapCount[g]!++;
    } else if (e.kind === 'gutter' && e.a.col > 0) {
      gapCount[e.a.col - 1]!++;
      gapLabel[e.a.col - 1] = Math.max(gapLabel[e.a.col - 1]!, lw(e.lines));
    }
  }
  const gaps = gapCount.map((cnt, g) => Math.min(260, Math.max(64, (gapLabel[g]! ? gapLabel[g]! + 34 : 30) + 9 * cnt)));
  const colX: number[] = [];
  for (let i = 0; i < n; i++) colX.push(i === 0 ? MARGIN : colX[i - 1]! + NODE_W + gaps[i - 1]!);
  const width = colX[n - 1]! + NODE_W + MARGIN;

  const skipPath = edges.filter((e) => e.kind === 'skip' && e.a.node.lane === 'path').length;
  const skipCtrl = edges.filter((e) => e.kind === 'skip' && e.a.node.lane === 'control').length;
  const crossN = edges.filter((e) => e.kind === 'cross').length;

  const titleY = MARGIN + 24;
  const headY = titleY + 34;
  const pathTop = headY + 18 + (skipPath ? 16 + 26 * skipPath : 8);
  const pathBottom = pathTop + pathH;
  const bandGap = hasControl ? 74 + 12 * Math.min(crossN, 8) : 0;
  const ctrlTop = pathBottom + bandGap;
  const ctrlBottom = ctrlTop + ctrlH;
  const height = (hasControl ? ctrlBottom + 16 + (skipCtrl ? 16 + 26 * skipCtrl : 0) : pathBottom) + MARGIN;

  // ---- positions
  for (let c = 0; c < n; c++) {
    const place = (list: Box[], top: number, bandH: number) => {
      let y = top + (bandH - stackH(list)) / 2;
      for (const b of list) {
        b.x = colX[c]!;
        b.y = y;
        y += b.h + ROW_GAP;
      }
    };
    place(stacks[c]!.path, pathTop, pathH);
    place(stacks[c]!.control, ctrlTop, ctrlH);
  }

  // ---- ports: arrows on one side of a box leave in the order of where they go, so they do not cross each other
  interface PortItem {
    e: number;
    end: 'a' | 'b';
    other: number;
  }
  const groups = new Map<string, { box: Box; side: Side; items: PortItem[] }>();
  const gkey = (b: Box, s: Side) => `${b.node.id}\u0000${s}`;
  const add = (box: Box, side: Side, e: number, end: 'a' | 'b', other: Box) => {
    let g = groups.get(gkey(box, side));
    if (!g) groups.set(gkey(box, side), (g = { box, side, items: [] }));
    g.items.push({ e, end, other: side === 'L' || side === 'R' ? other.y + other.h / 2 : other.x + other.w / 2 });
  };
  edges.forEach((e, i) => {
    add(e.a, e.sa, i, 'a', e.b);
    if (e.kind !== 'vert') add(e.b, e.sb, i, 'b', e.a);
  });
  const ports = new Map<string, [number, number]>();
  for (const g of groups.values()) {
    g.items.sort((p, q) => p.other - q.other || p.e - q.e);
    const horizontal = g.side === 'L' || g.side === 'R';
    const span = (horizontal ? g.box.h : g.box.w) / 2 - 10;
    const step = g.items.length > 1 ? Math.min(horizontal ? 10 : 14, (2 * span) / (g.items.length - 1)) : 0;
    const b = g.box;
    g.items.forEach((it, idx) => {
      const off = (idx - (g.items.length - 1) / 2) * step;
      const pos: [number, number] =
        g.side === 'L' ? [b.x, b.y + b.h / 2 + off] : g.side === 'R' ? [b.x + b.w, b.y + b.h / 2 + off] : g.side === 'T' ? [b.x + b.w / 2 + off, b.y] : [b.x + b.w / 2 + off, b.y + b.h];
      ports.set(`${it.e}:${it.end}`, pos);
    });
  }
  const P = (e: number, end: 'a' | 'b') => ports.get(`${e}:${end}`)!;
  for (const e of edges) if (e.kind === 'near' || e.kind === 'skip') e.atSource = groups.get(gkey(e.a, e.sa))!.items.length <= groups.get(gkey(e.b, e.sb))!.items.length;

  // ---- vertical runs inside the gaps: one lane per arrow; the arrow that travels furthest takes the lane nearest its home end (nested, no crossings)
  interface VReq {
    e: number;
    tag: string;
    g: number;
    home: 'L' | 'R';
    dy: number;
  }
  const reqs: VReq[] = [];
  edges.forEach((e, i) => {
    const fwd = e.b.col > e.a.col;
    if (e.kind === 'near') {
      const dy = Math.abs(P(i, 'a')[1] - P(i, 'b')[1]);
      if (dy >= 0.5) reqs.push({ e: i, tag: 'v', g: Math.min(e.a.col, e.b.col), home: (fwd ? e.atSource : !e.atSource) ? 'R' : 'L', dy });
    } else if (e.kind === 'skip') {
      const [g1, g2] = skipGaps(e);
      reqs.push({ e: i, tag: 'v1', g: g1, home: fwd ? 'L' : 'R', dy: 1e6 }, { e: i, tag: 'v2', g: g2, home: fwd ? 'R' : 'L', dy: 1e6 });
    } else if (e.kind === 'gutter' && e.a.col > 0) {
      reqs.push({ e: i, tag: 'v', g: e.a.col - 1, home: 'R', dy: 2e6 });
    }
  });
  const vx = new Map<string, number>();
  const lanes = new Map<string, VReq[]>();
  for (const r of reqs) lanes.set(`${r.g}${r.home}`, [...(lanes.get(`${r.g}${r.home}`) ?? []), r]);
  for (const list of lanes.values()) {
    list.sort((p, q) => q.dy - p.dy || p.e - q.e);
    list.forEach((r, s) => {
      const left = colX[r.g]! + NODE_W;
      vx.set(`${r.e}:${r.tag}`, r.home === 'R' ? left + gaps[r.g]! - 18 - s * 9 : left + 18 + s * 9);
    });
  }

  // ---- route every arrow
  const lines: Op[] = [];
  const arrows: Op[] = [];
  const halos: Op[] = [];
  const halotexts: Op[] = [];
  const placed: Rect[] = [];
  let crossSlot = 0;
  let topSlot = 0;
  let botSlot = 0;
  let leftSlot = 0;

  /** A label sits on its arrow; if that spot is taken by another label it slides along the arrow, or, failing that, stays put. */
  const put = (center: [number, number], text: string[], along: 'x' | 'y', lo: number, hi: number) => {
    const w = lw(text);
    const h = lh(text);
    const commit = (cx: number, cy: number) => {
      const r = { x: cx - w / 2, y: cy - h / 2, w, h };
      placed.push(r);
      halos.push({ t: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, r: 3, fill: C.white });
      text.forEach((l, i) => halotexts.push({ t: 'text', x: cx, y: r.y + 3 + 11 + i * 14, text: l, size: 11.5, bold: false, anchor: 'middle', color: C.ink }));
    };
    for (const k of [0, 1, -1, 2, -2]) {
      const d = k * ((along === 'y' ? h : w) + 4);
      const cx = along === 'x' ? center[0] + d : center[0];
      const cy = along === 'y' ? center[1] + d : center[1];
      if (k !== 0 && (along === 'x' ? cx : cy) < lo) continue;
      if (k !== 0 && (along === 'x' ? cx : cy) > hi) continue;
      if (placed.some((p) => overlaps(p, { x: cx - w / 2, y: cy - h / 2, w, h }))) continue;
      return commit(cx, cy);
    }
    commit(center[0], center[1]);
  };

  edges.forEach((e, i) => {
    const pa = P(i, 'a');
    let pts: [number, number][];
    if (e.kind === 'vert') {
      const yb = e.sb === 'T' ? e.b.y : e.b.y + e.b.h;
      pts = [pa, [pa[0], yb]];
      if (e.lines.length) put([pa[0] + 8 + lw(e.lines) / 2, (pa[1] + yb) / 2], e.lines, 'y', Math.min(pa[1], yb), Math.max(pa[1], yb));
    } else if (e.kind === 'gutter') {
      const pb = P(i, 'b');
      const xg = e.a.col > 0 ? vx.get(`${i}:v`)! : Math.max(8, MARGIN - 14 - 9 * leftSlot++);
      pts = [pa, [xg, pa[1]], [xg, pb[1]], pb];
      if (e.lines.length && e.a.col > 0) {
        const w = lw(e.lines);
        const gl = colX[e.a.col - 1]! + NODE_W;
        put([Math.max(gl + w / 2 + 2, Math.min(colX[e.a.col]! - w / 2 - 2, xg)), (pa[1] + pb[1]) / 2], e.lines, 'y', Math.min(pa[1], pb[1]), Math.max(pa[1], pb[1]));
      }
    } else if (e.kind === 'cross') {
      const pb = P(i, 'b');
      const yc = pathBottom + 20 + 12 * crossSlot++;
      pts = [pa, [pa[0], yc], [pb[0], yc], pb];
      if (e.lines.length) put([(pa[0] + pb[0]) / 2, yc], e.lines, 'x', Math.min(pa[0], pb[0]), Math.max(pa[0], pb[0]));
    } else if (e.kind === 'near') {
      const pb = P(i, 'b');
      if (Math.abs(pa[1] - pb[1]) < 0.5) {
        pts = [pa, [pb[0], pa[1]]];
        if (e.lines.length) put([(pa[0] + pb[0]) / 2, pa[1]], e.lines, 'x', Math.min(pa[0], pb[0]), Math.max(pa[0], pb[0]));
      } else {
        const xv = vx.get(`${i}:v`)!;
        pts = [pa, [xv, pa[1]], [xv, pb[1]], pb];
        if (e.lines.length) {
          const [from, to, y] = e.atSource ? [pa[0], xv, pa[1]] : [xv, pb[0], pb[1]];
          put([(from + to) / 2, y], e.lines, 'x', Math.min(from, to), Math.max(from, to));
        }
      }
    } else {
      const pb = P(i, 'b');
      const x1 = vx.get(`${i}:v1`)!;
      const x2 = vx.get(`${i}:v2`)!;
      const yc = e.a.node.lane === 'path' ? pathTop - 22 - 26 * topSlot++ : ctrlBottom + 24 + 26 * botSlot++;
      pts = [pa, [x1, pa[1]], [x1, yc], [x2, yc], [x2, pb[1]], pb];
      if (e.lines.length) put([(x1 + x2) / 2, yc], e.lines, 'x', Math.min(x1, x2), Math.max(x1, x2));
    }
    // the line stops where the arrowhead begins
    const end = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    const dx = Math.sign(end[0] - prev[0]);
    const dy = Math.sign(end[1] - prev[1]);
    arrows.push({ t: 'arrow', color: C.ink, pts: [end, [end[0] - dx * 10 - dy * 5, end[1] - dy * 10 + dx * 5], [end[0] - dx * 10 + dy * 5, end[1] - dy * 10 - dx * 5]] });
    lines.push({ t: 'path', pts: [...pts.slice(0, -1), [end[0] - dx * 9, end[1] - dy * 9]], dash: e.link.dashed, color: C.ink });
  });

  // ---- assemble in drawing order: band, arrows, labels, boxes, text
  const scene: Op[] = [];
  if (hasControl) {
    scene.push({ t: 'rect', x: MARGIN - 14, y: ctrlTop - 28, w: width - 2 * MARGIN + 28, h: ctrlH + 28 + 14, r: 12, fill: C.band, stroke: C.line, sw: 1 });
    scene.push({ t: 'text', x: MARGIN, y: ctrlTop - 11, text: 'MANAGEMENT AND CONTROL', size: 10.5, bold: true, anchor: 'start', color: C.muted });
  }
  scene.push(...lines, ...arrows, ...halos);
  for (const b of boxes.values()) {
    const accent = b.node.lane === 'control' ? C.grey : b.col % 2 === 0 ? C.teal : C.violet;
    scene.push({ t: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, r: 10, fill: C.white, stroke: C.ink, sw: 2 });
    scene.push({ t: 'rect', x: b.x + b.w * 0.29, y: b.y - 3, w: b.w * 0.42, h: 6, r: 3, fill: accent });
  }
  scene.push({ t: 'text', x: MARGIN, y: titleY, text: fit(plan.title, width - 2 * MARGIN, 26, true), size: 26, bold: true, anchor: 'start', color: C.ink });
  plan.columns.forEach((c, i) => {
    if (c.title) scene.push({ t: 'text', x: colX[i]! + NODE_W / 2, y: headY, text: fit(c.title.toUpperCase(), NODE_W + (gaps[Math.min(i, gaps.length - 1)] ?? 60) * 0.5, 11, true), size: 11, bold: true, anchor: 'middle', color: C.muted });
  });
  for (const b of boxes.values()) {
    let y = b.y + PAD + 12;
    for (const l of b.label) {
      scene.push({ t: 'text', x: b.x + b.w / 2, y, text: l, size: 15, bold: true, anchor: 'middle', color: C.ink });
      y += 18;
    }
    y += -18 + 17;
    for (const l of b.detail) {
      scene.push({ t: 'text', x: b.x + b.w / 2, y, text: l, size: 12, bold: false, anchor: 'middle', color: C.soft });
      y += 15;
    }
  }
  scene.push(...halotexts);
  return { width: Math.round(width), height: Math.round(height), title: plan.title, ops: scene };
}

// ----------------------------------------------------------------------------
// Drawing
// ----------------------------------------------------------------------------
const f = (v: number) => String(Math.round(v * 10) / 10);
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The picture the page shows. Pure drawing instructions: no scripts, no links, no external files. */
export function renderSvg(scene: Scene, plan: DiagramPlan): string {
  const desc = plan.columns.map((c) => `${c.title || 'Column'}: ${c.nodes.map((nd) => nd.label).join(', ')}`).join('. ');
  const body = scene.ops.map((o) => {
    if (o.t === 'rect') return `<rect x="${f(o.x)}" y="${f(o.y)}" width="${f(o.w)}" height="${f(o.h)}" rx="${o.r}" fill="${o.fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"` : ''}/>`;
    if (o.t === 'path') return `<path d="M${o.pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(' L')}" fill="none" stroke="${o.color}" stroke-width="2" stroke-linejoin="round"${o.dash ? ' stroke-dasharray="7 5"' : ''}/>`;
    if (o.t === 'arrow') return `<polygon points="${o.pts.map((p) => `${f(p[0])},${f(p[1])}`).join(' ')}" fill="${o.color}"/>`;
    return `<text x="${f(o.x)}" y="${f(o.y)}" font-size="${o.size}"${o.bold ? ' font-weight="700"' : ''}${o.anchor === 'middle' ? ' text-anchor="middle"' : ''} fill="${o.color}">${xml(o.text)}</text>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}" role="img" aria-labelledby="t d" font-family="Helvetica, Arial, 'Liberation Sans', sans-serif">`,
    `<title id="t">${xml(plan.title)} - architecture diagram</title><desc id="d">${xml(desc)}</desc>`,
    `<rect width="${scene.width}" height="${scene.height}" fill="#ffffff"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

/** The same picture as vectors inside a PDF page, at `scale`, with its top-left corner at (x0, y0). */
export function drawScene(doc: InstanceType<typeof PDFDocument>, scene: Scene, x0: number, y0: number, scale: number): void {
  doc.save();
  doc.translate(x0, y0).scale(scale);
  for (const o of scene.ops) {
    if (o.t === 'rect') {
      doc.roundedRect(o.x, o.y, o.w, o.h, o.r).lineWidth(o.sw ?? 1);
      if (o.stroke) doc.fillAndStroke(o.fill, o.stroke);
      else doc.fill(o.fill);
    } else if (o.t === 'path') {
      doc.lineWidth(2).lineJoin('round');
      if (o.dash) doc.dash(7, { space: 5 });
      doc.moveTo(o.pts[0]![0], o.pts[0]![1]);
      for (const p of o.pts.slice(1)) doc.lineTo(p[0], p[1]);
      doc.stroke(o.color);
      if (o.dash) doc.undash();
    } else if (o.t === 'arrow') {
      doc.polygon(...o.pts).fill(o.color);
    } else {
      doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size).fillColor(o.color);
      const w = o.anchor === 'middle' ? doc.widthOfString(o.text) / 2 : 0;
      doc.text(o.text, o.x - w, o.y - o.size * 0.718, { lineBreak: false });
    }
  }
  doc.restore();
}
