import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedLookup, setHostPins } from '../src/host-pins.js';
import { requestOnce } from '../src/llm-call-chat.js';

const lookup = (host: string, all: boolean) =>
  new Promise<unknown>((resolve, reject) => pinnedLookup(host, { all, family: 0 }, (err, address, family) => (err ? reject(err) : resolve(all ? address : [address, family]))));

describe('fixed addresses (host name -> IP)', () => {
  afterEach(() => setHostPins([]));

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

});
