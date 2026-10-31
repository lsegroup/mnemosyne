/**
 * FIXED ADDRESSES (Admin -> LLM, step 2): a host name pinned to an IP address.
 *
 * When the DNS in front of an AI provider is unstable, an administrator can tell Mnemosyne which address a host name has. Every connection
 * Mnemosyne itself makes to such a provider (the AI calls and the model list) then goes straight to that address and DNS is not asked at all.
 * Only the lookup is replaced: the TLS certificate is still checked against the host name, so a wrong or hijacked address cannot be used
 * to listen in. It does not touch the operating system (/etc/hosts, the resolver) or anything else on the server. No model call is made here.
 */
import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { connect } from 'node:tls';
import { ProviderValidationError } from './provider-store.js';

export interface HostPin {
  host: string;
  ip: string;
}

export const MAX_PINS = 20;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export const normalizeHost = (h: string): string => h.trim().toLowerCase().replace(/\.$/, '');

/** Validates what the admin page sent: a list of {host, ip}. Throws a ProviderValidationError that says what is wrong. */
export function validatePins(input: unknown): HostPin[] {
  if (!Array.isArray(input)) throw new ProviderValidationError('hosts must be a list');
  if (input.length > MAX_PINS) throw new ProviderValidationError(`at most ${MAX_PINS} fixed addresses`);
  const seen = new Set<string>();
  return input.map((row, i) => {
    const n = i + 1;
    const r = (row ?? {}) as { host?: unknown; ip?: unknown };
    const host = typeof r.host === 'string' ? normalizeHost(r.host) : '';
    const ip = typeof r.ip === 'string' ? r.ip.trim() : '';
    if (!host) throw new ProviderValidationError(`row ${n}: the host name is empty`);
    if (host.length > 253 || !host.split('.').every((l) => LABEL.test(l))) throw new ProviderValidationError(`row ${n}: "${host}" is not a host name (letters, digits, dots and dashes only; no http://, no port, no path)`);
    if (isIP(host)) throw new ProviderValidationError(`row ${n}: "${host}" is already an IP address; put the host name there`);
    if (!ip) throw new ProviderValidationError(`row ${n}: the IP address for ${host} is empty`);
    if (!isIP(ip)) throw new ProviderValidationError(`row ${n}: "${ip}" is not an IPv4 or IPv6 address`);
    if (/^(0\.0\.0\.0|255\.255\.255\.255|::)$/.test(ip)) throw new ProviderValidationError(`row ${n}: ${ip} cannot be connected to`);
    if (seen.has(host)) throw new ProviderValidationError(`row ${n}: ${host} is listed twice`);
    seen.add(host);
    return { host, ip };
  });
}

// What is in force right now. Set from the sealed store at start-up and whenever the admin saves.
let pins = new Map<string, string>();

export function setHostPins(list: HostPin[]): void {
  pins = new Map(list.map((p) => [normalizeHost(p.host), p.ip]));
}

/** `lookup` option for node:http(s) requests: the pinned address for a pinned host, the normal DNS answer for everything else. */
export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  const ip = pins.get(normalizeHost(hostname));
  if (!ip) return dnsLookup(hostname, options, callback as never);
  const family = isIP(ip);
  if (options.all) callback(null, [{ address: ip, family }] as never);
  else callback(null, ip, family);
};

export interface PinCheck {
  ok: boolean;
  ms: number;
  detail: string;
}

/** Opens a TLS connection to ip:443 as `host` and checks the certificate. Sends no request, so it costs nothing and needs no key. */
export function checkPin(host: string, ip: string, timeoutMs = 8000, port = 443): Promise<PinCheck> {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, detail });
    };
    const socket = connect({ host: ip, port, servername: host, rejectUnauthorized: true, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = cert?.issuer?.O ?? cert?.issuer?.CN ?? 'unknown issuer';
      finish(true, `connected and the certificate is valid for ${host} (issued by ${issuer})`);
    });
    socket.on('timeout', () => finish(false, `no answer from ${ip}:${port} within ${Math.round(timeoutMs / 1000)} seconds`));
    socket.on('error', (e) => finish(false, `${(e as NodeJS.ErrnoException).code ?? 'error'}: ${e.message}`));
  });
}
