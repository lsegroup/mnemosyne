// SPDX-License-Identifier: Apache-2.0
/**
 * FIXED ADDRESSES (set in the admin, a separate program): a host name pinned to an IP address, as a FALLBACK.
 *
 * When the DNS in front of an AI provider is unstable, an administrator can tell Mnemosyne which address a host name has. Every connection
 * Mnemosyne itself makes to such a provider (the AI calls and the model list) asks DNS first; only when the lookup fails (for example EAI_AGAIN)
 * or does not answer within a few seconds does the connection go to the pinned address. A host that resolves is never redirected, so a pin that has
 * gone stale cannot break a working provider. Only the lookup is replaced: the TLS certificate is still checked against the host name, so a wrong or
 * hijacked address cannot be used to listen in. It does not touch the operating system (/etc/hosts, the resolver) or anything else on the server.
 * No model call is made here.
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

/** How long DNS may take for a host that has a fixed address, before the address is used. */
export const DNS_TIMEOUT_MS = 5000;
let resolver: typeof dnsLookup = dnsLookup;
let dnsTimeoutMs = DNS_TIMEOUT_MS;
/** Tests replace the resolver (to make a lookup fail like EAI_AGAIN) and shorten the time; call without arguments to put the real ones back. */
export function setResolverForTests(r?: typeof dnsLookup, timeoutMs = DNS_TIMEOUT_MS): void {
  resolver = r ?? dnsLookup;
  dnsTimeoutMs = timeoutMs;
}

/** `lookup` option for node:http(s) requests: the normal DNS answer, and for a pinned host the pinned address when DNS fails or is too slow. */
export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  const ip = pins.get(normalizeHost(hostname));
  if (!ip) return resolver(hostname, options, callback as never);
  let done = false;
  const useThePin = () => {
    const family = isIP(ip);
    if (options.all) callback(null, [{ address: ip, family }] as never);
    else callback(null, ip, family);
  };
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    useThePin();
  }, dnsTimeoutMs);
  resolver(hostname, options, ((err: NodeJS.ErrnoException | null, address: unknown, family: unknown) => {
    if (done) return; // the pin was already used
    done = true;
    clearTimeout(timer);
    if (err) useThePin();
    else callback(null, address as never, family as never);
  }) as never);
};

export interface PinCheck {
  ok: boolean;
  ms: number;
  detail: string;
}
