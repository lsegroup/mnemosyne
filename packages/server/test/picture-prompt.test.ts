import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPicturePrompt, imagePriceUsd } from '../src/docgen.js';
import { sniffImage } from '../src/llm-call-image.js';

// The same plan and the same expected words are in admin-go/testdata/golden/picture-prompt.json: the Go engine (Auto) and this server must
// tell the image model exactly the same thing.
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'picture-prompt.json'), 'utf8')) as { plan: Parameters<typeof buildPicturePrompt>[0]; prompt: string };

describe('the prompt the image model gets for the workflow diagram', () => {
  it('gives it every box and every arrow with the exact words, and tells it to use no other', () => {
    expect(buildPicturePrompt(fixture.plan)).toBe(fixture.prompt);
  });

  it('names every box once, in the columns of the plan, and puts control boxes in the band below', () => {
    const p = buildPicturePrompt(fixture.plan);
    expect(p).toContain('Column 2 (small heading "App"): "Web app"; in a band below the main row, drawn with dashed arrows: "Admin \'console\'"');
    expect(p).toContain('Column 4 (small heading "Ops"): (no box in the main row)');
    expect(p).toContain('"Admin \'console\'" -> "PostgreSQL" (dashed)'); // a quotation mark inside a word cannot end the quoted word
    expect(p).toContain('spell every word EXACTLY');
  });

  // Owner 2026-11-01: "nowhere did I set a colour, and in a diagram the lines are horizontal or vertical, never curved"
  it('names no colour and no style of its own, and asks for straight horizontal and vertical lines only', () => {
    const p = buildPicturePrompt(fixture.plan);
    expect(p).not.toMatch(/\b(navy|dark|light|white|black|teal|violet|purple|blue|red|green|yellow|orange|grey|gray|gradient|glow|neon|colou?r)/i);
    expect(p).toContain('STRAIGHT line that runs only horizontally or vertically');
    expect(p).toContain('never curved, never diagonal');
  });

  it('uses the instruction the administrator wrote, with the title and the plan filled in', () => {
    const p = buildPicturePrompt(fixture.plan, 'Make "{{title}}" in pastel colours.\n{{plan}}\nBye.');
    expect(p.startsWith('Make "Shop \'main\'" in pastel colours.\nCOLUMNS AND BOXES:\nColumn 1')).toBe(true);
    expect(p.endsWith('\nBye.')).toBe(true);
    expect(buildPicturePrompt(fixture.plan, '   ')).toBe(fixture.prompt); // blank = the built-in instruction
  });

  it('knows the list price of muse-image-1.0 and no other', () => {
    expect(imagePriceUsd('muse-image-1.0')).toBe(0.01);
    expect(imagePriceUsd('some-other-image-model')).toBeNull();
  });

  it('reads the type of a picture from its bytes', () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]))).toBe('image/png');
    expect(sniffImage(Buffer.from('not a picture at all'))).toBeNull();
  });
});
