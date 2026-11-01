import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { MnemosyneConfig } from './config.js';
import type { MnemosyneService } from './service.js';
import { buildTools } from './tools.js';
import { createMcpServer } from './mcp.js';
import { answer } from './ask.js';
import { resolveLLM } from './embedding.js';
import { createWebPortal } from './web.js';
import { TOKEN_PREFIX, type TokenStore } from './token-store.js';
import { clientIp } from './audit.js';

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Who may call MCP and REST. The shared token (if one is set) always works. A personal token (`mnm_...`, issued by a person
 * in their profile) is checked whenever it is presented, so an expired or revoked one is refused with a clear reason, never
 * waved through. A call without any token is refused when `required` (a shared token is set, or MNEMOSYNE_REQUIRE_TOKEN).
 */
function mcpAuth(opts: { shared?: string; required: boolean; tokens: TokenStore | null }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (opts.shared && supplied && sameSecret(supplied, opts.shared)) {
      next();
      return;
    }
    if (supplied.startsWith(TOKEN_PREFIX) && opts.tokens) {
      const checked = opts.tokens.check(supplied, clientIp(req));
      if (checked.ok) {
        res.locals.seat = checked.user;
        next();
        return;
      }
      res.status(401).json({ error: checked.reason === 'unknown' ? 'unauthorized' : `token ${checked.reason}` });
      return;
    }
    if (opts.required) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Express app exposing REST + MCP-over-HTTP. Auth is opt-in: set
 * MNEMOSYNE_BEARER_TOKEN to require it, leave it unset to run open (internal
 * network only — matches the sibling CodeGraph MCP server on the same box).
 */
export function createHttpApp(cfg: MnemosyneConfig, svc: MnemosyneService) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const tools = buildTools(svc);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const llm = resolveLLM(cfg);

  // Everything mounts under basePath so a single :40000 endpoint can host
  // /codegraph, /mnemosyne and other MCP services side by side, routed by path.
  const api = Router();
  app.use(cfg.http.basePath || '/', api);

  api.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'mnemosyne', embedder: svc.embedderId, llm: llm?.id ?? null });
  });

  // Web portal: public login screen + GitLab-authenticated admin. Has its own
  // auth, so it sits in front of the MCP/REST bearer check below and leaves how
  // MCP clients connect untouched.
  const portal = createWebPortal(cfg);
  api.use(portal.router);

  const required = Boolean(cfg.http.bearerToken) || cfg.http.requireToken;
  if (cfg.http.requireToken && !cfg.http.bearerToken && !portal.tokens) {
    console.warn('MNEMOSYNE_REQUIRE_TOKEN is set but the web portal is not configured: nobody can issue a token, every MCP and REST call is refused.');
  }
  if (required || portal.tokens) {
    api.use(mcpAuth({ shared: cfg.http.bearerToken, required, tokens: portal.tokens }));
  }

  // --- REST: one route per tool, plus a couple of conveniences ----------
  const call = (name: string) => async (req: Request, res: Response) => {
    try {
      const result = await byName.get(name)!.handler({ ...req.query, ...req.body });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };

  api.post('/search', call('search_memory'));
  api.get('/nodes/:id', async (req, res) => {
    try {
      res.json(await byName.get('get_node')!.handler({ id: req.params.id }));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });
  api.get('/nodes/:id/history', async (req, res) => {
    res.json(await byName.get('get_node_history')!.handler({ id: req.params.id }));
  });
  api.post('/nodes', call('create_node'));
  api.patch('/nodes/:id', async (req, res) => {
    try {
      res.json(await byName.get('update_node')!.handler({ id: req.params.id, ...req.body }));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  api.post('/link', call('link_nodes'));
  api.post('/link-code', call('link_node_to_code'));
  api.post('/neighbors', call('neighbors'));
  api.post('/reindex', call('reindex'));

  api.post('/ask', async (req, res) => {
    if (!llm) {
      res.status(501).json({ error: 'no LLM configured (set MNEMOSYNE_LLM_BASE_URL)' });
      return;
    }
    try {
      res.json(await answer(svc, llm, String(req.body?.question ?? ''), req.body?.project));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // --- MCP over Streamable HTTP (session-per-client) --------------------
  const transports = new Map<string, StreamableHTTPServerTransport>();

  api.post('/mcp', async (req: Request, res: Response) => {
    const sid = req.header('mcp-session-id');
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      await createMcpServer(tools).connect(transport);
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session; send an initialize request first.' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const bySession = async (req: Request, res: Response) => {
    const transport = transports.get(req.header('mcp-session-id') ?? '');
    if (!transport) {
      res.status(404).end();
      return;
    }
    await transport.handleRequest(req, res);
  };
  api.get('/mcp', bySession);
  api.delete('/mcp', bySession);

  return app;
}
