import { describe, expect, it } from 'vitest';
import { outline, renderMarkdown } from '../src/markdown.js';

const article = ['Lead paragraph.', '## Features and how it works', 'text', '### Authentication', 'text', '#### Detail', '## Specifications', '### Components and versions', '```', '## not a heading', '```'].join('\n\n');

describe('headings of the generated article', () => {
  it('makes the main sections h2 and their sub-sections h3 (the page title is the h1), and the table of contents lists both with links', () => {
    const html = renderMarkdown(article, { article: true });
    expect(html).toContain('<h2 id="h-features-and-how-it-works">Features and how it works</h2>');
    expect(html).toContain('<h3 id="h-authentication">Authentication</h3>');
    expect(html).toContain('<h4 id="h-detail">Detail</h4>');
    expect(html).toContain('<h2 id="h-specifications">Specifications</h2>');
    expect(html).not.toContain('not a heading</h'); // a heading inside a code block is code
    const toc = outline(article, { article: true });
    expect(toc.map((t) => [t.level, t.text, t.id])).toEqual([
      [2, 'Features and how it works', 'h-features-and-how-it-works'],
      [3, 'Authentication', 'h-authentication'],
      [4, 'Detail', 'h-detail'],
      [2, 'Specifications', 'h-specifications'],
      [3, 'Components and versions', 'h-components-and-versions'],
    ]);
    // every outline entry points at a real id in the page
    for (const t of toc) expect(html).toContain(`id="${t.id}"`);
  });

  it('a stray title (#) is treated like a main section; notes keep the old shift (their # is h2)', () => {
    expect(outline('# Title\n\n## Section\n\n### Sub', { article: true }).map((t) => t.level)).toEqual([2, 2, 3]);
    expect(renderMarkdown('# Note title\n\n## Part')).toContain('<h2 id="h-note-title">');
    expect(renderMarkdown('# Note title\n\n## Part')).toContain('<h3 id="h-part">');
    expect(outline('# A\n\n## B').map((t) => t.level)).toEqual([2, 3]);
  });
});
