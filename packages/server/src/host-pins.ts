/**
 * FIXED ADDRESSES (set in the admin, a separate program): a host name pinned to an IP address.
 *
 * When the DNS in front of an AI provider is unstable, an administrator can tell Mnemosyne which address a host name has. Every connection
 * Mnemosyne itself makes to such a provider (the AI calls and the model list) then goes straight to that address and DNS is not asked at all.
 * Only the lookup is replaced: the TLS certificate is still checked against the host name, so a wrong or hijacked address cannot be used
 * to listen in. It does not touch the operating system (/etc/hosts, the resolver) or anything else on the server. No model call is made here.
 */
import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

export interface HostPin {
  host: string;
  ip: string;
}

export const MAX_PINS = 20;

export const normalizeHost = (h: string): string => h.trim().toLowerCase().replace(/\.$/, '');

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
