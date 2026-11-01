// The other direction: checks with the REAL Node implementation that what the Go code wrote can be read.
// Usage: node testdata/gen/verify-go.mjs <file written by the Go test>   (env MNEMOSYNE_NODE_DIST = packages/server/dist)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = resolve(process.env.MNEMOSYNE_NODE_DIST ?? '../packages/server/dist');
const s = await import(pathToFileURL(`${dist}/secrets.js`).href);
const g = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const keys = s.deriveKeys(g.secret);
const problems = [];
const check = (ok, what) => ok || problems.push(what);

check(keys.enc.toString('hex') === g.encKeyHex, 'enc key differs');
check(keys.sign.toString('hex') === g.signKeyHex, 'sign key differs');
for (const x of g.sealed) check(s.open(keys.enc, x.sealed) === x.plaintext, `Node cannot open Go-sealed ${JSON.stringify(x.plaintext)}`);
const payload = s.verifyToken(keys.sign, g.token);
check(payload && payload.u === g.session.u && payload.n === g.session.n && payload.e === g.session.e && payload.l === true, 'Node does not accept the Go token');
check(s.verifyToken(keys.sign, g.expired) === null, 'Node accepts an expired Go token');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('node accepts everything Go wrote');
