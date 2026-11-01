import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docsNotFound, adminPage, loginPage, siteFooter } from '../src/web-pages.js';
import { VERSION, shownVersion } from '../src/version.js';

const pkg = (path: string) => (JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string }).version;

describe('the version of this release', () => {
  it('is one number everywhere: the code, every package.json and the packages that depend on each other', () => {
    expect(VERSION).toBe(pkg('../package.json'));
    expect(VERSION).toBe(pkg('../../core/package.json'));
    expect(VERSION).toBe(pkg('../../vscode-extension/package.json'));
    expect(VERSION).toBe(pkg('../../../package.json'));
    const deps = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }).dependencies;
    expect(deps['@mnemosyne/core']).toBe(VERSION);
  });

  it('is shown short: 0.6.0 as 0.6, a patch release in full', () => {
    expect(shownVersion('0.6.0')).toBe('0.6');
    expect(shownVersion('0.6.1')).toBe('0.6.1');
    expect(shownVersion('1.0.0')).toBe('1.0');
    expect(shownVersion('0.10.0')).toBe('0.10');
  });
});

describe('the line at the bottom of every page', () => {
  const year = new Date().getFullYear();
  const line = `${year} &copy; LSE Group Corporation <span aria-hidden="true">|</span>Version 0.6`;

  it('reads "2026 © LSE Group Corporation | Version 0.6", with the copyright sign between the year and the name', () => {
    expect(siteFooter(2026)).toBe('<div class="site-foot">2026 &copy; LSE Group Corporation <span aria-hidden="true">|</span>Version 0.6</div>');
  });

  it('is on the sign-in page, the admin page and the pages of the documentation area', () => {
    const user = { name: 'Olaf', username: 'olaf', admin: true } as never;
    expect(loginPage({ basePath: '/mnemosyne', configured: true, admin: false, local: false, sso: true })).toContain(line);
    expect(loginPage({ basePath: '/mnemosyne', configured: true, admin: true, local: true, sso: true })).toContain(line);
    expect(adminPage({ basePath: '/mnemosyne', nonce: 'n', user: { name: 'Olaf', username: 'olaf' }, redirectUris: [] } as never)).toContain(line);
    expect(docsNotFound('/mnemosyne', user, 'No such project')).toContain(line);
  });
});
