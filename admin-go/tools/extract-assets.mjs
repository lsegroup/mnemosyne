// SPDX-License-Identifier: Apache-2.0
// Writes the data the Go admin takes from the Node build (the AI job definitions with their built-in prompts, the version line, the
// Helvetica metrics and the PDF text table) into internal/assets, for the Go server to embed.
//
// The admin page (admin.html) and the admin sign-in page (login.html) are NOT made here any more: since the admin moved to Go they
// are the Go program's own sources in internal/assets, and the Node repository no longer contains an admin.
//
// Run from the repository root after building the Node repository (npm run build):
//   MNEMOSYNE_NODE_DIST=../packages/server/dist node tools/extract-assets.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve(process.env.MNEMOSYNE_NODE_DIST ?? '../packages/server/dist');
const imp = (f) => import(pathToFileURL(`${dist}/${f}`).href);
const jobs = await imp('ai-jobs.js');
const ver = await imp('version.js');

const out = new URL('../internal/assets/', import.meta.url);
mkdirSync(out, { recursive: true });
const write = (name, text) => writeFileSync(new URL(name, out), text);

// ---- the job definitions (names, texts, placeholders and the built-in prompts) ------------------------------------
write(
  'jobdefs.json',
  `${JSON.stringify({ defs: jobs.JOB_DEFS, maxOutputTokens: jobs.MAX_OUTPUT_TOKENS, reasoningEfforts: jobs.REASONING_EFFORTS }, null, 2)}\n`,
);

// ---- Helvetica metrics: the text width of the diagrams is measured exactly as the PDF library measures it ----------------------
const requireFromNode = (await import('node:module')).createRequire(pathToFileURL(`${dist}/`).href);
const PDFDocument = requireFromNode('pdfkit');
const meter = new PDFDocument({ autoFirstPage: false });
const afm = {};
for (const name of ['Helvetica', 'Helvetica-Bold']) {
  const font = meter.font(name)._font.font; // the AFM font: glyph widths and kerning pairs
  const glyphOf = {};
  for (let code = 0; code < 65536; code++) {
    const g = font.characterToGlyph(code);
    if (g !== '.notdef') glyphOf[code] = g;
  }
  const kern = {};
  for (const [pair, amount] of Object.entries(font.kernPairs)) {
    const [l, r] = pair.split('\0');
    (kern[l] ??= {})[r] = amount;
  }
  afm[name] = { glyphOf, widths: font.glyphWidths, kern };
}
write('afm.json', JSON.stringify(afm));

// ---- pdfText: which characters the diagrams keep, and which they replace (everything else becomes "?") ------------------------------
const pdf = await imp('pdf.js');
const allowed = [];
const replace = {};
for (let code = 0; code < 0x10000; code++) {
  if (code >= 0xd800 && code <= 0xdfff) continue;
  const ch = String.fromCodePoint(code);
  const out = pdf.pdfText(ch);
  if (out === ch) allowed.push(code);
  else if (out !== '?') replace[code] = out;
}
if (pdf.pdfText(String.fromCodePoint(0x1f600)) !== '?') throw new Error('an astral character is expected to become "?"');
write('pdftext.json', JSON.stringify({ allowed, replace }));

write('meta.json', `${JSON.stringify({ version: ver.VERSION, shown: ver.shownVersion() }, null, 2)}\n`);
console.log('wrote internal/assets/{admin.html,login.html,jobdefs.json,meta.json,afm.json,pdftext.json}');
