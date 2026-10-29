import { createHash, randomBytes } from 'node:crypto';
import { Router, urlencoded, type NextFunction, type Request, type Response } from 'express';
import type { MnemosyneConfig } from './config.js';
import { MIN_SECRET_LENGTH, deriveKeys, hashPassword, signToken, verifyPassword, verifyToken, type DerivedKeys } from './secrets.js';
import { ProviderStore, ProviderValidationError } from './provider-store.js';
import { fetchModels } from './llm-models.js';
import { AuditLog, clientIp, diffLines, type AuditInput } from './audit.js';
import { SettingsStore, SettingsValidationError, applyPortalInput, type GitLabSettings, type PortalSettings } from './settings-store.js';
import { adminPage, docsNotFound, homePage, loginPage, nodePage, projectPage, type ProjectCard } from './web-pages.js';
import { NodeIndex, fetchMemberships, matchProject, redact, type GitLabProject } from './docs.js';
import { renderMarkdown } from './markdown.js';
import { LOGO_WEBP_BASE64 } from './web-assets.js';

// Two independent sign-in systems: the public page (cookie below) and the admin area
// (own cookie, own routes under /admin/*) so the admin can later be served by a different
// implementation without touching the public side.
const SESSION_COOKIE = 'mnemosyne_session';
const ADMIN_COOKIE = 'mnemosyne_admin';
const OAUTH_COOKIE = 'mnemosyne_oauth';
const ADMIN_OAUTH_COOKIE = 'mnemosyne_admin_oauth';
const SESSION_TTL_S = 8 * 3600;
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
    after?: (user: SsoUser, accessToken: string) => Promise<void>;
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
        const token = (await tokenRes.json()) as { access_token?: string };
        if (!tokenRes.ok || !token.access_token) throw new Error(`token exchange failed (${tokenRes.status})`);

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
            exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
          } satisfies Session),
          SESSION_TTL_S,
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
  const members = new Map<string, { at: number; admin: boolean; projects: GitLabProject[] | null }>();

  const docsSession = (req: Request) => {
    const s = sessionFrom(req, SESSION_COOKIE);
    const m = s ? members.get(s.u) : undefined;
    return s && m && Date.now() - m.at < SESSION_TTL_S * 1000 ? { s, m } : null;
  };
  /** Administrators see every project; others only those that match a GitLab project they belong to. */
  const canRead = (m: { admin: boolean; projects: GitLabProject[] | null }, project: string) =>
    m.admin || (m.projects !== null && matchProject(project, m.projects) !== null);

  router.get('/', async (req, res) => {
    const ds = docsSession(req);
    pageHeaders(res);
    if (ds && nodeIndex) {
      const cards: ProjectCard[] = (await nodeIndex.projects())
        .filter((p) => canRead(ds.m, p.project))
        .map((p) => {
          const gl = ds.m.projects ? matchProject(p.project, ds.m.projects) : null;
          return {
            title: gl?.name ?? p.project,
            sub: gl ? gl.fullPath : 'no GitLab project',
            count: p.count,
            updated: p.updated,
            href: `${basePath}/p/${encodeURIComponent(p.project)}`,
            adminOnly: ds.m.admin && !gl,
          };
        })
        .sort((x, y) => x.title.localeCompare(y.title));
      res.send(
        homePage({
          basePath,
          user: { name: ds.s.n, username: ds.s.u },
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
    res.status(404).send(docsNotFound(basePath, { name: ds.s.n, username: ds.s.u }, msg));
  };

  router.get('/p/:project', async (req, res) => {
    const ds = docsSession(req);
    if (!ds || !nodeIndex) {
      res.redirect(`${basePath}/`);
      return;
    }
    const project = String(req.params.project);
    if (!canRead(ds.m, project)) {
      void rec(req, { event: 'denied', entityType: 'docs_project', entityName: project, user: ds.s.u, description: 'Project documentation refused (not a member of the matching GitLab project)' });
      notFound(res, ds, 'This project does not exist, or you are not a member of it in GitLab.');
      return;
    }
    const all = await nodeIndex.inProject(project);
    if (!all.length) {
      notFound(res, ds, 'This project does not exist, or you are not a member of it in GitLab.');
      return;
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    const needle = q.toLowerCase();
    const hits = needle ? all.filter((n) => [n.title, n.body, ...n.components].some((t) => t.toLowerCase().includes(needle))) : all;
    const gl = ds.m.projects ? matchProject(project, ds.m.projects) : null;
    void rec(req, { event: 'view', entityType: 'docs_project', entityName: project, user: ds.s.u, description: q ? `Searched project documentation for “${q}”` : 'Opened project documentation' });
    pageHeaders(res);
    res.send(
      projectPage({
        basePath,
        user: { name: ds.s.n, username: ds.s.u },
        project,
        subtitle: gl ? `GitLab project ${gl.fullPath}` : 'No matching GitLab project — visible to GitLab administrators only',
        q,
        total: all.length,
        notes: hits
          .map((n) => ({ id: n.id, title: n.title, type: n.type, status: n.status, observed_at: n.observed_at }))
          .sort((x, y) => (y.observed_at ?? '').localeCompare(x.observed_at ?? '') || x.title.localeCompare(y.title)),
      }),
    );
  });

  router.get('/p/:project/:id', async (req, res) => {
    const ds = docsSession(req);
    if (!ds || !nodeIndex) {
      res.redirect(`${basePath}/`);
      return;
    }
    const project = String(req.params.project);
    const note = canRead(ds.m, project) ? await nodeIndex.get(project, String(req.params.id)) : null;
    if (!note) {
      if (!canRead(ds.m, project)) void rec(req, { event: 'denied', entityType: 'docs_note', entityName: project, entityId: String(req.params.id), user: ds.s.u, description: 'Note refused (not a member of the matching GitLab project)' });
      notFound(res, ds, 'This note does not exist, or you are not a member of its project in GitLab.');
      return;
    }
    const related = await Promise.all(
      note.links.map(async (l) => ({ rel: l.rel, id: l.target, title: (await nodeIndex.get(project, l.target))?.title ?? null })),
    );
    void rec(req, { event: 'view', entityType: 'docs_note', entityId: note.id, entityName: note.title, user: ds.s.u, description: `Opened a note of ${project}` });
    pageHeaders(res);
    res.send(
      nodePage({
        basePath,
        user: { name: ds.s.n, username: ds.s.u },
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
    after: async (user, accessToken) => {
      const eff = await effective();
      members.set(user.username, { at: Date.now(), admin: user.admin, projects: await fetchMemberships(eff.gitlab.url!, accessToken) });
    },
  });

  router.post('/auth/logout', (req, res) => {
    const who = sessionFrom(req, SESSION_COOKIE);
    if (who) {
      members.delete(who.u);
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
    handle((req) => audit!.list({ q: typeof req.query.q === 'string' ? req.query.q : '', offset: Number(req.query.offset) || 0 })),
  );

  return { router, providers };
}
