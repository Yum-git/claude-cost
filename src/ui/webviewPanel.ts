// 詳細可視化パネル（Webview）。要件①②③を視覚化する。
// CSP 厳守: 外部 CDN/フォント/スクリプト禁止。CSS/JS は media/ から nonce 付きで読み込む。
import * as crypto from "crypto";
import * as vscode from "vscode";
import type { UsageView } from "../usageService";

/** Webview に送るオプション（表示制御）。 */
export interface PanelOptions {
  showRawModelNames: boolean;
}

/** Webview ↔ 拡張のメッセージで使うペイロード。 */
interface PanelPayload {
  view: UsageView;
  options: PanelOptions;
}

export interface PanelHandlers {
  /** 再スキャン要求。 */
  onRefresh: () => void;
  /** 設定を開く要求。 */
  onOpenSettings: () => void;
}

function nonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

/** 単一の使用状況パネルを管理する。 */
export class UsagePanel {
  private static current: UsagePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private latest: PanelPayload | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers
  ) {
    this.panel = panel;
    this.panel.webview.html = this.buildHtml(extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );
  }

  /** パネルを開く（既存があれば前面に出す）。 */
  static show(
    extensionUri: vscode.Uri,
    handlers: PanelHandlers,
    initial?: PanelPayload
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (UsagePanel.current) {
      UsagePanel.current.panel.reveal(column);
      if (initial) {
        UsagePanel.current.post(initial);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claudeCostPanel",
      "Claude コスト可視化",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    UsagePanel.current = new UsagePanel(panel, extensionUri, handlers);
    if (initial) {
      UsagePanel.current.latest = initial;
    }
  }

  /** 現在開いているパネルにビューを送る（無ければ何もしない）。 */
  static postToCurrent(view: UsageView, options: PanelOptions): void {
    UsagePanel.current?.post({ view, options });
  }

  static get isOpen(): boolean {
    return UsagePanel.current !== undefined;
  }

  private post(payload: PanelPayload): void {
    this.latest = payload;
    void this.panel.webview.postMessage({ type: "update", ...payload });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }
    const type = (message as { type?: string }).type;
    if (type === "ready") {
      // Webview 側の準備完了。最新ペイロードがあれば送る。
      if (this.latest) {
        void this.panel.webview.postMessage({ type: "update", ...this.latest });
      }
    } else if (type === "refresh") {
      this.handlers.onRefresh();
    } else if (type === "openSettings") {
      this.handlers.onOpenSettings();
    }
  }

  private buildHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "panel.css")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "panel.js")
    );
    const n = nonce();
    // CSP 厳守: 外部は一切許可しない。スタイルは media/panel.css（cspSource）のみ、
    // スクリプトは nonce 付きのみ。動的な幅指定はインライン style を使わず SVG で描く
    // ため、style-src に 'unsafe-inline' は不要。
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${n}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${cssUri}" rel="stylesheet" />
<title>Claude コスト可視化</title>
</head>
<body>
<div id="app">
  <p class="loading">使用状況を読み込み中...</p>
</div>
<script nonce="${n}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    UsagePanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
