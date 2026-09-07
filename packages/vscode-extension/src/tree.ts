import * as vscode from 'vscode';
import type { MnemosyneClient, SearchResultRow } from './client.js';

type Item = ProjectItem | NodeItem;

class ProjectItem extends vscode.TreeItem {
  constructor(
    public readonly project: string,
    public readonly rows: SearchResultRow[],
  ) {
    super(project, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${rows.length}`;
    this.contextValue = 'project';
  }
}

class NodeItem extends vscode.TreeItem {
  constructor(public readonly row: SearchResultRow) {
    super(row.title, vscode.TreeItemCollapsibleState.None);
    this.description = `${row.type} · ${row.status}`;
    this.tooltip = row.excerpt;
    this.contextValue = 'node';
    this.command = {
      command: 'mnemosyne.openNode',
      title: 'Open node',
      arguments: [row.id],
    };
  }
}

/** Groups memory nodes by project. Populated from a broad search ('*' style). */
export class MemoryTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private rows: SearchResultRow[] = [];

  constructor(private client: MnemosyneClient) {}

  setClient(client: MnemosyneClient): void {
    this.client = client;
  }

  async refresh(): Promise<void> {
    try {
      this.rows = await this.client.search('the a of to is');
    } catch (err) {
      this.rows = [];
      void vscode.window.showWarningMessage(`mnemosyne: ${(err as Error).message}`);
    }
    this.changed.fire(undefined);
  }

  getTreeItem(item: Item): vscode.TreeItem {
    return item;
  }

  getChildren(item?: Item): Item[] {
    if (!item) {
      const byProject = new Map<string, SearchResultRow[]>();
      for (const r of this.rows) {
        (byProject.get(r.project) ?? byProject.set(r.project, []).get(r.project)!).push(r);
      }
      return [...byProject.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([p, rows]) => new ProjectItem(p, rows));
    }
    if (item instanceof ProjectItem) {
      return item.rows.map((r) => new NodeItem(r));
    }
    return [];
  }
}
