import { createHash, randomBytes } from 'node:crypto';
import { Router, urlencoded, type NextFunction, type Request, type Response } from 'express';
import type { MnemosyneConfig } from './config.js';
import { MIN_SECRET_LENGTH, deriveKeys, hashPassword, signToken, verifyPassword, verifyToken, type DerivedKeys } from './secrets.js';
import { ProviderStore, ProviderValidationError } from './provider-store.js';
import { fetchModels } from './llm-models.js';
import { AuditLog, clientIp, diffLines, type AuditInput } from './audit.js';
import { SettingsStore, SettingsValidationError, applyPortalInput, type GitLabSettings, type PortalSettings } from './settings-store.js';
import { adminPage, docsNotFound, homePage, loginPage, nodePage, notesPage, projectHome, type ProjectCard } from './web-pages.js';
import { NodeIndex, fetchMemberships, matchProject, redact, slug, type GitLabProject } from './docs.js';
import { outline, renderMarkdown } from './markdown.js';
import { DocStore, IMAGE_PRICE_USD, approxTokens, buildDiagramBriefPrompt, buildWikiPrompt, changeHistory, estimateText, historyMarkdown, missingSections, toPdfImage, type DocMeta } from './docgen.js';
import { chat } from './llm-call-chat.js';
import { generateImage } from './llm-call-image.js';
import { buildPdf } from './pdf.js';
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
    after?: (user: SsoUser, accessToken: string, warmed: Promise<unknown> | undefined) => Promise<void>;
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
        const token = (await tokenRes.json()) as { access_token?: string };
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
              adminOnly: ds.m.admin && !gl,
            } as ProjectCard,
          };
        });
      // every GitLab project the person belongs to is listed, also those nobody has written a note for yet
      const withNotes = new Set(fromNotes.map((x) => x.gl?.id).filter((id) => id !== undefined));
      const empty: ProjectCard[] = (ds.m.projects ?? [])
        .filter((g) => !withNotes.has(g.id))
        .map((g) => ({ title: g.name, sub: g.fullPath, count: 0, updated: null, href: `${basePath}/p/${encodeURIComponent(slug(g.path))}`, adminOnly: false }));
      const cards: ProjectCard[] = [...fromNotes.map((x) => x.card), ...empty].sort((x, y) => x.title.localeCompare(y.title));
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
    const ds = docsSession(req);
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
      wiki = { meta: wanted, html: renderMarkdown(text), toc: outline(text) };
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
        user: { name: ds.s.n, username: ds.s.u },
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
        user: { name: g.ds.s.n, username: g.ds.s.u },
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
    res.setHeader('Content-Type', meta.ext === 'png' ? 'image/png' : meta.ext === 'jpg' ? 'image/jpeg' : 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(await docStore!.read(meta));
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
    if (kind === 'wiki') {
      if (!(await nodeIndex!.inProject(project)).length) return { error: 'This project has no notes yet, so there is nothing to write the documentation from.' };
      const gl = null as null;
      const prompt = buildWikiPrompt(project, gl, await nodeIndex!.inProject(project));
      const est = estimateText(text.model, prompt.inputTokens, 12000);
      return {
        key: `${text.provider.id}:${text.model}`,
        what: `Mnemosyne will send this project's notes (credentials masked first) to ${text.provider.label} and ask the AI to write the project page: product description, hardware and software requirements, and disaster-recovery documentation.`,
        facts: [
          ['Provider', `${text.provider.label}`],
          ['Model', text.model],
          ['Notes sent', `${prompt.noteCount}`],
          ['Size', `about ${prompt.inputTokens.toLocaleString('en-US')} tokens in, up to 12,000 out`],
          ['Estimated cost', est.usd === null ? 'unknown (no list price for this model)' : `about $${est.usd < 0.01 ? '<0.01' : est.usd.toFixed(2)}`],
        ],
        usd: est.usd,
      };
    }
    const wiki = await docStore!.latest(project, 'wiki');
    if (!wiki) return { error: 'Generate the documentation first.' };
    const image = await providers!.getAssigned('image');
    if (!image) return { error: 'Choose a model for Images in Admin → LLM first.' };
    const wikiChars = Math.min((await docStore!.read(wiki)).length, 60_000);
    const est = estimateText(text.model, approxTokens(wikiChars) + 400, 600);
    const usd = (est.usd ?? 0) + IMAGE_PRICE_USD;
    return {
      key: `${text.provider.id}:${text.model}|${image.provider.id}:${image.model}`,
      what: `Two AI calls: ${text.provider.label} first turns the article into a drawing brief, then ${image.provider.label} draws the workflow diagram from it.`,
      facts: [
        ['Text model', `${text.provider.label} / ${text.model}`],
        ['Image model', `${image.provider.label} / ${image.model}`],
        ['Based on', `the article from ${wiki.generatedAt.slice(0, 16).replace('T', ' ')} UTC`],
        ['Estimated cost', `about $${usd.toFixed(2)} (one image at about $${IMAGE_PRICE_USD.toFixed(2)})`],
      ],
      usd,
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
        const prompt = buildWikiPrompt(project, glName, await nodeIndex!.inProject(project));
        const out = await chat(text.provider, text.model, prompt.system, prompt.user, { maxTokens: 12000 });
        const meta = await docStore!.save(
          { kind: 'wiki', project, model: `${text.provider.label} / ${text.model}`, by: user, noteCount: prompt.noteCount, inputTokens: out.inputTokens, outputTokens: out.outputTokens, ext: 'md' },
          redact(stripFence(out.text)),
        );
        const missing = missingSections(out.text);
        if (missing.length) warning = `The article was saved, but the AI left out: ${missing.join(', ')}. Click “Regenerate documentation” to try again.`;
        void log({ event: 'ai_done', entityId: meta.id, description: `Article written by ${meta.model} from ${prompt.noteCount} notes (${out.inputTokens} tokens in, ${out.outputTokens} out)${missing.length ? `; MISSING SECTIONS: ${missing.join(', ')}` : ''}` });
      } else {
        const wiki = (await docStore!.latest(project, 'wiki'))!;
        const image = (await providers!.getAssigned('image'))!;
        const wikiText = (await docStore!.read(wiki)).toString('utf8');
        const brief = buildDiagramBriefPrompt(project, wikiText);
        const prompt = await chat(text.provider, text.model, brief.system, brief.user, { maxTokens: 700 });
        const img = await generateImage(image.provider, image.model, redact(prompt.text.trim()).slice(0, 3500));
        const ext = img.mime === 'image/png' ? 'png' : img.mime === 'image/jpeg' ? 'jpg' : 'webp';
        const meta = await docStore!.save(
          { kind: 'diagram', project, model: `${image.provider.label} / ${image.model}`, by: user, basedOn: wiki.id, inputTokens: prompt.inputTokens, outputTokens: prompt.outputTokens, ext },
          img.bytes,
        );
        void log({ event: 'ai_done', entityId: meta.id, description: `Workflow diagram drawn by ${meta.model} (brief by ${text.model}: ${prompt.inputTokens} in, ${prompt.outputTokens} out)` });
      }
      jobs.set(project, { kind, state: 'done', startedAt: started, warning });
    } catch (err) {
      const msg = err instanceof ProviderValidationError ? err.message : 'The generation failed unexpectedly.';
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
      let png: Buffer | null = null;
      if (diagram) {
        const bytes = await docStore!.read(diagram);
        png = await toPdfImage({ bytes, mime: diagram.ext === 'png' ? 'image/png' : diagram.ext === 'jpg' ? 'image/jpeg' : 'image/webp' });
      }
      const markdown = redact((await docStore!.read(wiki)).toString('utf8')) + historyMarkdown(changeHistory(await nodeIndex!.inProject(g.project)));
      const pdf = await buildPdf({
        title: g.project,
        subtitle: g.subtitle,
        generatedAt: wiki.generatedAt,
        model: wiki.model,
        noteCount: wiki.noteCount ?? 0,
        markdown,
        diagram: diagram && png ? { png, caption: `Created ${diagram.generatedAt.slice(0, 16).replace('T', ' ')} UTC by ${diagram.model}` } : undefined,
      });
      const meta: DocMeta = await docStore!.save({ kind: 'pdf', project: g.project, model: wiki.model, by: g.ds.s.u, basedOn: wiki.id, diagram: png ? diagram?.id : undefined, noteCount: wiki.noteCount, ext: 'pdf' }, pdf);
      void rec(req, { event: 'create', entityType: 'docs_pdf', entityId: meta.id, entityName: g.project, user: g.ds.s.u, description: `Project PDF built from the article of ${wiki.generatedAt.slice(0, 16).replace('T', ' ')} UTC${png ? ' with the workflow diagram' : ''}` });
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
    warm: async (accessToken) => fetchMemberships((await effective()).gitlab.url!, accessToken),
    after: async (user, _accessToken, warmed) => {
      const projects = ((await warmed?.catch(() => null)) ?? null) as GitLabProject[] | null;
      members.set(user.username, { at: Date.now(), admin: user.admin, projects });
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
