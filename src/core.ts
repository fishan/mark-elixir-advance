import * as vscode from 'vscode';
import * as path from 'path';
import { MindElixirPanel } from './panel';
import { markdownToMindElixirData, type ConvertIssue, type ConvertResult } from './markdownConverter';
import { applyMapOp, type MapOp } from './sourceEdits';

/**
 * Get mind-elixir locale from VS Code language setting.
 * Maps VS Code language IDs to mind-elixir locale strings.
 */
function getMindElixirLocale(): string {
  const lang = vscode.env.language; // e.g. 'zh-cn', 'en', 'ja'
  if (lang.startsWith('zh-tw') || lang.startsWith('zh-hant')) return 'zh_TW';
  if (lang.startsWith('zh')) return 'zh_CN';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('pt')) return 'pt';
  if (lang.startsWith('ru')) return 'ru';
  if (lang.startsWith('de')) return 'de';
  if (lang.startsWith('fr')) return 'fr';
  if (lang.startsWith('es')) return 'es';
  if (lang.startsWith('it')) return 'it';
  if (lang.startsWith('ko')) return 'ko';
  return 'en';
}

/**
 * Opens a Markdown file as an editable mind map.
 *
 * The file is the single source of truth: every map operation is translated
 * into a minimal text edit of the affected lines only (`sourceEdits.ts`), and
 * the map is then re-rendered from the file. Nothing else in the file is
 * rewritten.
 */
export const markdownToMindElixir = (context: vscode.ExtensionContext) => {
  return async () => {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      vscode.window.showInformationMessage('No active editor');
      return;
    }
    const document = editor.document;
    const editorColumn = editor.viewColumn;
    const locale = getMindElixirLocale();
    const fileTitle = path.basename(document.fileName, path.extname(document.fileName));

    const diagnostics = vscode.languages.createDiagnosticCollection('mark-elixir');

    const reportIssues = (issues: ConvertIssue[]) => {
      diagnostics.set(
        document.uri,
        issues.map((issue) => {
          const r = issue.range;
          const range = r
            ? new vscode.Range(r.startLine - 1, r.startColumn - 1, r.endLine - 1, r.endColumn - 1)
            : new vscode.Range(0, 0, 0, 0);
          const d = new vscode.Diagnostic(range, issue.message, vscode.DiagnosticSeverity.Warning);
          d.source = 'Mark Elixir';
          return d;
        })
      );
    };

    // Latest parse of the document (+ the version it belongs to)
    let parsed: ConvertResult;
    let parsedVersion = -1;
    const parse = (): ConvertResult => {
      if (parsedVersion !== document.version) {
        const config = vscode.workspace.getConfiguration('mindElixirMarkdown');
        parsed = markdownToMindElixirData(document.getText(), {
          title: fileTitle,
          h1AsRoot: config.get<boolean>('h1AsRoot', true),
        });
        parsedVersion = document.version;
        reportIssues(parsed.issues);
      }
      return parsed;
    };

    const first = parse();
    const mindElixirPanel = new MindElixirPanel(
      context.extensionUri,
      first.title + ' - Mark Elixir',
      locale
    );
    await mindElixirPanel.init(first.data);

    const postData = () => {
      try {
        void mindElixirPanel.panel.webview.postMessage({ command: 'updateData', data: parse().data });
      } catch (err) {
        console.error('Error updating mind map data:', err);
      }
    };

    /** Apply one map operation to the document. On failure re-sync the map from the file. */
    const handleOp = async (op: MapOp) => {
      const result = applyMapOp(parse().source, op);
      if ('error' in result) {
        vscode.window.showWarningMessage(`Mark Elixir: ${result.error} The map was reloaded from the file.`);
        postData();
        return;
      }
      if (result.edits.length === 0) return;
      const wasDirty = document.isDirty;
      const edit = new vscode.WorkspaceEdit();
      for (const e of result.edits) {
        edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
          e.text
        );
      }
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        vscode.window.showErrorMessage('Mark Elixir: could not apply the change to the file.');
        postData();
        return;
      }
      if (!wasDirty) await document.save();
    };

    /** Run undo / redo in the source editor, then return focus to the map. */
    const runInEditor = async (command: 'undo' | 'redo') => {
      await vscode.window.showTextDocument(document, { viewColumn: editorColumn, preserveFocus: false });
      await vscode.commands.executeCommand(command);
      mindElixirPanel.panel.reveal(undefined, false);
    };

    // Operations are applied strictly one after another
    let queue: Promise<void> = Promise.resolve();
    mindElixirPanel.panel.webview.onDidReceiveMessage((message: any) => {
      switch (message.command) {
        case 'op':
          queue = queue.then(() => handleOp(message.op as MapOp)).catch((e) => {
            vscode.window.showErrorMessage(`Mark Elixir: failed to update file: ${e}`);
            postData();
          });
          return;
        case 'undo':
        case 'redo':
          queue = queue.then(() => runInEditor(message.command)).catch(() => undefined);
          return;
        default:
          break;
      }
    });

    let updateTimer: NodeJS.Timeout | null = null;

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = setTimeout(postData, 300); // debounce 300ms
    });

    mindElixirPanel.panel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      diagnostics.dispose();
      if (updateTimer) clearTimeout(updateTimer);
    });

    context.subscriptions.push(mindElixirPanel.panel, changeDocumentSubscription);
  };
};
