import * as vscode from 'vscode';
import { MnemosyneClient } from './client.js';
import { MemoryTreeProvider } from './tree.js';
import { MemoryCodeLensProvider } from './codelens.js';
import { captureCommand } from './capture.js';

function makeClient(): MnemosyneClient {
  const cfg = vscode.workspace.getConfiguration('mnemosyne');
  return new MnemosyneClient(
    cfg.get<string>('serverUrl', 'http://127.0.0.1:7077'),
    cfg.get<string>('bearerToken', ''),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  let client = makeClient();

  const tree = new MemoryTreeProvider(client);
  const lens = new MemoryCodeLensProvider(client);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mnemosyne.nodes', tree),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens),
    vscode.commands.registerCommand('mnemosyne.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('mnemosyne.capture', () => captureCommand(client)),
    vscode.commands.registerCommand('mnemosyne.openNode', async (id: string) => {
      try {
        const node = await client.getNode(id);
        const doc = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: `# ${node.title}\n\n_${node.type} · ${node.status} · ${node.project}_\n\n${node.body}\n`,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        void vscode.window.showErrorMessage(`mnemosyne: ${(err as Error).message}`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mnemosyne')) {
        client = makeClient();
        tree.setClient(client);
        lens.setClient(client);
        void tree.refresh();
      }
    }),
  );

  void tree.refresh();
}

export function deactivate(): void {}
