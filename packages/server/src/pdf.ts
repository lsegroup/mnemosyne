import PDFDocument from 'pdfkit';

/**
 * Project handbook PDF: cover page, index (contents with page numbers), the Markdown article, the
 * workflow diagram if one was made, bookmarks and page numbers. Pure JavaScript (pdfkit), no model
 * calls and no cost. Text is limited to what the built-in PDF fonts can show (Latin-1 + common
 * punctuation); other characters are replaced by close ASCII equivalents.
 */

export interface PdfInput {
  /** Project title shown on the cover and in the footer. */
  title: string;
  subtitle: string;
  generatedAt: string;
  model: string;
  noteCount: number;
  markdown: string;
  /**
   * The pictures, in page order (the overview first, then the detail pictures): each either a raster picture or a drawing painted as
   * vectors (sharp at any zoom, real text). Each gets a page of its own after the index.
   */
  diagrams?: {
    name: string;
    png?: Buffer;
    vector?: { width: number; height: number; draw: (doc: InstanceType<typeof PDFDocument>, x: number, y: number, scale: number) => void };
    caption: string;
  }[];
  /** The logo (PNG) for the right side of the cover's purple band; none = no logo. */
  logo?: Buffer;
  /** Tests turn compression off to read the text streams. */
  compress?: boolean;
}

const COLOURS = { violet: '#6d57d6', teal: '#17a3ad', ink: '#14161f', muted: '#6b7080', line: '#d8dbe6', code: '#f3f4f8' };
const M = { top: 64, bottom: 64, left: 62, right: 62 };
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const REPLACE: Record<string, string> = { '→': '->', '←': '<-', '↔': '<->', '≈': '~', '≥': '>=', '≤': '<=', '✓': 'OK', '✔': 'OK', '✗': 'x', '✘': 'x', '×': 'x', ' ': ' ', '‑': '-', '−': '-' };

export function pdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const r = REPLACE[ch];
    if (r !== undefined) out += r;
    else if (ch === '\n' || ch === '\t' || (ch >= ' ' && ch <= '~') || (ch >= '¡' && ch <= 'ÿ') || WINANSI_EXTRA.includes(ch)) out += ch;
    else out += '?';
  }
  return out;
}

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'li'; text: string; ordered: boolean; n: number }
  | { t: 'code'; text: string }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'table'; head: string[]; rows: string[][] };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      out.push({ t: 'code', text: code.join('\n') });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push({ t: 'table', head, rows });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      out.push({ t: 'li', text: (ul ? ul[1] : ol![2])!, ordered: !ul, n: ol ? Number(ol[1]) : 0 });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push({ t: 'quote', text: q.join(' ') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(\s*```|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>|\s*\|)/.test(lines[i]!)) para.push(lines[i++]!);
    out.push({ t: 'p', text: para.join(' ') });
  }
  return out;
}

/** `**bold**`, `*italic*`, `code` -> font runs. */
function runs(text: string): { text: string; font: 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Courier' }[] {
  const out: { text: string; font: 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Courier' }[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|(?:^|(?<=[\s(]))\*[^*\s][^*]*\*(?=$|[\s).,;:!?]))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), font: 'Helvetica' });
    const tok = m[0];
    if (tok.startsWith('**')) out.push({ text: tok.slice(2, -2), font: 'Helvetica-Bold' });
    else if (tok.startsWith('`')) out.push({ text: tok.slice(1, -1), font: 'Courier' });
    else out.push({ text: tok.slice(1, -1), font: 'Helvetica-Oblique' });
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), font: 'Helvetica' });
  return out.length ? out : [{ text: '', font: 'Helvetica' }];
}

const plain = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

export function buildPdf(input: PdfInput): Promise<Buffer> {
  const date = new Date(input.generatedAt);
  const dateText = `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
  const doc = new PDFDocument({
    size: 'A4',
    margins: M,
    bufferPages: true,
    compress: input.compress !== false,
    info: { Title: pdfText(`${input.title} - Project documentation`), Author: 'Mnemosyne', Subject: pdfText(input.subtitle), CreationDate: date },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = doc.page.width - M.left - M.right;
  const bottom = () => doc.page.height - M.bottom;
  const currentPage = () => doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;

  // Drop the article's own H1: the cover carries the title.
  let blocks = parseBlocks(input.markdown);
  if (blocks[0]?.t === 'h' && blocks[0].level === 1) blocks = blocks.slice(1);

  const entries: { level: number; text: string; page: number }[] = [];
  const tocCount = blocks.filter((b) => b.t === 'h' && b.level <= 3 && b.level >= 2).length + (input.diagrams?.length ?? 0);
  const tocPages = Math.max(1, Math.ceil(tocCount / 36));

  // ---- cover ----
  doc.rect(0, 0, doc.page.width, 190).fill(COLOURS.violet);
  doc.rect(0, 190, doc.page.width, 6).fill(COLOURS.teal);
  // the name is spelled Mnemosyne (not spaced capitals); the logo sits in the right side of the purple band
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(34).text('Mnemosyne', M.left, 66, { lineBreak: false });
  doc.font('Helvetica').fontSize(13).text('Self-hosted AI team memory', M.left, 112, { lineBreak: false });
  if (input.logo) {
    const logoW = 124;
    try {
      doc.image(input.logo, doc.page.width - M.right - logoW, 33, { width: logoW });
    } catch (err) {
      console.error('pdf: the cover logo could not be drawn:', (err as Error).message); // never stops the PDF
    }
  }
  doc.fillColor(COLOURS.ink).font('Helvetica-Bold').fontSize(34).text(pdfText(input.title), M.left, 250, { width: W });
  doc.moveDown(0.4).font('Helvetica').fontSize(17).fillColor(COLOURS.teal).text('Project documentation', { width: W });
  doc.moveDown(2).fontSize(11).fillColor(COLOURS.muted);
  doc.text(pdfText(`Generated ${dateText}`), { width: W });
  doc.text(pdfText(`Written from ${input.noteCount} project notes`), { width: W });
  if (input.model) doc.text(pdfText(`AI model: ${input.model}`), { width: W });
  if (input.subtitle) doc.moveDown(0.6).text(pdfText(input.subtitle), { width: W });
  doc.fontSize(9).fillColor(COLOURS.muted).text('This document was generated automatically from the project notes. Check important facts against the source.', M.left, doc.page.height - 110, { width: W });

  // ---- reserved index pages (filled once the page numbers are known) ----
  for (let i = 0; i < tocPages; i++) doc.addPage();

  // ---- content ---- (every page stays portrait A4; a wide drawing is turned a quarter turn so it runs up the whole page)
  doc.addPage();
  let outlineH2: ReturnType<typeof doc.outline.addItem> | null = null;
  const heading = (level: number, text: string) => {
    const size = level <= 2 ? 19 : level === 3 ? 14 : 12;
    if (doc.y + size * 3 > bottom()) doc.addPage();
    doc.moveDown(level <= 2 ? 0.9 : 0.5);
    if (doc.y + size * 3 > bottom()) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(size).fillColor(level <= 2 ? COLOURS.violet : COLOURS.teal).text(pdfText(plain(text)), M.left, doc.y, { width: W });
    if (level <= 2) {
      doc.moveTo(M.left, doc.y + 2).lineTo(M.left + W, doc.y + 2).lineWidth(0.6).strokeColor(COLOURS.line).stroke();
      doc.moveDown(0.5);
    } else doc.moveDown(0.2);
    if (level >= 2 && level <= 3) entries.push({ level, text: plain(text), page: currentPage() });
    if (level === 2) outlineH2 = doc.outline.addItem(pdfText(plain(text)));
    else if (level === 3) (outlineH2 ?? doc.outline).addItem(pdfText(plain(text)));
    doc.fillColor(COLOURS.ink);
  };

  /** Word-by-word layout so bold / italic / code runs flow on the same line (pdfkit's own continuation does not). */
  const inlineText = (text: string, opts: { size: number; indent?: number; colour?: string; width?: number }) => {
    const size = opts.size;
    const lh = size * 1.38;
    const x0 = M.left + (opts.indent ?? 0);
    const w = opts.width ?? W - (opts.indent ?? 0);
    let x = x0;
    let y = doc.y;
    const room = () => {
      if (y + lh > bottom()) {
        doc.addPage();
        y = doc.y;
      }
    };
    room();
    for (const r of runs(text)) {
      doc.font(r.font).fontSize(size).fillColor(r.font === 'Courier' ? '#7a3fb0' : (opts.colour ?? COLOURS.ink));
      for (const tok of pdfText(r.text).split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) {
          if (x > x0) x += doc.widthOfString(' ');
          continue;
        }
        const tw = doc.widthOfString(tok);
        if (x > x0 && x + tw > x0 + w) {
          y += lh;
          x = x0;
          room();
          doc.font(r.font).fontSize(size).fillColor(r.font === 'Courier' ? '#7a3fb0' : (opts.colour ?? COLOURS.ink));
        }
        doc.text(tok, x, y, { lineBreak: false });
        x += tw;
      }
    }
    doc.x = M.left;
    doc.y = y + lh;
  };

  for (const d of input.diagrams ?? []) {
    const v = d.vector;
    if (v && v.width / v.height >= 1.25) {
      // A wide drawing: the page is turned a quarter turn counter-clockwise (text reads bottom to top, the top of the picture is at
      // the left edge). Inside the turned frame the heading, the caption and the drawing are laid out like on a landscape page, but
      // the frame is as long as the whole page, so the picture is as large as it can be.
      const side = 24;
      const footer = 56;
      const frameW = doc.page.height - side - footer; // along the page height
      const frameH = doc.page.width - 2 * side; // across the page
      entries.push({ level: 2, text: d.name, page: currentPage() });
      doc.outline.addItem(pdfText(d.name));
      doc.save();
      doc.translate(side, doc.page.height - footer).rotate(-90);
      doc.font('Helvetica-Bold').fontSize(19).fillColor(COLOURS.violet).text(pdfText(d.name), 0, 0, { lineBreak: false });
      doc.moveTo(0, 27).lineTo(frameW, 27).lineWidth(0.6).strokeColor(COLOURS.line).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(COLOURS.muted).text(pdfText(d.caption), 0, 33, { lineBreak: false });
      const top = 54;
      const s = Math.min(frameW / v.width, (frameH - top) / v.height);
      v.draw(doc, (frameW - v.width * s) / 2, top, s);
      doc.restore();
    } else {
      heading(2, d.name);
      doc.font('Helvetica').fontSize(9).fillColor(COLOURS.muted).text(pdfText(d.caption), M.left, doc.y, { width: W });
      doc.moveDown(0.6);
      const space = bottom() - doc.y;
      if (v) {
        // the drawing may use almost the whole page width (text margins are for text)
        const side = 22;
        const pw = doc.page.width - 2 * side;
        const s = Math.min(pw / v.width, Math.max(150, space - 10) / v.height);
        v.draw(doc, side + (pw - v.width * s) / 2, doc.y, s);
      } else if (d.png) {
        doc.image(d.png, M.left, doc.y, { fit: [W, Math.max(200, space - 10)], align: 'center' });
      }
    }
    doc.addPage();
  }

  let listN = 0;
  for (const b of blocks) {
    if (b.t !== 'li') listN = 0;
    switch (b.t) {
      case 'h':
        heading(b.level, b.text);
        break;
      case 'p':
        inlineText(b.text, { size: 10.5 });
        doc.moveDown(0.6);
        break;
      case 'li': {
        listN = b.ordered ? (b.n || listN + 1) : 0;
        if (doc.y + 16 > bottom()) doc.addPage();
        const y = doc.y;
        doc.font('Helvetica').fontSize(10.5).fillColor(COLOURS.ink).text(b.ordered ? `${listN}.` : '•', M.left + 4, y, { width: 18, lineBreak: false });
        doc.x = M.left;
        doc.y = y;
        inlineText(b.text, { size: 10.5, indent: 22 });
        doc.moveDown(0.2);
        break;
      }
      case 'code': {
        const text = pdfText(b.text);
        doc.font('Courier').fontSize(8.5);
        const h = doc.heightOfString(text, { width: W - 16 }) + 14;
        if (h < bottom() - M.top) {
          if (doc.y + h > bottom()) doc.addPage();
          const y = doc.y;
          doc.roundedRect(M.left, y, W, h, 4).fill(COLOURS.code);
          doc.fillColor(COLOURS.ink).text(text, M.left + 8, y + 7, { width: W - 16 });
          doc.y = y + h;
        } else {
          doc.fillColor(COLOURS.ink).text(text, M.left, doc.y, { width: W });
        }
        doc.moveDown(0.7);
        break;
      }
      case 'quote': {
        const y = doc.y;
        inlineText(b.text, { size: 10.5, indent: 14, colour: COLOURS.muted });
        doc.rect(M.left, y, 2.5, Math.max(12, doc.y - y)).fill(COLOURS.violet);
        doc.fillColor(COLOURS.ink);
        doc.moveDown(0.6);
        break;
      }
      case 'hr':
        doc.moveDown(0.3).moveTo(M.left, doc.y).lineTo(M.left + W, doc.y).lineWidth(0.6).strokeColor(COLOURS.line).stroke();
        doc.moveDown(0.6);
        break;
      case 'table': {
        const cols = Math.max(1, b.head.length);
        const cw = W / cols;
        const drawRow = (cells: string[], head: boolean) => {
          doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
          const texts = Array.from({ length: cols }, (_, c) => pdfText(plain(cells[c] ?? '')));
          const h = Math.max(...texts.map((t) => doc.heightOfString(t, { width: cw - 10 }))) + 8;
          if (doc.y + h > bottom()) doc.addPage();
          const y = doc.y;
          texts.forEach((t, c) => {
            doc.rect(M.left + c * cw, y, cw, h).fillAndStroke(head ? '#eceaf9' : '#ffffff', COLOURS.line);
            doc.fillColor(COLOURS.ink).font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(t, M.left + c * cw + 5, y + 4, { width: cw - 10 });
          });
          doc.y = y + h;
        };
        drawRow(b.head, true);
        for (const r of b.rows) drawRow(r, false);
        doc.moveDown(0.7);
        break;
      }
    }
  }

  // ---- index (contents) on the reserved pages ----
  const all = entries; // the pictures were drawn before the article, so they come first in the order of the pages
  let entryIdx = 0;
  for (let p = 0; p < tocPages; p++) {
    doc.switchToPage(1 + p);
    doc.font('Helvetica-Bold').fontSize(24).fillColor(COLOURS.violet).text(p === 0 ? 'Contents' : 'Contents (continued)', M.left, M.top, { width: W });
    doc.moveTo(M.left, doc.y + 4).lineTo(M.left + W, doc.y + 4).lineWidth(0.8).strokeColor(COLOURS.teal).stroke();
    doc.y += 18;
    for (let n = 0; n < 36 && entryIdx < all.length; n++, entryIdx++) {
      const e = all[entryIdx]!;
      const y = doc.y;
      doc.font(e.level === 2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(e.level === 2 ? 11 : 10).fillColor(e.level === 2 ? COLOURS.ink : COLOURS.muted);
      doc.text(pdfText(e.text), M.left + (e.level === 3 ? 18 : 0), y, { width: W - 60, lineBreak: false, ellipsis: true });
      doc.text(String(e.page + 1), M.left, y, { width: W, align: 'right', lineBreak: false });
      doc.y = y + (e.level === 2 ? 18 : 15);
    }
  }

  // ---- footers: title, date stamp, page number (not on the cover) ----
  const total = doc.bufferedPageRange().count;
  for (let i = 1; i < total; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow writing below the normal text area without a page break
    doc.font('Helvetica').fontSize(8).fillColor(COLOURS.muted);
    const pw = doc.page.width - M.left - M.right; // a landscape page is wider than the others
    doc.text(pdfText(`${input.title} - Project documentation - ${dateText}`), M.left, doc.page.height - 40, { width: pw - 60, lineBreak: false });
    doc.text(`Page ${i + 1} of ${total}`, M.left, doc.page.height - 40, { width: pw, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }

  doc.flushPages();
  doc.end();
  return finished;
}
