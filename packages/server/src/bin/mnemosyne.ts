#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseMarkdown } from '@mnemosyne/core';
import { loadConfig } from '../config.js';
import { MnemosyneService } from '../service.js';
import { buildTools } from '../tools.js';
import { createMcpServer } from '../mcp.js';
import { createHttpApp } from '../http.js';
import { resolveLLM } from '../embedding.js';
import { extractFromHistory } from '../extract.js';

const program = new Command();
program.name('mnemosyne').description('Self-hosted AI team memory').version('0.1.0');

program
  .command('serve')
  .description('Run the server')
  .option('--stdio', 'MCP over stdio (single user / editor-spawned)')
  .option('--http', 'MCP over HTTP + REST (shared, bearer-protected)')
  .option('--repo <dir>', 'corpus/repo directory (default: cwd or $MNEMOSYNE_REPO)')
  .action(async (opts) => {
    const cfg = loadConfig(process.env, opts.repo);
    const svc = await MnemosyneService.open(cfg);
    const stdio = opts.stdio || (!opts.http && !process.stdout.isTTY);

    if (stdio) {
      const server = createMcpServer(buildTools(svc));
      await server.connect(new StdioServerTransport());
      process.stderr.write(`mnemosyne: stdio MCP ready (repo ${cfg.repoDir}, embedder ${svc.embedderId})\n`);
    } else {
      const app = createHttpApp(cfg, svc);
      app.listen(cfg.http.port, cfg.http.host, () => {
        process.stdout.write(
          `mnemosyne: http://${cfg.http.host}:${cfg.http.port}  (MCP at /mcp, REST at /, embedder ${svc.embedderId})\n`,
        );
      });
    }
  });

program
  .command('reindex')
  .description('Rebuild the search index from the markdown corpus')
  .option('--repo <dir>', 'corpus/repo directory')
  .action(async (opts) => {
    const cfg = loadConfig(process.env, opts.repo);
    const svc = await MnemosyneService.open(cfg);
    const { count, embedder } = await svc.reindex();
    await svc.close();
    process.stdout.write(`reindexed ${count} nodes with ${embedder}\n`);
  });

program
  .command('import <dir>')
  .description('Validate and ingest external node markdown files, then reindex')
  .option('--repo <dir>', 'corpus/repo directory')
  .action(async (dir, opts) => {
    const cfg = loadConfig(process.env, opts.repo);
    const svc = await MnemosyneService.open(cfg);
    const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(e.parentPath ?? dir, e.name));
    let ok = 0;
    for (const file of files) {
      const node = parseMarkdown(await readFile(file, 'utf8'));
      await svc.createNode({ ...node }).catch(async (err) => {
        if (String(err.message).includes('already exists')) {
          await svc.updateNode(node.id, { ...node });
        } else throw err;
      });
      ok++;
    }
    await svc.reindex();
    await svc.close();
    process.stdout.write(`imported ${ok}/${files.length} files\n`);
  });

program
  .command('extract')
  .description('Draft candidate nodes from recent git history (requires MNEMOSYNE_LLM_BASE_URL)')
  .requiredOption('--since <ref>', 'git ref/date to start from, e.g. HEAD~50 or 2026-09-01')
  .option('--repo <dir>', 'corpus/repo directory')
  .action(async (opts) => {
    const cfg = loadConfig(process.env, opts.repo);
    const llm = resolveLLM(cfg);
    if (!llm) {
      process.stderr.write('extract needs MNEMOSYNE_LLM_BASE_URL set\n');
      process.exit(1);
    }
    const { written } = await extractFromHistory(cfg, llm, opts.since);
    process.stdout.write(
      written.length
        ? `wrote ${written.length} candidates under nodes/_candidates/ — review before committing\n`
        : 'no candidates extracted\n',
    );
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
