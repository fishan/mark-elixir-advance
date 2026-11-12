import * as vscode from 'vscode';
import { getFileContentAsString, saveFile } from './utils';
import type { MindElixirData } from 'mind-elixir';

export class MindElixirPanel {
  panel: vscode.WebviewPanel;
  html?: string;
  constructor(
    private readonly _extensionUri: vscode.Uri,
    name: string,
    private readonly locale: string = 'en',
  ) {
    const panel = vscode.window.createWebviewPanel(
      'mindElixir',
      name,
      vscode.ViewColumn.One,
      {
        // Enable scripts in the webview
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    this.panel = panel;
  }
  async init(data: MindElixirData) {
    this.html = await this.getWebviewContent(data);
    this.panel.webview.html = this.html;

    this.panel.webview.onDidReceiveMessage((message: any) => {
      switch (message.command) {
        case 'download':
          this.download();
          return;
      }
    });
  }
  async download() {
    saveFile(this.html!);
  }
  getWebviewContent = async (data: MindElixirData) => {
    const js = await getFileContentAsString(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
    );
    const webviewCss = await getFileContentAsString(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.css')
    );
    const index = await getFileContentAsString(
      vscode.Uri.joinPath(this._extensionUri, 'public', 'index.css')
    );
    const hljs = await getFileContentAsString(
      vscode.Uri.joinPath(this._extensionUri, 'public', 'hljs.css')
    );
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Mark Elixir</title>
            <style>${webviewCss}</style>
            <style>${hljs}</style>
            <style>${index}</style>
        </head>
        <body>
            <div id="map"></div>
            <script>
              window.injectedData = ${JSON.stringify({
                data,
                locale: this.locale,
              }).replace(/</g, '\\u003c')};
              ${js}
            </script>
        </body>
        </html>`;
  };
}
