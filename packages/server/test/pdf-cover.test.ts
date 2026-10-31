import { describe, expect, it } from 'vitest';
import { buildPdf } from '../src/pdf.js';
import { toPdfImage } from '../src/docgen.js';
import { LOGO_WEBP_BASE64 } from '../src/web-assets.js';

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex');
const make = async (logo?: Buffer) =>
  (await buildPdf({ title: 'centest', subtitle: 'GitLab project GCD-Group/CenTest', generatedAt: '2026-10-31T01:31:00.000Z', model: 'm', noteCount: 3, markdown: '## Overview\n\nText.', compress: false, logo })).toString('latin1');

describe('the cover of the project PDF', () => {
  it('spells the name Mnemosyne (not spaced capitals) and puts the logo into the right side of the purple band', async () => {
    const png = await toPdfImage({ bytes: Buffer.from(LOGO_WEBP_BASE64, 'base64'), mime: 'image/webp' });
    expect(png?.subarray(1, 4).toString()).toBe('PNG'); // the portal's logo converts to a PNG the PDF can hold
    const withLogo = await make(png!);
    expect(withLogo).toContain(hex('Mnemosyne'));
    expect(withLogo).not.toContain(hex('MNEMOSYNE'));
    expect(withLogo).toContain('/Subtype /Image'); // the picture (a transparent PNG is stored as image + mask)
    // drawn at the top of the page, inside the band (190 pt high) and in the RIGHT half of the page (595 pt wide), on the right margin
    const m = /([\d.]+) 0 0 (-?[\d.]+) ([\d.]+) ([\d.]+) cm\s+\/I\d+ Do/.exec(withLogo);
    expect(m, 'the logo is drawn on the cover').not.toBeNull();
    const [w, h, x, yBottom] = [Number(m![1]), Math.abs(Number(m![2])), Number(m![3]), Number(m![4])];
    expect(yBottom - h).toBeGreaterThanOrEqual(0); // top edge on the page
    expect(yBottom).toBeLessThan(190); // inside the purple band
    expect(x).toBeGreaterThan(595 / 2);
    expect(x + w).toBeLessThanOrEqual(595 - 62 + 0.5); // not beyond the right margin
    expect(w).toBeGreaterThan(100);
  });

  it('builds the same cover without a logo, and an unreadable logo never stops the PDF', async () => {
    const without = await make();
    expect(without).toContain(hex('Mnemosyne'));
    expect(without).not.toContain('/Subtype /Image');
    const broken = await make(Buffer.from('not an image'));
    expect(broken.startsWith('%PDF-')).toBe(true);
    expect(broken).toContain(hex('Mnemosyne'));
  });
});
