// Runs a scripted sequence of admin API calls against the REAL Node portal and prints every answer, so the Go test can run the same
// sequence against the Go admin and compare what the browser page would receive.
//   node testdata/gen/api.mjs <tmpdir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve(process.env.MNEMOSYNE_NODE_DIST ?? '../packages/server/dist');
const imp = (f) => import(pathToFileURL(`${dist}/${f}`).href);
const express = createRequire(pathToFileURL(`${dist}/`).href)('express');
const { loadConfig } = await imp('config.js');
const { createWebPortal } = await imp('web.js');
const tmp = process.argv[2];

const note = (project, id, observed, body) => {
  mkdirSync(`${tmp}/nodes/${project}`, { recursive: true });
  writeFileSync(`${tmp}/nodes/${project}/${id}.md`, `---\nid: ${id}\ntitle: Note ${id}\ntype: howto\nstatus: working\nproject: ${project}\ncomponents: [web]\nobserved_at: ${observed}\n---\n\n${body}\n`);
};
note('alpha', 'alpha-one', '2026-10-20', 'Alpha runs on :3000.');
note('alpha', 'alpha-two', '2026-10-21', 'More about alpha.');
note('beta', 'beta-one', '2026-10-22', 'Beta.');

const provider = createServer((req, res) => {
  if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'muse-spark-1.3-contributor' }, { id: 'models/other-model' }] }));
  else res.writeHead(404).end();
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const llm = `http://127.0.0.1:${provider.address().port}`;

const app = express();
app.use(express.json());
const web = createServer(app);
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${web.address().port}`;
const cfg = loadConfig({
  MNEMOSYNE_REPO: tmp, MNEMOSYNE_SECRET: 'a-test-secret-with-enough-length', MNEMOSYNE_PUBLIC_URL: origin,
  MNEMOSYNE_LOCAL_ADMIN_USER: 'Admin', MNEMOSYNE_LOCAL_ADMIN_PASSWORD: 'correct horse',
  MNEMOSYNE_GITLAB_URL: 'https://gitlab.example.com', MNEMOSYNE_GITLAB_CLIENT_ID: 'cid', MNEMOSYNE_GITLAB_CLIENT_SECRET: 'csecret-value-0123456789',
});
const built = createWebPortal(cfg);
app.use(cfg.http.basePath, built.router);
const base = `${origin}${cfg.http.basePath}`;

const login = await fetch(`${base}/admin/auth/local`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=Admin&password=correct+horse' });
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const api = async (method, path, body) => {
  const res = await fetch(`${base}/admin/api${path}`, { method, headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'mnemosyne-admin', origin }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const out = {};
const step = async (name, ...args) => (out[name] = await api(...args));

await step('create provider', 'POST', '/providers', { label: 'Fake LLM', kind: 'openai-compatible', baseUrl: `${llm}/v1/`, apiKey: 'sk-test-key-1234567890' });
const id = out['create provider'].body.id;
await step('models', 'POST', `/providers/${id}/models`);
await step('list', 'GET', '/providers');
await step('job text', 'PUT', '/llm/jobs/text', { model: { providerId: id, model: 'muse-spark-1.3-contributor' }, maxTokens: 12345, temperature: 0.2, reasoningEffort: 'low', timeoutMinutes: 7, userPrompt: 'Write about {{project}}:\n{{notes}}' });
await step('job image', 'PUT', '/llm/jobs/image', { model: { providerId: id, model: 'other-model' }, topP: 0.9 });
await step('jobs', 'GET', '/llm/jobs');
await step('assignments', 'PUT', '/llm/assignments', { text: { providerId: id, model: 'muse-spark-1.3-contributor' } });
await step('hosts', 'PUT', '/llm/hosts', { hosts: [{ host: 'API.example.com.', ip: '203.0.113.9' }] });
await step('hosts get', 'GET', '/llm/hosts');
await step('settings', 'GET', '/settings');
await step('settings put', 'PUT', '/settings', { gitlabUrl: 'https://gl.example.org/', clientId: 'app-id', clientSecret: 'a-long-secret-value-0123456789' });
await step('settings after', 'GET', '/settings');
await step('auto', 'GET', '/auto');
const plan = { config: { schedule: { mode: 'weekly', days: [1, 3, 5], time: '02:00', tz: 'Europe/Zurich' }, projects: ['beta', 'alpha'], text: true, charts: true, limitUsd: 1.5 } };
await step('estimate', 'POST', '/auto/estimate', plan);
await step('save', 'PUT', '/auto', { ...plan, token: out.estimate.body.token });
await step('status', 'GET', '/auto/status');
await step('switch off', 'PUT', '/auto/switch', { enabled: false });
await step('switch on', 'PUT', '/auto/switch', { enabled: true });
await step('refusal', 'PUT', '/llm/jobs/text', { maxTokens: 'many' });
await step('audit', 'GET', '/audit');
console.log(JSON.stringify({ llm, out }));
web.close();
provider.close();
