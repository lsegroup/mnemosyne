import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MnemosyneService } from '../src/service.js';

let dir: string;
let svc: MnemosyneService;

beforeAll(async () => {
  process.env.MNEMOSYNE_EMBED_BACKEND = 'hash';
  dir = await mkdtemp(join(tmpdir(), 'mnemosyne-it-'));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'test');
  await git.commit('root', [], { '--allow-empty': null });

  const cfg = loadConfig(
    {
      MNEMOSYNE_REPO: dir,
      MNEMOSYNE_DB: join(dir, '.mnemosyne/index.db'),
      MNEMOSYNE_GIT_PUSH: 'false',
      MNEMOSYNE_EMBED_DIM: '256',
    },
    dir,
  );
  svc = await MnemosyneService.open(cfg);
});

afterAll(async () => {
  await svc?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('MnemosyneService end to end', () => {
  it('creates nodes, commits them, and indexes them', async () => {
    const a = await svc.createNode({
      title: 'WAF rule 55 caused smm-nodejs media upload 403s',
      type: 'gotcha',
      status: 'resolved',
      project: 'aequitas',
      components: ['waf', 'atl-lb-05'],
      body: 'Multipart boundary tripped OWASP CRS rule 55. Tuned the rule; uploads work again.',
    });
    expect(a.node.id).toContain('aequitas-');
    expect(a.commit).toBeTruthy();

    const b = await svc.createNode({
      id: 'waf-default-ruleset-too-strict',
      title: 'Default WAF ruleset is too strict for file uploads',
      type: 'decision',
      project: 'aequitas',
      body: 'We keep CRS in anomaly mode and tune per-endpoint rather than disabling paranoia levels.',
    });
    expect(b.node.id).toBe('waf-default-ruleset-too-strict');
  });

  it('finds a node by lexical and hybrid search', async () => {
    const text = await svc.search({ query: 'media upload 403', mode: 'text' });
    expect(text[0]?.node.project).toBe('aequitas');
    expect(text[0]?.matched.text).toBeDefined();

    const hybrid = await svc.search({ query: 'why did file uploads fail', mode: 'hybrid' });
    expect(hybrid.map((h) => h.node.id)).toContain(
      text[0]!.node.id,
    );
  });

  it('honours project/type filters', async () => {
    const decisions = await svc.search({ query: 'waf', type: 'decision' });
    expect(decisions.every((h) => h.node.type === 'decision')).toBe(true);
  });

  it('links nodes and walks neighbors', async () => {
    const [gotcha] = await svc.search({ query: 'rule 55', mode: 'text' });
    await svc.linkNodes(gotcha!.node.id, 'caused-by', 'waf-default-ruleset-too-strict');

    const n = await svc.neighbors(gotcha!.node.id, { depth: 1 });
    expect(n.nodes.map((x) => x.id)).toContain('waf-default-ruleset-too-strict');

    const back = await svc.neighbors('waf-default-ruleset-too-strict', { depth: 1 });
    expect(back.nodes.map((x) => x.id)).toContain(gotcha!.node.id);
  });

  it('attaches a code ref', async () => {
    const res = await svc.linkNodeToCode('waf-default-ruleset-too-strict', {
      repo: 'aequitas',
      path: 'rules/crs-setup.conf',
      line: 40,
      symbol_id: null,
    });
    expect(res.node.code_refs[0]).toMatchObject({ repo: 'aequitas', line: 40 });
  });

  it('exposes git history for a node', async () => {
    const hist = await svc.getHistory('waf-default-ruleset-too-strict');
    expect(hist.length).toBeGreaterThanOrEqual(2); // create + code ref
    expect(hist[0]?.message).toContain('memory:');
  });

  it('rebuilds the index from disk', async () => {
    const { count } = await svc.reindex();
    expect(count).toBe(2);
    const still = await svc.search({ query: 'media upload', mode: 'text' });
    expect(still.length).toBeGreaterThan(0);
  });
});
