// Uses the REAL Node stores, so the Go tests can prove that both sides read each other's sealed files.
//   node testdata/gen/stores.mjs write <dir> <secret>   writes <dir>/providers.enc and <dir>/settings.enc, prints {id}
//   node testdata/gen/stores.mjs read  <dir> <secret>   reads them and prints what Node sees
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve(process.env.MNEMOSYNE_NODE_DIST ?? '../packages/server/dist');
const imp = (f) => import(pathToFileURL(`${dist}/${f}`).href);
const { ProviderStore } = await imp('provider-store.js');
const { SettingsStore } = await imp('settings-store.js');
const { deriveKeys } = await imp('secrets.js');

const [, , mode, dir, secret] = process.argv;
const keys = deriveKeys(secret);
const providers = new ProviderStore(`${dir}/providers.enc`, keys.enc);
const settings = new SettingsStore(`${dir}/settings.enc`, keys.enc);

if (mode === 'write') {
  const p = await providers.upsert({ label: 'Node LLM', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-from-node-0123456789' });
  await providers.setModels(p.id, ['m-a', 'm-b']);
  await providers.setJob('text', { providerId: p.id, model: 'm-b' }, { maxTokens: 4242, temperature: 0.3, reasoningEffort: 'low', timeoutMinutes: 7, userPrompt: 'Write {{notes}} now' });
  await providers.setJob('image', null, {});
  await providers.setHosts([{ host: 'api.example.com', ip: '203.0.113.4' }]);
  await settings.update((s) => {
    s.gitlab = { url: 'https://gl.example.com', clientId: 'cid', clientSecret: 'csecret-from-node' };
    s.ssoLiveAt = 1760000000;
  });
  console.log(JSON.stringify({ id: p.id }));
} else if (mode === 'read') {
  const list = await providers.list();
  const full = list.providers[0] ? await providers.getFull(list.providers[0].id) : null;
  console.log(JSON.stringify({ list, apiKey: full?.apiKey ?? null, hosts: await providers.getHosts(), settings: await settings.get() }));
} else {
  throw new Error('mode must be write or read');
}
