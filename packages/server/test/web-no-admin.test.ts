import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createWebPortal } from '../src/web.js';


describe('this server has no admin (the admin is a separate program in front of it)', () => {
  let tmp: string;
  let srv: Server;
  let base = '';

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mnemosyne-external-'));
    const app = express();
    app.use(express.json());
    const cfg = loadConfig({ MNEMOSYNE_REPO: tmp, MNEMOSYNE_SECRET: 'a-test-secret-with-enough-length', MNEMOSYNE_PUBLIC_URL: 'http://127.0.0.1:1' });
    const built = createWebPortal(cfg);
    app.use(cfg.http.basePath, built.router);
    await new Promise<void>((r) => (srv = app.listen(0, '127.0.0.1', r)));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}${cfg.http.basePath}`;
  });
  afterAll(async () => {
    srv?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('does not know /admin or its API; it starts no Auto scheduler and has no local admin account', async () => {
    for (const path of ['/admin', '/admin/', '/admin/api/providers', '/admin/api/auto', '/admin/auth/login']) {
      const res = await fetch(`${base}${path}`, { redirect: 'manual' });
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe('The admin is not part of this server.');
    }
    // the public side is untouched
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Mnemosyne');
  });
});

