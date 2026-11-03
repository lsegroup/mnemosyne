// Writes testdata/node-vectors.json with what the REAL Node implementation produces, so the Go code is tested against it.
// Run from the repository root: MNEMOSYNE_NODE_DIST=../packages/server/dist node testdata/gen/gen-vectors.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve(process.env.MNEMOSYNE_NODE_DIST ?? '../packages/server/dist');
const s = await import(pathToFileURL(`${dist}/secrets.js`).href);

const SECRET = 'a-test-secret-with-enough-length'; // a fixture, not a real secret
const keys = s.deriveKeys(SECRET);
const FAR = 4102444800; // 2100-01-01
const PAST = 946684800; // 2000-01-01

const session = { u: 'store', n: 'Example Admin', e: 'store@example.com', exp: FAR };
const token = s.signToken(keys.sign, session);
const [body, sig] = token.split('.');

const plain = ['hello', '', '{"dev":{"at":1,"admin":false,"projects":null}}', 'ümlauts, emoji \u{1F9E0} and "quotes"'];
const out = {
  secret: SECRET,
  encKeyHex: keys.enc.toString('hex'),
  signKeyHex: keys.sign.toString('hex'),
  sealed: plain.map((p) => ({ plaintext: p, sealed: s.seal(keys.enc, p) })),
  session: { payload: session, token },
  expired: s.signToken(keys.sign, { ...session, exp: PAST }),
  tamperedBody: `${Buffer.from(JSON.stringify({ ...session, u: 'attacker' })).toString('base64url')}.${sig}`,
  noExp: s.signToken(keys.sign, { u: 'store' }),
  password: { plain: 'correct horse battery staple', hash: s.hashPassword('correct horse battery staple') },
};
void body;
writeFileSync(new URL('../node-vectors.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log('wrote testdata/node-vectors.json');
