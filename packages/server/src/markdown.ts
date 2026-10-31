import { esc } from './html.js';

/**
 * Small, safe markdown -> HTML for the documentation pages. Everything is HTML-escaped FIRST and
 * formatting is applied to the escaped text, so no markup from a note can reach the page. Links are
 * limited to http(s) and mnemosyne-internal anchors; there is no raw HTML, image or script support.
 */
function inline(text: string): string {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer nofollow">$1</a>');
  return s;
}

/** URL-safe id for a heading, unique within one document (used for the table of contents). */
export function headingId(text: string, seen: Map<string, number>): string {
  const base = 'h-' + (text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section');
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

export interface RenderOptions {
  /**
   * The generated project article has no title of its own (the page title is the h1) and uses '##' for its main sections and '###'
   * for their sub-sections: they become h2 and h3, and the table of contents lists them. Notes keep the default (their '#' is h2).
   */
  article?: boolean;
}

/** The html heading level of a markdown heading with this many '#'. */
const headingLevel = (hashes: number, opts?: RenderOptions) => (opts?.article ? Math.max(2, Math.min(6, hashes)) : Math.min(6, hashes + 1));

export function renderMarkdown(src: string, opts?: RenderOptions): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const ids = new Map<string, number>();
  let i = 0;
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // fenced code block
    if (/^\s*```/.test(line)) {
      closeList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!);
      i++; // closing fence
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    // table: header row + separator row
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      closeList();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        `<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = headingLevel(h[1]!.length, opts); // the page title is the h1
      out.push(`<h${level} id="${headingId(h[2]!, ids)}">${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`);
      i++;
      continue;
    }

    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      closeList();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    // paragraph: consecutive plain lines
    closeList();
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(\s*```|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>|\s*\|)/.test(lines[i]!)) para.push(lines[i++]!);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  closeList();
  return out.join('\n');
}

/** Headings (as rendered: h2 and below) with the same ids renderMarkdown gives them, for a table of contents. */
export function outline(src: string, opts?: RenderOptions): { level: number; text: string; id: string }[] {
  const ids = new Map<string, number>();
  const out: { level: number; text: string; id: string }[] = [];
  let fenced = false;
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) out.push({ level: headingLevel(h[1]!.length, opts), text: h[2]!.replace(/[*`]/g, ''), id: headingId(h[2]!, ids) });
  }
  return out;
}
