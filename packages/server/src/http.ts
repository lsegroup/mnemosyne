import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { MnemosyneConfig } from './config.js';
import type { MnemosyneService } from './service.js';
import { buildTools } from './tools.js';
import { createMcpServer } from './mcp.js';
import { answer } from './ask.js';
import { resolveLLM } from './embedding.js';

function bearer(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (supplied !== token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

/** Express app exposing REST + MCP-over-HTTP, both behind one bearer token. */
export function createHttpApp(cfg: MnemosyneConfig, svc: MnemosyneService) {
  if (!cfg.http.bearerToken) {
    throw new Error('HTTP mode requires MNEMOSYNE_BEARER_TOKEN');
  }
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

  api.use(bearer(cfg.http.bearerToken));

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
