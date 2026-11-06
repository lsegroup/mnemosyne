import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATE, generateRoles, levelKey, mayGenerate } from '../src/settings-store.js';

describe('who may generate documentation and pictures', () => {
  it('maps the GitLab access levels to the switches', () => {
    expect([5, 10, 15, 20, 30, 40, 50].map(levelKey)).toEqual(['guest', 'guest', 'guest', 'reporter', 'developer', 'maintainer', 'owner']);
  });

  it('starts with administrators and owners, nobody else', () => {
    expect(generateRoles({})).toEqual(DEFAULT_GENERATE);
    expect(DEFAULT_GENERATE).toEqual({ admin: true, owner: true, maintainer: false, developer: false, reporter: false, guest: false });
  });

  it('takes the saved switches over the defaults, and ignores anything that is not a boolean', () => {
    expect(generateRoles({ generate: { maintainer: true, owner: false } })).toEqual({ ...DEFAULT_GENERATE, maintainer: true, owner: false });
    expect(generateRoles({ generate: { developer: 'yes' as never, guest: 1 as never } })).toEqual(DEFAULT_GENERATE);
  });

  it('allows a person if any of their grants is on; an unknown level counts as no level', () => {
    const roles = generateRoles({});
    expect(mayGenerate(roles, { admin: true }, undefined)).toBe(true);
    expect(mayGenerate(roles, { admin: false }, 50)).toBe(true);
    expect(mayGenerate(roles, { admin: false }, 40)).toBe(false);
    expect(mayGenerate(roles, { admin: false }, undefined)).toBe(false);
    expect(mayGenerate(roles, { admin: false }, 0)).toBe(false);
    const noAdmin = generateRoles({ generate: { admin: false } });
    expect(mayGenerate(noAdmin, { admin: true }, undefined)).toBe(false);
    expect(mayGenerate(noAdmin, { admin: true }, 50)).toBe(true); // an administrator who also owns the project
    expect(mayGenerate(generateRoles({ generate: { guest: true } }), { admin: false }, 0)).toBe(false); // level 0 = GitLab told us nothing
  });
});
