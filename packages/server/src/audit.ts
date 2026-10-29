import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Request } from 'express';

/**
 * Audit trail of the web portal: who signed in or failed to, and every change made in the admin UI.
 * Same shape as the CenTest / load-balancer audit view: time, event, entity type, name / id, user,
 * IP address, changes (+/- lines) and description. Append-only JSON lines next to the index cache
 * (never in the nodes repo); secrets are never written, only the fact that they changed.
 */
export interface AuditEvent {
  /** ISO-8601 UTC. */
  time: string;
  /** login, login_failed, logout, create, update, delete, fetch, denied … */
  event: string;
  entityType: string;
  entityId: string;
  entityName: string;
  user: string;
  ip: string;
  /** `- key: "old"` / `+ key: "new"` lines, like the CenTest audit view. */
  changes: string | null;
  description: string;
}

export type AuditInput = Partial<Omit<AuditEvent, 'time'>> & { event: string };

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_ROTATED = 3;
export const AUDIT_PAGE = 500;

/**
 * Client address behind our own reverse proxy (the :40000 front adds the real peer as the LAST
 * X-Forwarded-For entry). A header sent by the client can only sit before that entry, so the
 * rightmost value is the one to trust — and only when the direct peer is the local proxy.
 */
export function clientIp(req: Request): string {
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (peer === '127.0.0.1' || peer === '::1') {
    const parts = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!.replace(/^::ffff:/, '');
  }
  return peer || 'unknown';
}

/** `- key: "old"` / `+ key: "new"` for the fields that differ; values named like secrets are masked. */
export function diffLines(before: Record<string, unknown>, after: Record<string, unknown>, secrets: string[] = []): string | null {
  const show = (k: string, v: unknown) => (secrets.includes(k) ? '"••••"' : JSON.stringify(v));
  const lines: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[k];
    const a = after[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    if (b !== undefined && b !== '') lines.push(`- ${k}: ${show(k, b)}`);
    if (a !== undefined && a !== '') lines.push(`+ ${k}: ${show(k, a)}`);
  }
  return lines.length ? lines.join('\n') : null;
}

export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Never throws: an audit write problem must not take the portal down. */
  log(input: AuditInput): Promise<void> {
    const ev: AuditEvent = {
      time: new Date().toISOString(),
      event: input.event,
      entityType: input.entityType ?? '',
      entityId: input.entityId ?? '',
      entityName: input.entityName ?? '',
      user: input.user ?? 'anonymous',
      ip: input.ip ?? '',
      changes: input.changes ?? null,
      description: input.description ?? '',
    };
    const run = this.queue.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await this.rotateIfNeeded();
        await appendFile(this.file, `${JSON.stringify(ev)}\n`, { mode: 0o600 });
      } catch (err) {
        console.error('audit: write failed:', (err as Error).message);
      }
    });
    this.queue = run;
    return run;
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;
    await unlink(`${this.file}.${KEEP_ROTATED}`).catch(() => undefined);
    for (let i = KEEP_ROTATED - 1; i >= 1; i--) await rename(`${this.file}.${i}`, `${this.file}.${i + 1}`).catch(() => undefined);
    await rename(this.file, `${this.file}.1`);
  }

  /** How many events of this kind were written since `sinceIso` (used for the daily AI spending cap). */
  async countSince(sinceIso: string, event: string): Promise<number> {
    await this.queue;
    let raw = '';
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return 0;
    }
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.includes(`"event":"${event}"`)) continue;
      try {
        const e = JSON.parse(line) as AuditEvent;
        if (e.event === event && e.time >= sinceIso) n++;
      } catch {
        /* ignore a torn line */
      }
    }
    return n;
  }

  /** Newest first. `q` matches any text field, case-insensitively. Reads the current file only. */
  async list(opts: { q?: string; offset?: number; limit?: number } = {}): Promise<{ events: AuditEvent[]; total: number }> {
    await this.queue;
    let raw = '';
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const q = (opts.q ?? '').trim().toLowerCase();
    const all: AuditEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        all.push(JSON.parse(line) as AuditEvent);
      } catch {
        /* a torn last line must not hide the rest */
      }
    }
    all.reverse();
    const matched = q
      ? all.filter((e) => [e.event, e.entityType, e.entityId, e.entityName, e.user, e.ip, e.changes ?? '', e.description].some((v) => v.toLowerCase().includes(q)))
      : all;
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(AUDIT_PAGE, Math.max(1, opts.limit ?? AUDIT_PAGE));
    return { events: matched.slice(offset, offset + limit), total: matched.length };
  }
}
