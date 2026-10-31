import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPin, MAX_PINS, pinnedLookup, setHostPins, validatePins } from '../src/host-pins.js';
import { requestOnce } from '../src/llm-call-chat.js';

const lookup = (host: string, all: boolean) =>
  new Promise<unknown>((resolve, reject) => pinnedLookup(host, { all, family: 0 }, (err, address, family) => (err ? reject(err) : resolve(all ? address : [address, family]))));

describe('fixed addresses (host name -> IP)', () => {
  afterEach(() => setHostPins([]));

  it('validates what the admin page sends and says what is wrong', () => {
    expect(validatePins([{ host: ' API.Meta.AI. ', ip: ' 57.144.64.141 ' }, { host: 'v6.example.com', ip: '2a03:2880:f31a:8d:face:b00c:0:2' }])).toEqual([
      { host: 'api.meta.ai', ip: '57.144.64.141' },
      { host: 'v6.example.com', ip: '2a03:2880:f31a:8d:face:b00c:0:2' },
    ]);
    expect(validatePins([])).toEqual([]);
    const bad: [unknown, RegExp][] = [
      ['api.meta.ai', /must be a list/],
      [[{ host: '', ip: '1.2.3.4' }], /host name is empty/],
      [[{ host: 'https://api.meta.ai/v1', ip: '1.2.3.4' }], /not a host name/],
      [[{ host: 'api.meta.ai:443', ip: '1.2.3.4' }], /not a host name/],
      [[{ host: '-bad-.example.com', ip: '1.2.3.4' }], /not a host name/],
      [[{ host: '1.2.3.4', ip: '5.6.7.8' }], /already an IP address/],
      [[{ host: 'api.meta.ai', ip: '' }], /IP address for api.meta.ai is empty/],
      [[{ host: 'api.meta.ai', ip: 'meta.ai' }], /not an IPv4 or IPv6 address/],
      [[{ host: 'api.meta.ai', ip: '999.1.1.1' }], /not an IPv4 or IPv6 address/],
      [[{ host: 'api.meta.ai', ip: '0.0.0.0' }], /cannot be connected to/],
      [[{ host: 'a.example.com', ip: '1.1.1.1' }, { host: 'A.EXAMPLE.com', ip: '2.2.2.2' }], /row 2: a.example.com is listed twice/],
      [Array.from({ length: MAX_PINS + 1 }, (_, i) => ({ host: `h${i}.example.com`, ip: '1.1.1.1' })), /at most 20/],
    ];
    for (const [input, re] of bad) expect(() => validatePins(input), JSON.stringify(input).slice(0, 60)).toThrow(re);
  });

  it('answers a pinned host from the pin (any letter case, trailing dot) in both shapes node asks for, and leaves other hosts to DNS', async () => {
    setHostPins([{ host: 'api.meta.ai', ip: '57.144.64.141' }, { host: 'v6.example.com', ip: '2a03:2880:f31a:8d:face:b00c:0:2' }]);
    expect(await lookup('API.meta.AI.', true)).toEqual([{ address: '57.144.64.141', family: 4 }]);
    expect(await lookup('api.meta.ai', false)).toEqual(['57.144.64.141', 4]);
    expect(await lookup('v6.example.com', true)).toEqual([{ address: '2a03:2880:f31a:8d:face:b00c:0:2', family: 6 }]);
    expect(((await lookup('localhost', true)) as { address: string }[]).some((a) => a.address === '127.0.0.1' || a.address === '::1')).toBe(true); // not pinned: the normal lookup
    setHostPins([]);
    const after = (await lookup('localhost', true)) as { address: string }[];
    expect(after.length).toBeGreaterThan(0);
  });

  it('is really used by the connection code: a name that DNS does not know is reached through its pin, and the pin can be taken away', async () => {
    let server!: Server;
    let hits = 0;
    await new Promise<void>((r) => {
      server = createServer((req, res) => {
        hits++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ host: req.headers.host }));
      }).listen(0, '127.0.0.1', r);
    });
    try {
      const url = `http://models.pinned.invalid:${(server.address() as AddressInfo).port}/v1/models`;
      setHostPins([{ host: 'models.pinned.invalid', ip: '127.0.0.1' }]);
      const res = await requestOnce(url, { method: 'GET' }, 5000);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ host: expect.stringMatching(/^models\.pinned\.invalid:/) }); // the request still names the host, only the address was pinned
      expect(hits).toBe(1);
      setHostPins([]);
      await expect(requestOnce(url, { method: 'GET' }, 5000)).rejects.toThrow(); // .invalid never resolves: without the pin there is no way to it
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  }, 20_000);

  it('checks an address without sending anything: a closed port is reported with its reason, quickly', async () => {
    const closed = await new Promise<number>((r) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => r(port));
      });
    });
    const r = await checkPin('api.meta.ai', '127.0.0.1', 3000, closed);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/ECONNREFUSED/);
    expect(r.ms).toBeLessThan(3000);
  });
});
