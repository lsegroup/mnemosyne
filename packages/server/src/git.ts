import { simpleGit, type SimpleGit } from 'simple-git';
import type { MnemosyneConfig } from './config.js';

export interface HistoryEntry {
  commit: string;
  date: string;
  author: string;
  message: string;
}

/**
 * Thin git wrapper for the corpus repo. Commits are how mnemosyne records "who
 * changed what, when" — the audit trail is `git log`, not a database table.
 */
export class GitOps {
  private readonly git: SimpleGit;
  constructor(private readonly cfg: MnemosyneConfig) {
    this.git = simpleGit(cfg.repoDir);
  }

  async isRepo(): Promise<boolean> {
    try {
      return await this.git.checkIsRepo();
    } catch {
      return false;
    }
  }

  /** Stage the given absolute paths and commit. No-op when git is disabled. */
  async commitPaths(paths: string[], message: string): Promise<string | null> {
    if (!this.cfg.git.enabled || !this.cfg.git.autoCommit) return null;
    if (paths.length === 0) return null;
    await this.git.add(paths);
    const status = await this.git.status();
    if (status.staged.length === 0) return null;
    const res = await this.git.commit(message, undefined, {
      '--author': `${this.cfg.git.authorName} <${this.cfg.git.authorEmail}>`,
    });
    if (this.cfg.git.push) {
      await this.git.push(this.cfg.git.remote, this.cfg.git.branch);
    }
    return res.commit || null;
  }

  /** `git log --follow` for one file, newest first. */
  async history(relPath: string, limit = 50): Promise<HistoryEntry[]> {
    if (!(await this.isRepo())) return [];
    const log = await this.git.log({
      file: relPath,
      '--follow': null,
      '--max-count': limit,
    });
    return log.all.map((c) => ({
      commit: c.hash,
      date: c.date,
      author: `${c.author_name} <${c.author_email}>`,
      message: c.message,
    }));
  }

  /** Short sha of HEAD, or undefined outside a repo. */
  async headSha(): Promise<string | undefined> {
    if (!(await this.isRepo())) return undefined;
    try {
      return (await this.git.revparse(['--short', 'HEAD'])).trim();
    } catch {
      return undefined;
    }
  }
}
