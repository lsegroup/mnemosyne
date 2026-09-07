import * as vscode from 'vscode';
import type { MnemosyneClient, SearchResultRow } from './client.js';

/**
 * Shows a CodeLens at the top of a file when memory nodes reference it. Match is
 * best-effort by file basename against node excerpts / code_refs surfaced in search.
 */
export class MemoryCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private client: MnemosyneClient) {}

  setClient(client: MnemosyneClient): void {
    this.client = client;
    this.changed.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const rel = vscode.workspace.asRelativePath(document.uri);
    const base = rel.split('/').pop() ?? rel;
    let rows: SearchResultRow[] = [];
    try {
      rows = await this.client.search(base);
    } catch {
      return [];
    }
    const relevant = rows.filter(
      (r) => r.excerpt.includes(base) || r.title.includes(base) || r.excerpt.includes(rel),
    );
    if (relevant.length === 0) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    return relevant.slice(0, 3).map(
      (r) =>
        new vscode.CodeLens(top, {
          title: `$(book) ${r.title}`,
          command: 'mnemosyne.openNode',
          arguments: [r.id],
        }),
    );
  }
}
