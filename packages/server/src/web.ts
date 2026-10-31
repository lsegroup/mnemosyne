import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Router, urlencoded, type NextFunction, type Request, type Response } from 'express';
import type { MnemosyneConfig } from './config.js';
import { MIN_SECRET_LENGTH, deriveKeys, hashPassword, signToken, verifyPassword, verifyToken, type DerivedKeys } from './secrets.js';
import { ProviderStore, ProviderValidationError, ROLES, type Role } from './provider-store.js';
import { fetchModels } from './llm-models.js';
import { AuditLog, clientIp, diffLines, type AuditInput } from './audit.js';
import { SettingsStore, SettingsValidationError, applyPortalInput, type GitLabSettings, type PortalSettings } from './settings-store.js';
import { adminPage, docsNotFound, homePage, loginPage, nodePage, notesPage, projectHome, type ProjectCard } from './web-pages.js';
import { JOB_DEFS, effectiveJob, validateJobSettings, type JobSettings } from './ai-jobs.js';
import { MemberStore, type MemberEntry } from './member-store.js';
import { NodeIndex, fetchMemberships, matchProject, redact, slug, type GitLabProject } from './docs.js';
import { outline, renderMarkdown } from './markdown.js';
import { DocStore, approxTokens, buildDiagramPlanPrompt, buildWikiPrompt, changeHistory, estimateText, historyMarkdown, missingSections, toPdfImage, type DocMeta } from './docgen.js';
import { chat } from './llm-call-chat.js';
import { PlanError, drawScene, layout, parsePlanSet, renderSvg, type DiagramPlan, type DiagramSet } from './diagram.js';
import { buildPdf, type PdfInput } from './pdf.js';
import { LOGO_WEBP_BASE64 } from './web-assets.js';

// Two independent sign-in systems: the public page (cookie below) and the admin area
// (own cookie, own routes under /admin/*) so the admin can later be served by a different
// implementation without touching the public side.
const SESSION_COOKIE = 'mnemosyne_session';
const ADMIN_COOKIE = 'mnemosyne_admin';
const OAUTH_COOKIE = 'mnemosyne_oauth';
const ADMIN_OAUTH_COOKIE = 'mnemosyne_admin_oauth';
const SESSION_TTL_S = 8 * 3600;
/** The documentation area stays signed in for a month; GitLab is re-checked silently every 12 h (refresh token). */
const money = (usd: number) => (usd < 0.01 ? '<0.01' : usd.toFixed(2));
/** Pictures made by an image model are png/jpg/webp; diagrams drawn by Mnemosyne itself are svg. */
const DIAGRAM_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const DOCS_SESSION_TTL_S = 30 * 24 * 3600;
const MEMBER_FRESH_MS = 12 * 3600 * 1000;
const OAUTH_TTL_S = 10 * 60;
const GITLAB_TIMEOUT_MS = 10_000;
const LOCAL_ADMIN_GRACE_S = 24 * 3600;

interface Session {
  u: string; // GitLab username
  n: string; // display name
  e: string; // e-mail
  l?: boolean; // admin session from the local admin account
  exp: number;
}

interface OAuthState {
  state: string;
  verifier: string;
  exp: number;
}

interface GitLabUser {
  username?: string;
  name?: string;
  email?: string;
  state?: string;
  /** Present (true) only when GitLab reports the signed-in user as an instance administrator. */
  is_admin?: boolean;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface WebPortal {
  router: Router;
  /** Provider settings store; null while the portal is not configured. */
  providers: ProviderStore | null;
}

/** Everything the portal needs to be switched on; any gap leaves it in "not configured". */
export function webConfigured(cfg: MnemosyneConfig): boolean {
  const w = cfg.web;
  return Boolean(w.secret && w.secret.length >= MIN_SECRET_LENGTH && w.publicUrl);
}

/**
 * Public login screen at `/`, sign-in (local admin account and GitLab SSO) under `/auth/*`, and the admin area
 * under `/admin/*` (HTML + JSON API). Mounted before the MCP/REST bearer check,
 * so it has its own auth and never touches how MCP clients connect.
 */
export function createWebPortal(cfg: MnemosyneConfig): WebPortal {
  const router = Router();
  const configured = webConfigured(cfg);
  const basePath = cfg.http.basePath;
  const cookiePath = basePath || '/';
  const secure = Boolean(cfg.web.publicUrl?.startsWith('https://'));
  const keys: DerivedKeys | null = configured ? deriveKeys(cfg.web.secret!) : null;
  const providers = keys ? new ProviderStore(cfg.web.providersFile, keys.enc) : null;
  const settings = keys ? new SettingsStore(cfg.web.settingsFile, keys.enc) : null;
  const audit = keys ? new AuditLog(cfg.web.auditFile) : null;
  const rec = (req: Request, e: AuditInput) => audit?.log({ ip: clientIp(req), ...e });

  // Built-in admin account: lets the portal be configured before GitLab SSO exists.
  const localUser = (cfg.web.localAdmin.user ?? '').trim() || 'admin';
  const localHash =
    cfg.web.localAdmin.passwordHash || (cfg.web.localAdmin.password ? hashPassword(cfg.web.localAdmin.password) : undefined);
  const localEnabled = Boolean(keys && localHash);

  /** GitLab SSO + admin list: values saved in the admin UI win over the environment. */
  const effective = async () => {
    const st: PortalSettings = settings ? await settings.get().catch(() => ({})) : {};
    const g: GitLabSettings = {
      url: (st.gitlab?.url || cfg.web.gitlab.url) || undefined,
      clientId: (st.gitlab?.clientId || cfg.web.gitlab.clientId) || undefined,
      clientSecret: (st.gitlab?.clientSecret || cfg.web.gitlab.clientSecret) || undefined,
    };
    // The built-in account is a bootstrap: 24h after GitLab SSO is proven live (first admin
    // sign-in through it) it stops working. MNEMOSYNE_LOCAL_ADMIN_FORCE=1 is the recovery
    // switch if GitLab is down or SSO was misconfigured.
    const dueAt = st.ssoLiveAt ? st.ssoLiveAt + LOCAL_ADMIN_GRACE_S : undefined;
    const force = /^(1|true|yes|on)$/i.test(process.env.MNEMOSYNE_LOCAL_ADMIN_FORCE ?? '');
    return {
      gitlab: g,
      sso: Boolean(g.url && g.clientId && g.clientSecret),
      ssoLiveAt: st.ssoLiveAt,
      localActive: localEnabled && (force || !dueAt || Date.now() / 1000 < dueAt),
    };
  };

  // Brute-force brake for the local login: 5 misses lock that client out for a minute.
  const misses = new Map<string, { n: number; until: number }>();

  const setCookie = (res: Response, name: string, value: string, maxAgeS: number, path = cookiePath) =>
    res.append(
      'Set-Cookie',
      `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
  const clearCookie = (res: Response, name: string, path = cookiePath) => setCookie(res, name, '', 0, path);

  const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

  /** CSP for pages: no external resources, scripts only with the per-response nonce. */
  const pageHeaders = (res: Response, nonce = '') => {
    noStore(res);
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  };

  // --- one host name for sign-in --------------------------------------------
  // The sign-in cookie belongs to the host name the person typed, but GitLab sends the browser back to the configured public URL. If the
  // two names differ, the cookie is missing at the callback and the sign-in fails ("error=state"). So a BROWSER PAGE opened under another
  // name of this server is redirected, once, to the same path under the public URL. Only the host of the public URL, the host of the
  // GitLab URL and MNEMOSYNE_ALIAS_HOSTS count as "another name of this server" (the Host header is never copied into the redirect), and
  // only GET requests for pages: MCP and REST keep answering under every name.
  const canonical = cfg.web.publicUrl ? new URL(cfg.web.publicUrl) : null;
  const ownNames = new Set(
    [...cfg.web.aliasHosts, canonical?.hostname, cfg.web.gitlab.url ? new URL(cfg.web.gitlab.url).hostname : undefined]
      .filter((h): h is string => Boolean(h))
      .map((h) => h.toLowerCase()),
  );
  const PAGE_PATH = /^\/(?:$|p\/|admin(?:\/|$)|auth\/|assets\/)/;
  router.use((req, res, next) => {
    if (!canonical || req.method !== 'GET' || !PAGE_PATH.test(req.path)) return next();
    const typed = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').toLowerCase().split(':')[0] ?? '';
    if (!typed || typed === canonical.hostname.toLowerCase() || !ownNames.has(typed)) return next();
    res.redirect(302, `${canonical.origin}${req.originalUrl}`);
  });

  // --- public brand asset (login screen logo) -----------------------------
  const logo = Buffer.from(LOGO_WEBP_BASE64, 'base64');
  router.get('/assets/logo.webp', (_req, res) => {
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(logo);
  });

  // --- shared pieces -------------------------------------------------------
  const authPath = (prefix: string) => `${basePath}${prefix}/auth`;
  const here = (path: string) => `${cfg.web.publicUrl ?? ''}${basePath}${path}`;
  const sessionFrom = (req: Request, cookie: string): Session | null =>
    keys ? verifyToken<Session>(keys.sign, parseCookies(req.header('cookie'))[cookie]) : null;
  const originOk = (req: Request) => {
    const origin = req.header('origin');
    return !origin || origin === new URL(cfg.web.publicUrl!).origin;
  };

  interface SsoUser {
    username: string;
    name: string;
    email: string;
    /** GitLab instance administrator (GitLab's own flag, not a list kept here). */
    admin: boolean;
  }
  interface SsoArea {
    /** '' for the public area, '/admin' for the admin area. */
    prefix: string;
    /** Shown in the audit trail. */
    label: 'public' | 'admin';
    /** OAuth scopes requested from GitLab. */
    scope: string;
    /** Runs after GitLab accepted the user, with their access token (e.g. to read their project memberships). */
    after?: (user: SsoUser, accessToken: string, warmed: Promise<unknown> | undefined, refreshToken?: string) => Promise<void>;
    /** How long the browser session lasts (default 8 h). */
    sessionTtlS?: number;
    /** Started the moment GitLab hands over the token, in parallel with the user lookup (the browser is waiting on GitLab's redirect page). */
    warm?: (accessToken: string) => Promise<unknown>;
    oauthCookie: string;
    sessionCookie: string;
    sessionPath: string;
    /** Where to send the browser after a failed attempt. */
    failTo: string;
    /** Decide whether this GitLab user may sign in here; return the destination or an error key. */
    admit: (user: SsoUser, eff: Awaited<ReturnType<typeof effective>>) => Promise<{ to: string } | { error: string }>;
  }

  /** GitLab authorization-code + PKCE login/callback pair mounted at `<prefix>/auth/{login,callback}`. */
  const mountSso = (area: SsoArea) => {
    const redirectUri = here(`${area.prefix}/auth/callback`);
    const oauthPath = authPath(area.prefix);
    const fail = (req: Request, res: Response, error: string, user = 'anonymous') => {
      void rec(req, { event: 'login_failed', entityType: `${area.label}_sso`, user, description: `GitLab sign-in refused (${error})` });
      clearCookie(res, area.oauthCookie, oauthPath);
      res.redirect(`${area.failTo}?error=${error}`);
    };

    router.get(`${area.prefix}/auth/login`, async (_req, res) => {
      const eff = keys ? await effective() : null;
      if (!keys || !eff?.sso) {
        res.redirect(area.failTo);
        return;
      }
      const state = randomBytes(16).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      setCookie(
        res,
        area.oauthCookie,
        signToken(keys.sign, { state, verifier, exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_S } satisfies OAuthState),
        OAUTH_TTL_S,
        oauthPath,
      );
      const url = new URL(`${eff.gitlab.url}/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: eff.gitlab.clientId!,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
        scope: area.scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      noStore(res);
      res.redirect(url.toString());
    });

    router.get(`${area.prefix}/auth/callback`, async (req, res) => {
      if (!keys) {
        res.redirect(area.failTo);
        return;
      }
      const eff = await effective();
      if (!eff.sso) {
        fail(req, res, 'nosso');
        return;
      }
      const pending = verifyToken<OAuthState>(keys.sign, parseCookies(req.header('cookie'))[area.oauthCookie]);
      if (!pending || typeof req.query.state !== 'string' || req.query.state !== pending.state) {
        fail(req, res, 'state');
        return;
      }
      if (typeof req.query.code !== 'string') {
        fail(req, res, 'denied');
        return;
      }
      try {
        const tokenRes = await fetch(`${eff.gitlab.url}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            client_id: eff.gitlab.clientId!,
            client_secret: eff.gitlab.clientSecret!,
            code: req.query.code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            code_verifier: pending.verifier,
          }),
          signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
        });
        const token = (await tokenRes.json()) as { access_token?: string; refresh_token?: string };
        if (!tokenRes.ok || !token.access_token) throw new Error(`token exchange failed (${tokenRes.status})`);

        const warmed = area.warm?.(token.access_token);
        warmed?.catch(() => undefined);
        const userRes = await fetch(`${eff.gitlab.url}/api/v4/user`, {
          headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
        });
        const user = (await userRes.json()) as GitLabUser;
        if (!userRes.ok || !user.username) throw new Error(`user lookup failed (${userRes.status})`);
        if (user.state && user.state !== 'active') {
          fail(req, res, 'denied');
          return;
        }

        const verdict = await area.admit(
          { username: user.username, name: user.name ?? user.username, email: user.email ?? '', admin: user.is_admin === true },
          eff,
        );
        if ('error' in verdict) {
          fail(req, res, verdict.error, user.username);
          return;
        }
        await area.after?.(
          { username: user.username, name: user.name ?? user.username, email: user.email ?? '', admin: user.is_admin === true },
          token.access_token,
          warmed,
          token.refresh_token,
        );
        void rec(req, {
          event: 'login',
          entityType: `${area.label}_sso`,
          entityName: user.name ?? user.username,
          user: user.username,
          description: `Signed in with GitLab (${area.label}${area.label === 'admin' ? ', GitLab administrator' : ''})`,
        });
        setCookie(
          res,
          area.sessionCookie,
          signToken(keys.sign, {
            u: user.username,
            n: user.name ?? user.username,
            e: user.email ?? '',
            exp: Math.floor(Date.now() / 1000) + (area.sessionTtlS ?? SESSION_TTL_S),
          } satisfies Session),
          area.sessionTtlS ?? SESSION_TTL_S,
          area.sessionPath,
        );
        clearCookie(res, area.oauthCookie, oauthPath);
        noStore(res);
        res.redirect(verdict.to);
      } catch {
        fail(req, res, 'gitlab');
      }
    });
  };

  // =========================================================================
  // PUBLIC AREA — `/`: GitLab sign-in for everyone. Knows nothing about the admin.
  // =========================================================================
  // Who may read which project's documentation: GitLab's own membership list, read with the user's
  // token at sign-in and kept in memory for the session (never in a cookie: it can be long).
  const nodeIndex = keys ? new NodeIndex(cfg.nodesDir) : null;
  const memberStore = keys ? new MemberStore(cfg.web.membersFile, keys.enc) : null;
  const members: Map<string, MemberEntry> = memberStore ? memberStore.load() : new Map();
  const persistMembers = () => void memberStore?.save(members);
  const docsSession = (req: Request) => {
    const s = sessionFrom(req, SESSION_COOKIE);
    const m = s ? members.get(s.u) : undefined;
    return s && m && Date.now() - m.at < DOCS_SESSION_TTL_S * 1000 ? { s, m } : null;
  };

  // Re-check GitLab (still active? still administrator? which projects?) with the stored refresh token, on the
  // server, with no browser round trip. Only when this fails does the person have to sign in again.
  const refreshing = new Map<string, Promise<boolean>>();
  const refreshMember = (username: string): Promise<boolean> => {
    const running = refreshing.get(username);
    if (running) return running;
    const job = (async () => {
      const m = members.get(username);
      if (!m?.refresh) return false;
      try {
        const eff = await effective();
        if (!eff.sso) return false;
        const res = await fetch(`${eff.gitlab.url}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ client_id: eff.gitlab.clientId!, client_secret: eff.gitlab.clientSecret!, grant_type: 'refresh_token', refresh_token: m.refresh }),
          signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
        });
        const t = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
        if (!res.ok || !t.access_token) return false;
        const [userRes, projects] = await Promise.all([
          fetch(`${eff.gitlab.url}/api/v4/user`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS) }),
          fetchMemberships(eff.gitlab.url!, t.access_token),
        ]);
        const u = (await userRes.json().catch(() => ({}))) as GitLabUser;
        if (!userRes.ok || u.username !== username || (u.state && u.state !== 'active')) return false;
        members.set(username, { at: Date.now(), admin: u.is_admin === true, projects, refresh: t.refresh_token ?? m.refresh });
        persistMembers();
        return true;
      } catch {
        return false; // GitLab unreachable: keep the old entry, retry on the next request
      }
    })();
    refreshing.set(username, job);
    void job.finally(() => refreshing.delete(username));
    return job;
  };
  /** The signed-in documentation user; silently re-validated against GitLab when the last check is older than 12 h. */
  const freshSession = async (req: Request) => {
    const ds = docsSession(req);
    if (!ds) return null;
    if (Date.now() - ds.m.at < MEMBER_FRESH_MS) return ds;
    if (await refreshMember(ds.s.u)) return docsSession(req);
    // refresh failed: keep working on the old answer only if GitLab could not be reached, else sign out
    const m = members.get(ds.s.u);
    if (m?.refresh && Date.now() - m.at < MEMBER_FRESH_MS * 2) return ds;
    members.delete(ds.s.u);
    persistMembers();
    return null;
  };

  /** Administrators see every project; others only those that match a GitLab project they belong to. */
  const canRead = (m: { admin: boolean; projects: GitLabProject[] | null }, project: string) =>
    m.admin || (m.projects !== null && matchProject(project, m.projects) !== null);

  // text responses are gzip-compressed: the pages are large and the visitors are far away (every round trip costs ~0.3 s)
  router.use((req, res, next) => {
    if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return next();
    const send = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (typeof body === 'string' && body.length > 1024 && !res.getHeader('Content-Encoding')) {
        const type = String(res.getHeader('Content-Type') ?? 'text/html; charset=utf-8');
        if (/^text\/|json/.test(type)) {
          res.setHeader('Content-Type', type);
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          return send(gzipSync(body));
        }
      }
      return send(body as never);
    }) as typeof res.send;
    next();
  });

  router.get('/', async (req, res) => {
    const ds = await freshSession(req);
    pageHeaders(res);
    if (ds && nodeIndex) {
      const fromNotes = (await nodeIndex.projects())
        .filter((p) => canRead(ds.m, p.project))
        .map((p) => {
          const gl = ds.m.projects ? matchProject(p.project, ds.m.projects) : null;
          return {
            gl,
            card: {
              title: gl?.name ?? p.project,
              sub: gl ? gl.fullPath : 'no GitLab project',
              count: p.count,
              updated: p.updated,
              href: `${basePath}/p/${encodeURIComponent(p.project)}`,
              glId: gl?.id,
              adminOnly: ds.m.admin && !gl,
            } as ProjectCard,
          };
        });
      // every GitLab project the person belongs to is listed, also those nobody has written a note for yet
      const withNotes = new Set(fromNotes.map((x) => x.gl?.id).filter((id) => id !== undefined));
      const empty: ProjectCard[] = (ds.m.projects ?? [])
        .filter((g) => !withNotes.has(g.id))
        .map((g) => ({ title: g.name, sub: g.fullPath, count: 0, updated: null, href: `${basePath}/p/${encodeURIComponent(slug(g.path))}`, glId: g.id, adminOnly: false }));
      const cards: ProjectCard[] = [...fromNotes.map((x) => x.card), ...empty].sort((x, y) => x.title.localeCompare(y.title));
      res.send(
        homePage({
          basePath,
          user: { name: ds.s.n, username: ds.s.u, admin: ds.m.admin },
          cards,
          isAdmin: ds.m.admin,
          notice:
            ds.m.projects === null && !ds.m.admin
              ? 'GitLab did not share your project list, so nothing can be shown yet. The Mnemosyne application in GitLab needs the read_api scope.'
              : undefined,
        }),
      );
      return;
    }
    res.send(
      loginPage({
        basePath,
        configured,
        local: false,
        sso: configured && (await effective()).sso,
        error: typeof req.query.error === 'string' ? req.query.error : undefined,
      }),
    );
  });

  const notFound = (res: Response, ds: NonNullable<ReturnType<typeof docsSession>>, msg: string) => {
    pageHeaders(res);
    res.status(404).send(docsNotFound(basePath, { name: ds.s.n, username: ds.s.u, admin: ds.m.admin }, msg));
  };

  // --------------------------------------------------------------------------
  // Project area. The project page is blank until documentation has been generated. Generating
  // (AI, costs money) is for GitLab administrators only and needs an explicit agreement every time:
  // the server only hands out a one-time consent token together with the cost estimate, and refuses
  // to start without it. A daily cap and "one AI job at a time" bound the spending.
  // --------------------------------------------------------------------------
  const docStore = keys ? new DocStore(cfg.web.docsDir) : null;
  const jobs = new Map<string, { kind: string; state: 'running' | 'done' | 'error'; startedAt: number; error?: string; warning?: string }>();
  const usedConsents = new Map<string, number>();
  const CONSENT_TTL_S = 600;

  /** Signed-in reader of an existing project they may see; otherwise answers and returns null. */
  const gate = async (req: Request, res: Response, adminOnly = false) => {
    const ds = await freshSession(req);
    if (!ds || !nodeIndex || !docStore) {
      res.redirect(`${basePath}/`);
      return null;
    }
    const project = String(req.params.project);
    const refuse = (why: string) => {
      void rec(req, { event: 'denied', entityType: 'docs_project', entityName: project, user: ds.s.u, description: why });
      notFound(res, ds, 'This page does not exist, or you do not have access to it.');
      return null;
    };
    if (!canRead(ds.m, project)) return refuse('Project documentation refused (not a member of the matching GitLab project)');
    if (adminOnly && !ds.m.admin) return refuse('Administrator-only page refused');
    const gl = ds.m.projects ? matchProject(project, ds.m.projects) : null;
    // a GitLab project nobody has written notes for yet still gets its (blank) page
    if (!(await nodeIndex.inProject(project)).length && !gl) {
      notFound(res, ds, 'This page does not exist, or you do not have access to it.');
      return null;
    }
    return { ds, project, gl, subtitle: gl ? `GitLab project ${gl.fullPath}` : 'No matching GitLab project — visible to GitLab administrators only' };
  };

  const docsApiOk = (req: Request, res: Response) => {
    if (req.method !== 'GET' && (req.header('x-requested-with') !== 'mnemosyne-docs' || !originOk(req))) {
      res.status(403).json({ error: 'cross-site request refused' });
      return false;
    }
    return true;
  };
  const fail400 = (res: Response, error: string, status = 400) => res.status(status).json({ error });

  router.get('/p/:project', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const { ds, project } = g;
    const wikis = await docStore!.list(project, 'wiki');
    const wanted = typeof req.query.v === 'string' ? wikis.find((m) => m.id === req.query.v) : wikis[0];
    let wiki = null;
    if (wanted) {
      const text = redact((await docStore!.read(wanted)).toString('utf8'));
      wiki = { meta: wanted, html: renderMarkdown(text, { article: true }), toc: outline(text, { article: true }) };
    }
    const diagrams = await docStore!.list(project, 'diagram');
    const pdfs = await docStore!.list(project, 'pdf');
    const job = jobs.get(project);
    const nonce = randomBytes(16).toString('base64');
    void rec(req, { event: 'view', entityType: 'docs_project', entityName: project, user: ds.s.u, description: 'Opened project documentation' });
    pageHeaders(res, nonce);
    res.send(
      projectHome({
        basePath,
        nonce,
        user: { name: ds.s.n, username: ds.s.u, admin: ds.m.admin },
        project,
        subtitle: g.subtitle,
        isAdmin: ds.m.admin,
        wiki,
        history: changeHistory(await nodeIndex!.inProject(project)),
        glUrl: g.gl?.webUrl ?? null,
        wikiVersions: wikis,
        diagram: diagrams[0] ?? null,
        diagramVersions: diagrams,
        pdf: pdfs[0] ?? null,
        pdfVersions: pdfs,
        busy: job?.state === 'running' ? job.kind : null,
      }),
    );
  });

  // Raw notes: administrators only (they hold internal rules and infrastructure details).
  router.get('/p/:project/notes', async (req, res) => {
    const g = await gate(req, res, true);
    if (!g) return;
    const all = await nodeIndex!.inProject(g.project);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    const needle = q.toLowerCase();
    const hits = needle ? all.filter((n) => [n.title, n.body, ...n.components].some((t) => t.toLowerCase().includes(needle))) : all;
    void rec(req, { event: 'view', entityType: 'docs_notes', entityName: g.project, user: g.ds.s.u, description: q ? `Searched source notes for “${q}”` : 'Opened source notes' });
    pageHeaders(res);
    res.send(
      notesPage({
        basePath,
        user: { name: g.ds.s.n, username: g.ds.s.u, admin: g.ds.m.admin },
        project: g.project,
        subtitle: g.subtitle,
        q,
        total: all.length,
        notes: hits
          .map((n) => ({ id: n.id, title: n.title, type: n.type, status: n.status, observed_at: n.observed_at }))
          .sort((x, y) => (y.observed_at ?? '').localeCompare(x.observed_at ?? '') || x.title.localeCompare(y.title)),
      }),
    );
  });

  router.get('/p/:project/diagram/:id', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const meta = await docStore!.get(g.project, 'diagram', String(req.params.id));
    if (!meta) return notFound(res, g.ds, 'This diagram does not exist.');
    res.setHeader('Content-Type', DIAGRAM_MIME[meta.ext] ?? 'application/octet-stream');
    // the SVG is made by this server from checked data and holds no script; the policy makes sure of it if the link is opened on its own
    if (meta.ext === 'svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(await docStore!.read(meta));
  });

  // A detail picture of a diagram set: drawn on request from the stored plan (the overview is the stored SVG above).
  router.get('/p/:project/diagram/:id/:n', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const meta = await docStore!.get(g.project, 'diagram', String(req.params.id));
    const n = Number(req.params.n);
    const pic = Number.isInteger(n) && n >= 1 ? meta?.pictures?.[n - 1] : undefined;
    if (!meta || !pic) return notFound(res, g.ds, 'This diagram does not exist.');
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(renderSvg(layout(pic.plan), pic.plan)));
  });

  router.get('/p/:project/pdf/:id', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const meta = await docStore!.get(g.project, 'pdf', String(req.params.id));
    if (!meta) return notFound(res, g.ds, 'This PDF does not exist.');
    void rec(req, { event: 'view', entityType: 'docs_pdf', entityId: meta.id, entityName: g.project, user: g.ds.s.u, description: 'Downloaded the project PDF' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${g.project.replace(/[^a-z0-9._-]/gi, '-')}-documentation-${meta.id}.pdf"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await docStore!.read(meta));
  });

  // Which models would be used, and what it would cost — plus the one-time consent token.
  const describeJob = async (project: string, kind: string) => {
    const text = await providers!.getAssigned('text');
    if (!text) return { error: 'Choose a model for Text in Admin → LLM first.' };
    const jobs = await providers!.getJobs();
    const tj = effectiveJob('text', jobs.text);
    const ij = effectiveJob('image', jobs.image);
    if (kind === 'wiki') {
      if (!(await nodeIndex!.inProject(project)).length) return { error: 'This project has no notes yet, so there is nothing to write the documentation from.' };
      const gl = null as null;
      const prompt = buildWikiPrompt(project, gl, await nodeIndex!.inProject(project), { system: tj.systemPrompt, user: tj.userPrompt });
      const est = estimateText(text.model, prompt.inputTokens, Math.min(12_000, tj.maxTokens)); // typical answer
      const max = estimateText(text.model, prompt.inputTokens, tj.maxTokens); // whole limit used
      return {
        key: `${text.provider.id}:${text.model}:${tj.maxTokens}:${tj.userPrompt.length}:${tj.systemPrompt.length}`,
        what: `Mnemosyne will send this project's notes (credentials masked first) to ${text.provider.label} and ask the AI to write the project page: product description, hardware and software requirements, and disaster-recovery documentation.`,
        facts: [
          ['Provider', `${text.provider.label}`],
          ['Model', text.model],
          ['Notes sent', `${prompt.noteCount}`],
          ['Size', `about ${prompt.inputTokens.toLocaleString('en-US')} tokens in, the AI may write up to ${tj.maxTokens.toLocaleString('en-US')} out (a large project can take several minutes)`],
          ['Estimated cost', est.usd === null || max.usd === null ? 'unknown (no list price for this model)' : `about $${money(est.usd)} (at most $${money(max.usd)} if the whole ${tj.maxTokens.toLocaleString('en-US')}-token limit is used)`],
        ],
        usd: max.usd,
      };
    }
    const wiki = await docStore!.latest(project, 'wiki');
    if (!wiki) return { error: 'Generate the documentation first.' };
    const wikiChars = Math.min((await docStore!.read(wiki)).length, 60_000);
    const typical = estimateText(text.model, approxTokens(wikiChars) + 1500, Math.min(12_000, ij.maxTokens)); // the article plus the rules; the real runs wrote about 11,800 tokens (thinking included)
    const worst = estimateText(text.model, approxTokens(wikiChars) + 1500, ij.maxTokens);
    return {
      key: `${text.provider.id}:${text.model}|plan:${ij.maxTokens}:${ij.userPrompt.length}:${ij.systemPrompt.length}`,
      what: `One AI call: ${text.provider.label} reads the article and writes the plan of the diagrams (an overview and, for a bigger system, detail pictures: boxes, arrows, ports) as data. Mnemosyne then draws the pictures itself, so every word is spelled exactly. No image model is used.`,
      facts: [
        ['Text model', `${text.provider.label} / ${text.model}`],
        ['Based on', `the article from ${wiki.generatedAt.slice(0, 16).replace('T', ' ')} UTC`],
        ['Estimated cost', typical.usd === null || worst.usd === null ? 'unknown (no list price for this model)' : `about $${money(typical.usd)} (at most $${money(worst.usd)} if the whole ${ij.maxTokens.toLocaleString('en-US')}-token limit of the answer is used)`],
      ],
      usd: worst.usd,
    };
  };

  router.get('/p/:project/api/estimate', async (req, res) => {
    const g = await gate(req, res, true);
    if (!g || !docsApiOk(req, res)) return;
    const kind = req.query.kind === 'diagram' ? 'diagram' : req.query.kind === 'wiki' ? 'wiki' : null;
    if (!kind) return void fail400(res, 'unknown kind');
    const d = await describeJob(g.project, kind);
    if ('error' in d) return void fail400(res, d.error as string);
    const nonce = randomBytes(12).toString('base64url');
    const token = signToken(keys!.sign, { p: g.project, k: kind, m: d.key, u: g.ds.s.u, n: nonce, exp: Math.floor(Date.now() / 1000) + CONSENT_TTL_S });
    res.json({ kind, what: d.what, facts: d.facts, token });
  });

  const stripFence = (t: string) => t.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1').trim();

  const runJob = async (project: string, kind: 'wiki' | 'diagram', user: string, ip: string, glName: string | null) => {
    const started = Date.now();
    let warning: string | undefined;
    jobs.set(project, { kind, state: 'running', startedAt: started });
    const log = (e: AuditInput) => audit?.log({ ip, user, entityType: `docs_${kind}`, entityName: project, ...e });
    try {
      const text = (await providers!.getAssigned('text'))!;
      if (kind === 'wiki') {
        const tj = effectiveJob('text', (await providers!.getJobs()).text);
        const prompt = buildWikiPrompt(project, glName, await nodeIndex!.inProject(project), { system: tj.systemPrompt, user: tj.userPrompt });
        const out = await chat(text.provider, text.model, prompt.system, prompt.user, { maxTokens: tj.maxTokens, temperature: tj.temperature, topP: tj.topP, timeoutMs: tj.timeoutMinutes * 60_000 });
        const meta = await docStore!.save(
          { kind: 'wiki', project, model: `${text.provider.label} / ${text.model}`, by: user, noteCount: prompt.noteCount, inputTokens: out.inputTokens, outputTokens: out.outputTokens, ext: 'md' },
          redact(stripFence(out.text)),
        );
        const missing = missingSections(out.text);
        if (missing.length) warning = `The article was saved, but the AI left out: ${missing.join(', ')}. Click “Regenerate documentation” to try again.`;
        void log({ event: 'ai_done', entityId: meta.id, description: `Article written by ${meta.model} from ${prompt.noteCount} notes (${out.inputTokens} tokens in, ${out.outputTokens} out)${missing.length ? `; MISSING SECTIONS: ${missing.join(', ')}` : ''}` });
      } else {
        // one AI call writes the PLAN (data); Mnemosyne draws the picture itself, so no word in it is misspelled by a model
        const wiki = (await docStore!.latest(project, 'wiki'))!;
        const wikiText = (await docStore!.read(wiki)).toString('utf8');
        const ij = effectiveJob('image', (await providers!.getJobs()).image);
        const ask = buildDiagramPlanPrompt(project, wikiText, { system: ij.systemPrompt, user: ij.userPrompt });
        const out = await chat(text.provider, text.model, ask.system, ask.user, { maxTokens: ij.maxTokens, temperature: ij.temperature, topP: ij.topP, timeoutMs: ij.timeoutMinutes * 60_000 });
        let set: DiagramSet;
        try {
          set = parsePlanSet(out.text, glName ?? project);
        } catch (err) {
          if (!(err instanceof PlanError)) throw err;
          throw new ProviderValidationError(
            `The AI answered, but not with a usable diagram plan: ${err.message}. Nothing was drawn (${out.inputTokens.toLocaleString('en-US')} tokens in, ${out.outputTokens.toLocaleString('en-US')} out were used). If you changed the instruction in Admin → LLM → Images, press “Reset to defaults” there: it must ask for the JSON plan.`,
          );
        }
        const [overview, ...details] = set.pictures;
        const boxes = set.pictures.reduce((s, p) => s + p.plan.columns.reduce((t, c) => t + c.nodes.length, 0), 0);
        const arrows = set.pictures.reduce((s, p) => s + p.plan.links.length, 0);
        const meta = await docStore!.save(
          { kind: 'diagram', project, model: `Mnemosyne, planned by ${text.provider.label} / ${text.model}`, by: user, basedOn: wiki.id, inputTokens: out.inputTokens, outputTokens: out.outputTokens, ext: 'svg', plan: overview!.plan, pictures: details },
          renderSvg(layout(overview!.plan), overview!.plan),
        );
        if (set.dropped.length) warning = `The diagrams were drawn, but ${set.dropped.length} item(s) of the AI's plan could not be used and were left out: ${set.dropped.slice(0, 3).join('; ')}${set.dropped.length > 3 ? '; ...' : ''}.`;
        void log({
          event: 'ai_done',
          entityId: meta.id,
          description: `Architecture diagrams drawn by Mnemosyne from a plan written by ${text.model} (${set.pictures.length} picture${set.pictures.length > 1 ? 's' : ''}: ${set.pictures.map((p) => p.name).join(', ')}; ${boxes} boxes, ${arrows} arrows; ${out.inputTokens} tokens in, ${out.outputTokens} out)${set.dropped.length ? `; left out of the plan: ${set.dropped.length}` : ''}`,
        });
      }
      jobs.set(project, { kind, state: 'done', startedAt: started, warning });
    } catch (err) {
      const msg = err instanceof ProviderValidationError ? err.message : 'The generation failed unexpectedly.';
      if (!(err instanceof ProviderValidationError)) console.error(`docs ${kind} job for ${project} failed:`, err);
      jobs.set(project, { kind, state: 'error', startedAt: started, error: msg });
      void log({ event: 'ai_failed', description: msg });
    }
  };

  router.post('/p/:project/api/generate', async (req, res) => {
    const g = await gate(req, res, true);
    if (!g || !docsApiOk(req, res)) return;
    const kind = req.body?.kind === 'diagram' ? 'diagram' : req.body?.kind === 'wiki' ? 'wiki' : null;
    if (!kind) return void fail400(res, 'unknown kind');
    // 1) the person must have agreed: a valid, unused, unexpired consent token for exactly this job
    const c = verifyToken<{ p: string; k: string; m: string; u: string; n: string; exp: number }>(keys!.sign, typeof req.body?.token === 'string' ? req.body.token : undefined);
    const d = await describeJob(g.project, kind);
    if (!c || c.p !== g.project || c.k !== kind || c.u !== g.ds.s.u || 'error' in d || c.m !== d.key || usedConsents.has(c.n)) {
      void rec(req, { event: 'denied', entityType: `docs_${kind}`, entityName: g.project, user: g.ds.s.u, description: 'AI generation refused: no valid agreement (consent token missing, expired, reused or for a different job)' });
      return void fail400(res, 'The agreement has expired or does not match. Please start again and agree to the estimate.', 403);
    }
    // 2) spending guards
    if ([...jobs.values()].some((j) => j.state === 'running')) return void fail400(res, 'An AI generation is already running. Please wait for it to finish.', 409);
    const dayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    if ((await audit!.countSince(dayStart, 'ai_start')) >= cfg.web.aiDailyLimit) {
      void rec(req, { event: 'denied', entityType: `docs_${kind}`, entityName: g.project, user: g.ds.s.u, description: `AI generation refused: daily limit of ${cfg.web.aiDailyLimit} runs reached` });
      return void fail400(res, `The daily limit of ${cfg.web.aiDailyLimit} AI runs has been reached. It resets at 00:00 UTC.`, 429);
    }
    usedConsents.set(c.n, c.exp);
    for (const [n, exp] of usedConsents) if (exp < Date.now() / 1000) usedConsents.delete(n);
    void rec(req, {
      event: 'ai_start',
      entityType: `docs_${kind}`,
      entityName: g.project,
      user: g.ds.s.u,
      description: `Agreed to use AI (${d.facts.map((f) => `${f[0]}: ${f[1]}`).join('; ')})`,
    });
    void runJob(g.project, kind, g.ds.s.u, clientIp(req), g.gl?.name ?? null);
    res.status(202).json({ started: true });
  });

  router.get('/p/:project/api/status', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const j = jobs.get(g.project);
    res.setHeader('Cache-Control', 'no-store');
    res.json(j ? { state: j.state, kind: j.kind, seconds: Math.round((Date.now() - j.startedAt) / 1000), error: j.error, warning: j.warning } : { state: 'idle' });
  });

  // PDF: no AI, no cost — cover, index, article and the latest diagram.
  router.post('/p/:project/api/pdf', async (req, res) => {
    const g = await gate(req, res);
    if (!g || !docsApiOk(req, res)) return;
    const wiki = await docStore!.latest(g.project, 'wiki');
    if (!wiki) return void fail400(res, 'Generate the documentation first.');
    if ([...jobs.values()].some((j) => j.state === 'running' && j.kind === 'pdf')) return void fail400(res, 'A PDF is already being built.', 409);
    jobs.set(g.project + ':pdf', { kind: 'pdf', state: 'running', startedAt: Date.now() });
    try {
      const diagram = await docStore!.latest(g.project, 'diagram');
      // the pictures in page order: the overview first, then the detail pictures; every one gets a page after the index
      const pics: NonNullable<PdfInput['diagrams']> = [];
      type Vector = NonNullable<NonNullable<PdfInput['diagrams']>[number]['vector']>;
      const vector = (plan: DiagramPlan): Vector => {
        const scene = layout(plan);
        return { width: scene.width, height: scene.height, draw: (d, x, y, s) => drawScene(d, scene, x, y, s) };
      };
      if (diagram) {
        const made = `Created ${diagram.generatedAt.slice(0, 16).replace('T', ' ')} UTC by ${diagram.model}`;
        if (diagram.ext === 'svg' && diagram.plan) {
          // drawn by Mnemosyne: the PDF paints the same plans as vectors (sharp at any zoom, selectable text)
          pics.push({ name: 'Workflow diagram', caption: made, vector: vector(diagram.plan) });
          for (const p of diagram.pictures ?? []) pics.push({ name: `Diagram: ${p.name}`, caption: `${p.name} - ${made}`, vector: vector(p.plan) });
        } else if (diagram.ext !== 'svg') {
          const png = await toPdfImage({ bytes: await docStore!.read(diagram), mime: diagram.ext === 'png' ? 'image/png' : diagram.ext === 'jpg' ? 'image/jpeg' : 'image/webp' });
          if (png) pics.push({ name: 'Workflow diagram', caption: made, png });
        }
      }
      const markdown = redact((await docStore!.read(wiki)).toString('utf8')) + historyMarkdown(changeHistory(await nodeIndex!.inProject(g.project)));
      const pdf = await buildPdf({
        title: g.project,
        subtitle: g.subtitle,
        generatedAt: wiki.generatedAt,
        model: wiki.model,
        noteCount: wiki.noteCount ?? 0,
        markdown,
        diagrams: pics,
      });
      const meta: DocMeta = await docStore!.save({ kind: 'pdf', project: g.project, model: wiki.model, by: g.ds.s.u, basedOn: wiki.id, diagram: pics.length ? diagram?.id : undefined, noteCount: wiki.noteCount, ext: 'pdf' }, pdf);
      void rec(req, { event: 'create', entityType: 'docs_pdf', entityId: meta.id, entityName: g.project, user: g.ds.s.u, description: `Project PDF built from the article of ${wiki.generatedAt.slice(0, 16).replace('T', ' ')} UTC${pics.length ? ` with ${pics.length === 1 ? 'the workflow diagram' : `${pics.length} diagram pages`}` : ''}` });
      res.json({ id: meta.id });
    } catch (err) {
      console.error('pdf:', (err as Error).message);
      fail400(res, 'The PDF could not be built.', 500);
    } finally {
      jobs.delete(g.project + ':pdf');
    }
  });

  // One raw note (administrators only).
  router.get('/p/:project/:id', async (req, res) => {
    const g = await gate(req, res, true);
    if (!g) return;
    const { ds, project } = g;
    const note = await nodeIndex!.get(project, String(req.params.id));
    if (!note) return notFound(res, ds, 'This note does not exist.');
    const related = await Promise.all(
      note.links.map(async (l) => ({ rel: l.rel, id: l.target, title: (await nodeIndex!.get(project, l.target))?.title ?? null })),
    );
    void rec(req, { event: 'view', entityType: 'docs_note', entityId: note.id, entityName: note.title, user: ds.s.u, description: `Opened a note of ${project}` });
    pageHeaders(res);
    res.send(
      nodePage({
        basePath,
        user: { name: ds.s.n, username: ds.s.u, admin: ds.m.admin },
        project,
        title: note.title,
        type: note.type,
        status: note.status,
        observedAt: note.observed_at,
        components: note.components,
        authors: note.authors,
        bodyHtml: renderMarkdown(redact(note.body)),
        links: related,
        codeRefs: note.code_refs.map((r) => `${r.repo}: ${r.path}${r.line ? `:${r.line}` : ''}`),
      }),
    );
  });

  mountSso({
    prefix: '',
    label: 'public',
    scope: 'read_user read_api',
    oauthCookie: OAUTH_COOKIE,
    sessionCookie: SESSION_COOKIE,
    sessionPath: cookiePath,
    failTo: `${basePath}/`,
    admit: async () => ({ to: `${basePath}/` }),
    warm: async (accessToken) => fetchMemberships((await effective()).gitlab.url!, accessToken),
    sessionTtlS: DOCS_SESSION_TTL_S,
    after: async (user, _accessToken, warmed, refreshToken) => {
      const projects = ((await warmed?.catch(() => null)) ?? null) as GitLabProject[] | null;
      members.set(user.username, { at: Date.now(), admin: user.admin, projects, refresh: refreshToken });
      persistMembers();
    },
  });

  router.post('/auth/logout', (req, res) => {
    const who = sessionFrom(req, SESSION_COOKIE);
    if (who) {
      members.delete(who.u);
      persistMembers();
      void rec(req, { event: 'logout', entityType: 'public_session', user: who.u, description: 'Signed out' });
    }
    clearCookie(res, SESSION_COOKIE);
    noStore(res);
    res.redirect(303, `${basePath}/`);
  });

  // =========================================================================
  // ADMIN AREA — everything under `/admin/*`: its own sign-in (built-in local account and
  // GitLab instance administrators), its own session cookie, its own API. Self-contained on purpose.
  // =========================================================================
  const adminBase = `${basePath}/admin`;
  const adminCookiePath = adminBase;
  const adminSession = (req: Request) => sessionFrom(req, ADMIN_COOKIE);

  const adminLogin = async (req: Request, res: Response, error?: string) => {
    const eff = keys ? await effective() : null;
    pageHeaders(res);
    res.send(
      loginPage({
        basePath,
        configured,
        admin: true,
        local: Boolean(eff?.localActive),
        sso: Boolean(eff?.sso),
        error: error ?? (typeof req.query.error === 'string' ? req.query.error : undefined),
      }),
    );
  };

  router.post('/admin/auth/local', urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    noStore(res);
    const attempted = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 100) : '';
    const back = (error: string, why: string) => {
      void rec(req, { event: 'login_failed', entityType: 'admin_local', user: attempted || 'anonymous', description: why });
      res.redirect(`${adminBase}/?error=${error}`);
    };
    if (!keys || !localEnabled || !originOk(req) || !(await effective()).localActive) {
      back('local', 'Local admin sign-in refused (disabled, or request from another origin)');
      return;
    }
    const ip = clientIp(req);
    const now = Date.now();
    const m = misses.get(ip);
    if (m && m.n >= 5 && m.until > now) {
      back('throttled', 'Locked out: too many wrong passwords from this address');
      return;
    }
    const user = attempted;
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
    // Always run the hash check so a wrong user name costs the same as a wrong password.
    const passwordOk = verifyPassword(password, localHash);
    if (!(passwordOk && user.toLowerCase() === localUser.toLowerCase())) {
      misses.set(ip, { n: (m && m.until > now ? m.n : 0) + 1, until: now + 60_000 });
      back('local', 'Wrong user name or password');
      return;
    }
    misses.delete(ip);
    void rec(req, { event: 'login', entityType: 'admin_local', entityName: 'Local administrator', user: localUser, description: 'Signed in with the built-in local admin account' });
    setCookie(
      res,
      ADMIN_COOKIE,
      signToken(keys.sign, {
        u: localUser,
        n: 'Local administrator',
        e: '',
        l: true,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
      } satisfies Session),
      SESSION_TTL_S,
      adminCookiePath,
    );
    res.redirect(303, `${adminBase}/`);
  });

  mountSso({
    prefix: '/admin',
    label: 'admin',
    scope: 'read_user',
    oauthCookie: ADMIN_OAUTH_COOKIE,
    sessionCookie: ADMIN_COOKIE,
    sessionPath: adminCookiePath,
    failTo: `${adminBase}/`,
    admit: async (user, eff) => {
      // Admin rights come from GitLab itself: only a GitLab instance administrator gets in.
      if (!user.admin) return { error: 'noadmin' };
      // First successful GitLab admin sign-in proves SSO works: starts the 24h life of the local account.
      if (!eff.ssoLiveAt) {
        await settings!.update((st) => {
          st.ssoLiveAt ??= Math.floor(Date.now() / 1000);
        });
      }
      return { to: `${adminBase}/` };
    },
  });

  router.post('/admin/auth/logout', (req, res) => {
    const who = adminSession(req);
    if (who) void rec(req, { event: 'logout', entityType: 'admin_session', user: who.u, description: 'Signed out of admin' });
    clearCookie(res, ADMIN_COOKIE, adminCookiePath);
    noStore(res);
    res.redirect(303, `${adminBase}/`);
  });

  const requireAdminPage = async (req: Request, res: Response, next: NextFunction) => {
    const s = adminSession(req);
    if (!s || (s.l && !(await effective()).localActive)) {
      await adminLogin(req, res);
      return;
    }
    next();
  };

  const requireAdminApi = async (req: Request, res: Response, next: NextFunction) => {
    noStore(res);
    const s = adminSession(req);
    if (!s || (s.l && !(await effective()).localActive)) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    // State-changing calls must come from our own page: SameSite=Lax already blocks
    // cross-site cookies; the custom header and Origin check are defence in depth.
    if (req.method !== 'GET' && (req.header('x-requested-with') !== 'mnemosyne-admin' || !originOk(req))) {
      void rec(req, { event: 'denied', entityType: 'admin_api', user: s.u, description: `Cross-site request refused: ${req.method} ${req.path}` });
      res.status(403).json({ error: 'cross-site request refused' });
      return;
    }
    next();
  };

  router.get('/admin', requireAdminPage, (req, res) => {
    const s = adminSession(req)!;
    const nonce = randomBytes(16).toString('base64');
    pageHeaders(res, nonce);
    res.send(
      adminPage({
        basePath,
        nonce,
        user: { name: s.n, username: s.u },
        redirectUris: [here('/auth/callback'), here('/admin/auth/callback')],
      }),
    );
  });

  const api = Router();
  api.use(requireAdminApi);
  router.use('/admin/api', api);

  const handle =
    (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
      try {
        res.json(await fn(req, res));
      } catch (err) {
        if (err instanceof ProviderValidationError || err instanceof SettingsValidationError) res.status(400).json({ error: err.message });
        else res.status(500).json({ error: 'internal error' });
      }
    };

  const who = (req: Request) => adminSession(req)?.u ?? 'unknown';

  api.get('/providers', handle(() => providers!.list()));

  // Step 3: every job (text / images / pdf) as one block - model, limits, sampling values and the prompts, all editable.
  const jobView = async () => {
    const list = await providers!.list();
    return Object.fromEntries(
      ROLES.map((role) => [role, { def: JOB_DEFS[role], settings: list.jobs[role] ?? {}, effective: effectiveJob(role, list.jobs[role]), assignment: list.assignments[role] ?? null }]),
    );
  };
  api.get('/llm/jobs', handle(async () => ({ jobs: await jobView() })));
  api.put(
    '/llm/jobs/:role',
    handle(async (req) => {
      const role = String(req.params.role) as Role;
      if (!ROLES.includes(role)) throw new ProviderValidationError('unknown job');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const settings = validateJobSettings(role, body);
      const names = new Map((await providers!.list()).providers.map((p) => [p.id, p.label]));
      const flat = (a: { providerId: string; model: string } | undefined | null, st: JobSettings): Record<string, unknown> => {
        const e = effectiveJob(role, st);
        const chars = (t: string, d: string) => (t === d ? 'built-in default' : `${t.length} characters: ${JSON.stringify(t.slice(0, 70))}…`);
        return {
          model: a ? `${names.get(a.providerId) ?? a.providerId} / ${a.model}` : undefined,
          maxTokens: e.maxTokens,
          temperature: e.temperature ?? 'provider default',
          topP: e.topP ?? 'provider default',
          timeoutMinutes: e.timeoutMinutes,
          systemPrompt: chars(e.systemPrompt, JOB_DEFS[role].defaults.systemPrompt),
          userPrompt: chars(e.userPrompt, JOB_DEFS[role].defaults.userPrompt),
        };
      };
      const before = await providers!.list();
      const saved = await providers!.setJob(role, (body.model ?? null) as { providerId?: unknown; model?: unknown } | null, settings);
      void rec(req, {
        event: 'update',
        entityType: 'llm_job',
        entityId: role,
        entityName: JOB_DEFS[role].title,
        user: who(req),
        changes: diffLines(flat(before.assignments[role], before.jobs[role] ?? {}), flat(saved.assignment, saved.settings)),
        description: `AI job “${JOB_DEFS[role].title}”: model, limits and prompts saved`,
      });
      return { jobs: await jobView() };
    }),
  );
  api.post(
    '/providers',
    handle(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const before = typeof body.id === 'string' ? await providers!.getFull(body.id).catch(() => null) : null;
      const saved = await providers!.upsert(body);
      const now = { label: saved.label, kind: saved.kind, baseUrl: saved.baseUrl };
      const keyChanged = typeof body.apiKey === 'string' && body.apiKey.trim() !== '';
      const changes = [diffLines(before ? { label: before.label, kind: before.kind, baseUrl: before.baseUrl } : {}, now), keyChanged ? '+ apiKey: "••••" (new key stored)' : null]
        .filter(Boolean)
        .join('\n');
      void rec(req, {
        event: before ? 'update' : 'create',
        entityType: 'llm_provider',
        entityId: saved.id,
        entityName: saved.label,
        user: who(req),
        changes: changes || null,
        description: before ? 'LLM provider changed' : 'LLM provider connected',
      });
      return saved;
    }),
  );
  // Step 2 of the LLM flow: ask the provider which models this API key may use (list call only, no inference).
  api.post(
    '/providers/:id/models',
    handle(async (req) => {
      const id = String(req.params.id);
      const provider = await providers!.getFull(id);
      try {
        const saved = await providers!.setModels(id, await fetchModels(provider));
        void rec(req, { event: 'fetch', entityType: 'llm_provider', entityId: id, entityName: provider.label, user: who(req), description: `Fetched ${saved.models.length} models from the provider` });
        return saved;
      } catch (err) {
        void rec(req, { event: 'fetch_failed', entityType: 'llm_provider', entityId: id, entityName: provider.label, user: who(req), description: (err as Error).message });
        throw err;
      }
    }),
  );
  // Step 3: one model per job (text / image / pdf), chosen from the fetched lists.
  api.put(
    '/llm/assignments',
    handle(async (req) => {
      const flat = async (a: Record<string, { providerId: string; model: string } | undefined>) => {
        const names = new Map((await providers!.list()).providers.map((p) => [p.id, p.label]));
        return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v ? `${names.get(v.providerId) ?? v.providerId} / ${v.model}` : undefined]));
      };
      const before = await flat((await providers!.list()).assignments);
      const next = await providers!.setAssignments(req.body ?? {});
      void rec(req, {
        event: 'update',
        entityType: 'llm_assignment',
        entityName: 'Models per job',
        user: who(req),
        changes: diffLines(before, await flat(next)),
        description: 'Model choices for text / images / PDF saved',
      });
      return next;
    }),
  );
  api.delete(
    '/providers/:id',
    handle(async (req) => {
      const id = String(req.params.id);
      const label = (await providers!.getFull(id).catch(() => null))?.label ?? id;
      await providers!.remove(id);
      void rec(req, { event: 'delete', entityType: 'llm_provider', entityId: id, entityName: label, user: who(req), description: 'LLM provider and its stored key removed' });
      return { ok: true };
    }),
  );

  api.get(
    '/settings',
    handle(async () => {
      const eff = await effective();
      const secret = eff.gitlab.clientSecret ?? '';
      return {
        gitlabUrl: eff.gitlab.url ?? '',
        clientId: eff.gitlab.clientId ?? '',
        hasSecret: secret.length > 0,
        secretHint: secret.length >= 12 ? `••••${secret.slice(-4)}` : secret ? '••••' : '',
        ssoActive: eff.sso,
        redirectUris: [here('/auth/callback'), here('/admin/auth/callback')],
        localUser: eff.localActive ? localUser : null,
      };
    }),
  );
  api.put(
    '/settings',
    handle(async (req) => {
      const before = await effective();
      await settings!.update((st) => applyPortalInput(st, req.body ?? {}));
      const after = await effective();
      const secretChanged = typeof req.body?.clientSecret === 'string' && req.body.clientSecret.trim() !== '';
      const changes = [
        diffLines({ gitlabUrl: before.gitlab.url, clientId: before.gitlab.clientId }, { gitlabUrl: after.gitlab.url, clientId: after.gitlab.clientId }),
        secretChanged ? '+ clientSecret: "••••" (new secret stored)' : null,
      ]
        .filter(Boolean)
        .join('\n');
      void rec(req, { event: 'update', entityType: 'sso', entityName: 'GitLab SSO', user: who(req), changes: changes || null, description: after.sso ? 'GitLab SSO settings saved (active)' : 'GitLab SSO settings saved (not complete yet)' });
      return { ok: true };
    }),
  );

  // Audit trail, newest first (same columns as the CenTest / load-balancer audit view).
  api.get(
    '/audit',
    handle((req) => audit!.list({ q: typeof req.query.q === 'string' ? req.query.q : '', offset: Number(req.query.offset) || 0, limit: Number(req.query.limit) || undefined })),
  );

  return { router, providers };
}
