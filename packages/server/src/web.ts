import { createHash, randomBytes } from 'node:crypto';
import { Router, urlencoded, type NextFunction, type Request, type Response } from 'express';
import type { MnemosyneConfig } from './config.js';
import { MIN_SECRET_LENGTH, deriveKeys, hashPassword, signToken, verifyPassword, verifyToken, type DerivedKeys } from './secrets.js';
import { ProviderStore, ProviderValidationError } from './provider-store.js';
import { SettingsStore, SettingsValidationError, applyPortalInput, type GitLabSettings, type PortalSettings } from './settings-store.js';
import { adminPage, loginPage } from './web-pages.js';
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
      adminUsers: st.adminUsers?.length ? st.adminUsers : cfg.web.adminUsers,
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
  }
  interface SsoArea {
    /** '' for the public area, '/admin' for the admin area. */
    prefix: string;
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
    const fail = (res: Response, error: string) => {
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
        scope: 'read_user',
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
        fail(res, 'nosso');
        return;
      }
      const pending = verifyToken<OAuthState>(keys.sign, parseCookies(req.header('cookie'))[area.oauthCookie]);
      if (!pending || typeof req.query.state !== 'string' || req.query.state !== pending.state) {
        fail(res, 'state');
        return;
      }
      if (typeof req.query.code !== 'string') {
        fail(res, 'denied');
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
          fail(res, 'denied');
          return;
        }

        const verdict = await area.admit({ username: user.username, name: user.name ?? user.username, email: user.email ?? '' }, eff);
        if ('error' in verdict) {
          fail(res, verdict.error);
          return;
        }
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
        fail(res, 'gitlab');
      }
    });
  };

  // =========================================================================
  // PUBLIC AREA — `/`: GitLab sign-in for everyone. Knows nothing about the admin.
  // =========================================================================
  router.get('/', async (req, res) => {
    const s = sessionFrom(req, SESSION_COOKIE);
    pageHeaders(res);
    res.send(
      loginPage({
        basePath,
        configured,
        local: false,
        sso: configured && (await effective()).sso,
        error: typeof req.query.error === 'string' ? req.query.error : undefined,
        user: s ? { name: s.n, username: s.u } : undefined,
      }),
    );
  });

  mountSso({
    prefix: '',
    oauthCookie: OAUTH_COOKIE,
    sessionCookie: SESSION_COOKIE,
    sessionPath: cookiePath,
    failTo: `${basePath}/`,
    admit: async () => ({ to: `${basePath}/` }),
  });

  router.post('/auth/logout', (_req, res) => {
    clearCookie(res, SESSION_COOKIE);
    noStore(res);
    res.redirect(303, `${basePath}/`);
  });

  // =========================================================================
  // ADMIN AREA — everything under `/admin/*`: its own sign-in (built-in local account and
  // GitLab admins), its own session cookie, its own API. Self-contained on purpose.
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
    const back = (error: string) => res.redirect(`${adminBase}/?error=${error}`);
    if (!keys || !localEnabled || !originOk(req) || !(await effective()).localActive) {
      back('local');
      return;
    }
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const m = misses.get(ip);
    if (m && m.n >= 5 && m.until > now) {
      back('throttled');
      return;
    }
    const user = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
    // Always run the hash check so a wrong user name costs the same as a wrong password.
    const passwordOk = verifyPassword(password, localHash);
    if (!(passwordOk && user.toLowerCase() === localUser.toLowerCase())) {
      misses.set(ip, { n: (m && m.until > now ? m.n : 0) + 1, until: now + 60_000 });
      back('local');
      return;
    }
    misses.delete(ip);
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
    oauthCookie: ADMIN_OAUTH_COOKIE,
    sessionCookie: ADMIN_COOKIE,
    sessionPath: adminCookiePath,
    failTo: `${adminBase}/`,
    admit: async (user, eff) => {
      const ids = [user.username, user.email].filter(Boolean).map((x) => x.toLowerCase());
      if (!ids.some((id) => eff.adminUsers.includes(id))) return { error: 'noadmin' };
      // First successful GitLab admin sign-in proves SSO works: starts the 24h life of the local account.
      if (!eff.ssoLiveAt) {
        await settings!.update((st) => {
          st.ssoLiveAt ??= Math.floor(Date.now() / 1000);
        });
      }
      return { to: `${adminBase}/` };
    },
  });

  router.post('/admin/auth/logout', (_req, res) => {
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

  api.get('/providers', handle(() => providers!.list()));
  api.post('/providers', handle((req) => providers!.upsert(req.body ?? {})));
  api.post('/providers/:id/activate', handle(async (req) => (await providers!.activate(String(req.params.id)), { ok: true })));
  api.delete('/providers/:id', handle(async (req) => (await providers!.remove(String(req.params.id)), { ok: true })));

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
        adminUsers: eff.adminUsers,
        ssoActive: eff.sso,
        redirectUris: [here('/auth/callback'), here('/admin/auth/callback')],
        localUser: eff.localActive ? localUser : null,
      };
    }),
  );
  api.put(
    '/settings',
    handle(async (req) => {
      await settings!.update((s) => applyPortalInput(s, req.body ?? {}));
      return { ok: true };
    }),
  );

  return { router, providers };
}
