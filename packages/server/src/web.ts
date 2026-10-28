import { createHash, randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { MnemosyneConfig } from './config.js';
import { MIN_SECRET_LENGTH, deriveKeys, signToken, verifyToken, type DerivedKeys } from './secrets.js';
import { ProviderStore, ProviderValidationError } from './provider-store.js';
import { adminPage, loginPage } from './web-pages.js';
import { LOGO_WEBP_BASE64 } from './web-assets.js';

const SESSION_COOKIE = 'mnemosyne_session';
const OAUTH_COOKIE = 'mnemosyne_oauth';
const SESSION_TTL_S = 8 * 3600;
const OAUTH_TTL_S = 10 * 60;
const GITLAB_TIMEOUT_MS = 10_000;

interface Session {
  u: string; // GitLab username
  n: string; // display name
  e: string; // e-mail
  a: boolean; // may use /admin
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
  return Boolean(
    w.secret && w.secret.length >= MIN_SECRET_LENGTH && w.publicUrl && w.gitlab.url && w.gitlab.clientId && w.gitlab.clientSecret,
  );
}

/**
 * Public login screen at `/`, GitLab OAuth under `/auth/*`, and the admin area
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

  const setCookie = (res: Response, name: string, value: string, maxAgeS: number, path = cookiePath) =>
    res.append(
      'Set-Cookie',
      `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
  const clearCookie = (res: Response, name: string, path = cookiePath) => setCookie(res, name, '', 0, path);

  const sessionOf = (req: Request): Session | null =>
    keys ? verifyToken<Session>(keys.sign, parseCookies(req.header('cookie'))[SESSION_COOKIE]) : null;

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

  // --- public login screen ----------------------------------------------
  router.get('/', (req, res) => {
    const s = sessionOf(req);
    pageHeaders(res);
    res.send(
      loginPage({
        basePath,
        configured,
        error: typeof req.query.error === 'string' ? req.query.error : undefined,
        user: s ? { name: s.n, username: s.u, admin: s.a } : undefined,
      }),
    );
  });

  // --- GitLab OAuth (authorization code + PKCE) ---------------------------
  const redirectUri = `${cfg.web.publicUrl ?? ''}${basePath}/auth/callback`;
  const fail = (res: Response, error: string) => {
    clearCookie(res, OAUTH_COOKIE, `${cookiePath === '/' ? '' : cookiePath}/auth`);
    res.redirect(`${basePath}/?error=${error}`);
  };

  router.get('/auth/login', (_req, res) => {
    if (!keys) {
      res.redirect(`${basePath}/`);
      return;
    }
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    setCookie(
      res,
      OAUTH_COOKIE,
      signToken(keys.sign, { state, verifier, exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_S } satisfies OAuthState),
      OAUTH_TTL_S,
      `${cookiePath === '/' ? '' : cookiePath}/auth`,
    );
    const url = new URL(`${cfg.web.gitlab.url}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: cfg.web.gitlab.clientId!,
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

  router.get('/auth/callback', async (req, res) => {
    if (!keys) {
      res.redirect(`${basePath}/`);
      return;
    }
    const pending = verifyToken<OAuthState>(keys.sign, parseCookies(req.header('cookie'))[OAUTH_COOKIE]);
    if (!pending || typeof req.query.state !== 'string' || req.query.state !== pending.state) {
      fail(res, 'state');
      return;
    }
    if (typeof req.query.code !== 'string') {
      fail(res, 'denied');
      return;
    }
    try {
      const tokenRes = await fetch(`${cfg.web.gitlab.url}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: cfg.web.gitlab.clientId!,
          client_secret: cfg.web.gitlab.clientSecret!,
          code: req.query.code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
      });
      const token = (await tokenRes.json()) as { access_token?: string };
      if (!tokenRes.ok || !token.access_token) throw new Error(`token exchange failed (${tokenRes.status})`);

      const userRes = await fetch(`${cfg.web.gitlab.url}/api/v4/user`, {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
      });
      const user = (await userRes.json()) as GitLabUser;
      if (!userRes.ok || !user.username) throw new Error(`user lookup failed (${userRes.status})`);
      if (user.state && user.state !== 'active') {
        fail(res, 'denied');
        return;
      }

      const ids = [user.username, user.email].filter(Boolean).map((s) => s!.toLowerCase());
      const admin = ids.some((id) => cfg.web.adminUsers.includes(id));
      setCookie(
        res,
        SESSION_COOKIE,
        signToken(keys.sign, {
          u: user.username,
          n: user.name ?? user.username,
          e: user.email ?? '',
          a: admin,
          exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
        } satisfies Session),
        SESSION_TTL_S,
      );
      clearCookie(res, OAUTH_COOKIE, `${cookiePath === '/' ? '' : cookiePath}/auth`);
      noStore(res);
      res.redirect(admin ? `${basePath}/admin/` : `${basePath}/`);
    } catch {
      fail(res, 'gitlab');
    }
  });

  router.post('/auth/logout', (_req, res) => {
    clearCookie(res, SESSION_COOKIE);
    noStore(res);
    res.redirect(303, `${basePath}/`);
  });

  // --- admin ------------------------------------------------------------
  const requireAdminPage = (req: Request, res: Response, next: NextFunction) => {
    const s = sessionOf(req);
    if (!s || !s.a) {
      res.redirect(`${basePath}/`);
      return;
    }
    next();
  };

  const requireAdminApi = (req: Request, res: Response, next: NextFunction) => {
    noStore(res);
    const s = sessionOf(req);
    if (!s) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    if (!s.a) {
      res.status(403).json({ error: 'admin rights required' });
      return;
    }
    // State-changing calls must come from our own page: SameSite=Lax already blocks
    // cross-site cookies; the custom header and Origin check are defence in depth.
    if (req.method !== 'GET') {
      const origin = req.header('origin');
      if (req.header('x-requested-with') !== 'mnemosyne-admin' || (origin && origin !== new URL(cfg.web.publicUrl!).origin)) {
        res.status(403).json({ error: 'cross-site request refused' });
        return;
      }
    }
    next();
  };

  router.get('/admin', requireAdminPage, (req, res) => {
    const s = sessionOf(req)!;
    const nonce = randomBytes(16).toString('base64');
    pageHeaders(res, nonce);
    res.send(
      adminPage({
        basePath,
        nonce,
        user: { name: s.n, username: s.u },
        gitlabUrl: cfg.web.gitlab.url!,
        adminUsers: cfg.web.adminUsers,
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
        if (err instanceof ProviderValidationError) res.status(400).json({ error: err.message });
        else res.status(500).json({ error: 'internal error' });
      }
    };

  api.get('/providers', handle(() => providers!.list()));
  api.post('/providers', handle((req) => providers!.upsert(req.body ?? {})));
  api.post('/providers/:id/activate', handle(async (req) => (await providers!.activate(String(req.params.id)), { ok: true })));
  api.delete('/providers/:id', handle(async (req) => (await providers!.remove(String(req.params.id)), { ok: true })));

  return { router, providers };
}
