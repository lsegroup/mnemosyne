import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { NODE_TYPES } from '@mnemosyne/core';
import type { MnemosyneClient } from './client.js';

const exec = promisify(execFile);

async function gitInfo(cwd: string): Promise<{ repo?: string; branch?: string }> {
  try {
    const [{ stdout: top }, { stdout: branch }] = await Promise.all([
      exec('git', ['rev-parse', '--show-toplevel'], { cwd }),
      exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    ]);
    return { repo: path.basename(top.trim()), branch: branch.trim() };
  } catch {
    return {};
  }
}

/**
 * Grab the active editor's file, selection and git context, prompt for the
 * essentials, and create a node via the server.
 */
export async function captureCommand(client: MnemosyneClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
  const file = editor?.document.uri.fsPath;
  const cwd = file ? path.dirname(file) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const { repo, branch } = await gitInfo(cwd);

  const title = await vscode.window.showInputBox({ prompt: 'Memory title', ignoreFocusOut: true });
  if (!title) return;

  const type = await vscode.window.showQuickPick([...NODE_TYPES], {
    placeHolder: 'Type',
    ignoreFocusOut: true,
  });
  if (!type) return;

  const project =
    (await vscode.window.showInputBox({
      prompt: 'Project',
      value: repo ?? '',
      ignoreFocusOut: true,
    })) ?? repo ?? 'unknown';

  const bodyParts = [
    await vscode.window.showInputBox({ prompt: 'Observation / detail', ignoreFocusOut: true }),
  ].filter(Boolean);
  if (selection) {
    const rel = file ? path.relative(cwd, file) : 'selection';
    bodyParts.push('', '```', `// ${rel}${branch ? ` @ ${branch}` : ''}`, selection, '```');
  }

  const code_refs =
    file && repo
      ? [
          {
            repo,
            path: vscode.workspace.asRelativePath(file),
            line: editor ? editor.selection.start.line + 1 : undefined,
          },
        ]
      : [];

  try {
    const res = await client.createNode({
      title,
      type,
      project,
      body: bodyParts.join('\n') || title,
      code_refs,
    });
    void vscode.window.showInformationMessage(`mnemosyne: created ${res.id}`);
    void vscode.commands.executeCommand('mnemosyne.refresh');
  } catch (err) {
    void vscode.window.showErrorMessage(`mnemosyne: ${(err as Error).message}`);
  }
}
