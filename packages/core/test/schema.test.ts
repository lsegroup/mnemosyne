import { describe, expect, it } from 'vitest';
import { parseMarkdown, toMarkdown, slugify } from '../src/schema.js';

const sample = `---
id: aequitas-waf-rule-55-false-positive
title: smm-nodejs media uploads 403 was WAF rule 55, not the app
type: gotcha
status: resolved
project: aequitas
components: [waf, atl-lb-05, smm-nodejs]
code_refs:
  - { repo: aequitas, path: rules/55.conf, line: 12 }
links:
  - { rel: caused-by, target: waf-default-ruleset-too-strict }
authors: [obecker@lumanet.info]
observed_at: 2026-08-20
---
The 403s on media upload were WAF rule 55 tripping on multipart boundaries,
not an application bug. Tuned the rule; uploads restored.
`;

describe('parseMarkdown', () => {
  it('parses frontmatter and body', () => {
    const node = parseMarkdown(sample);
    expect(node.id).toBe('aequitas-waf-rule-55-false-positive');
    expect(node.type).toBe('gotcha');
    expect(node.status).toBe('resolved');
    expect(node.components).toEqual(['waf', 'atl-lb-05', 'smm-nodejs']);
    expect(node.code_refs[0]).toMatchObject({ repo: 'aequitas', path: 'rules/55.conf', line: 12 });
    expect(node.code_refs[0]?.symbol_id).toBeNull();
    expect(node.links[0]).toEqual({ rel: 'caused-by', target: 'waf-default-ruleset-too-strict' });
    expect(node.body).toContain('WAF rule 55 tripping on multipart boundaries');
  });

  it('applies defaults for optional fields', () => {
    const node = parseMarkdown(`---
id: x-y
title: minimal
type: reference
project: x
---
body
`);
    expect(node.status).toBe('n/a');
    expect(node.components).toEqual([]);
    expect(node.links).toEqual([]);
    expect(node.observed_at).toBeNull();
    expect(node.supersedes).toBeNull();
  });

  it('rejects a bad id', () => {
    expect(() => parseMarkdown(`---\nid: Not A Slug\ntitle: t\ntype: gotcha\nproject: p\n---\nb\n`)).toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() => parseMarkdown(`---\nid: a-b\ntitle: t\ntype: nonsense\nproject: p\n---\nb\n`)).toThrow();
  });
});

describe('toMarkdown', () => {
  it('round-trips a node', () => {
    const node = parseMarkdown(sample);
    const reparsed = parseMarkdown(toMarkdown(node));
    expect(reparsed).toEqual({ ...node });
  });

  it('emits frontmatter keys in stable order', () => {
    const md = toMarkdown(parseMarkdown(sample));
    const keys = [...md.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys.slice(0, 5)).toEqual(['id', 'title', 'type', 'status', 'project']);
  });
});

describe('slugify', () => {
  it('builds a bounded kebab id from project + title', () => {
    const id = slugify('Aequitas', 'smm-nodejs media uploads 403 was WAF rule 55, not the app!');
    expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(id.startsWith('aequitas-')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(80);
  });
});
