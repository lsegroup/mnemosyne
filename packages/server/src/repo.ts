import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseMarkdown, toMarkdown, type MemoryNode } from '@mnemosyne/core';

/**
 * The markdown corpus on disk under `nodesDir`, laid out as
 * `nodes/<project>/<id>.md`. This is the source of truth; the SQLite index is
 * derived from it.
 */
export class NodeRepo {
  constructor(private readonly nodesDir: string) {}

  private fileFor(node: Pick<MemoryNode, 'id' | 'project'>): string {
    const project = node.project.replace(/[^a-z0-9._-]/gi, '-').toLowerCase() || 'misc';
    return join(this.nodesDir, project, `${node.id}.md`);
  }

  /** Absolute path -> node id, for git history lookups. */
  relPath(node: Pick<MemoryNode, 'id' | 'project'>, fromDir: string): string {
    return relative(fromDir, this.fileFor(node));
  }

  async list(): Promise<MemoryNode[]> {
    const out: MemoryNode[] = [];
    await this.walk(this.nodesDir, out);
    return out;
  }

  private async walk(dir: string, out: MemoryNode[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, out);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const raw = await readFile(full, 'utf8');
        try {
          out.push(parseMarkdown(raw));
        } catch (err) {
          throw new Error(`invalid node file ${full}: ${(err as Error).message}`);
        }
      }
    }
  }

  async get(id: string): Promise<MemoryNode | null> {
    return (await this.list()).find((n) => n.id === id) ?? null;
  }

  /** Write a node, returning the path written (for git staging). */
  async write(node: MemoryNode): Promise<string> {
    const file = this.fileFor(node);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, toMarkdown(node), 'utf8');
    return file;
  }

  async delete(node: Pick<MemoryNode, 'id' | 'project'>): Promise<string> {
    const file = this.fileFor(node);
    await rm(file, { force: true });
    return file;
  }
}
