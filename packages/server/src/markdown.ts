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

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
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
      const level = Math.min(6, h[1]!.length + 1); // page title is h1; note headings start at h2
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
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
