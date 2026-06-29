// 活動駆動のファイル監視。Claude Code がトランスクリプト(*.jsonl)へ追記した
// （= 実際に使われた）ことを検知し、デバウンス後にコールバックを呼ぶ。
// 定期タイマーは持たない（使われていない間は一切発火しない＝活動駆動のみ）。
//
// 監視は 2 系統を併用して取りこぼしを防ぐ:
//   1) vscode.FileSystemWatcher … ワークスペース外の絶対パスでも RelativePattern で試行
//   2) fs.watch(recursive) ……… recursive は macOS/Windows のみ対応（Linux では例外を無視）
// どちらが拾っても同じデバウンスに集約されるため、重複発火は問題にならない。
import * as fs from "fs";
import * as vscode from "vscode";
import { getProjectsDir, resolveClaudeHome } from "./data/transcriptScanner";

/** 指定パスが存在するディレクトリなら true。 */
function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class FileWatchCoordinator {
  private fsWatcher: vscode.FileSystemWatcher | undefined;
  private nodeWatcher: fs.FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private currentDir: string | undefined;
  private debounceMs = 2000;

  /**
   * @param onActivity 追記検知（デバウンス後）に呼ぶコールバック。
   * @param log 診断ログ出力（内部詳細は UI に出さず Output チャネルへ）。
   * @param onRawEvent 追記検知（デバウンス前・生イベント）ごとに呼ぶ任意コールバック。
   *   活動時刻の記録など、間引きたくない軽量処理に使う。
   */
  constructor(
    private readonly onActivity: () => void,
    private readonly log: (message: string) => void,
    private readonly onRawEvent?: () => void
  ) {}

  /**
   * claudeHome に対応する projects ディレクトリの監視を開始する。
   * 既に同じディレクトリを監視中なら張り直さず、デバウンス値のみ更新する。
   */
  start(claudeHome: string, debounceMs: number): void {
    // 過小値や負値での暴走を防ぐため下限 200ms にクランプ（package.json の minimum と一致）。
    this.debounceMs = Math.max(200, debounceMs);

    const dir = getProjectsDir(claudeHome);
    if (this.currentDir === dir && (this.fsWatcher || this.nodeWatcher)) {
      return; // 監視先が同じなら張り直さない
    }
    this.stop();
    this.currentDir = dir;

    // projects ディレクトリがまだ無い場合（Claude Code 導入直後など）は、存在する
    // 直近の親（通常 ~/.claude）を recursive 監視して projects 作成後の *.jsonl も
    // 取りこぼさないようにする。それも無ければ監視は張らない（起動時・手動更新で対応）。
    let watchDir = dir;
    if (!isExistingDir(dir)) {
      const home = resolveClaudeHome(claudeHome);
      if (isExistingDir(home)) {
        watchDir = home;
        this.log(
          "projects ディレクトリが未作成のため上位ディレクトリを監視します（作成後に自動検知）。"
        );
      } else {
        this.log(
          "Claude データディレクトリが見つからないため、ファイル監視は開始しません（起動時・手動更新で動作）。"
        );
        return;
      }
    }

    // 1) VSCode FileSystemWatcher
    try {
      const pattern = new vscode.RelativePattern(watchDir, "**/*.jsonl");
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      w.onDidChange(() => this.trigger());
      w.onDidCreate(() => this.trigger());
      this.fsWatcher = w;
    } catch {
      this.log(
        "ファイル監視(FileSystemWatcher)を初期化できませんでした。fs.watch を使用します。"
      );
    }

    // 2) fs.watch フォールバック（recursive 非対応環境では例外を無視）
    try {
      const nw = fs.watch(watchDir, { recursive: true }, (_event, filename) => {
        if (!filename) {
          this.trigger();
          return;
        }
        if (filename.toString().endsWith(".jsonl")) {
          this.trigger();
        }
      });
      nw.on("error", () => {
        // 監視継続不能になっても握りつぶす（FileSystemWatcher 側が残る）。
      });
      this.nodeWatcher = nw;
    } catch {
      this.log(
        "ファイル監視(fs.watch)を初期化できませんでした。FileSystemWatcher を使用します。"
      );
    }

    if (!this.fsWatcher && !this.nodeWatcher) {
      this.log(
        "ファイル監視を開始できませんでした。手動更新・起動時更新のみで動作します。"
      );
    }
  }

  private trigger(): void {
    // 生イベント（デバウンス前）。連続活動中も取りこぼさず毎回呼ぶ（活動時刻の記録用）。
    this.onRawEvent?.();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.onActivity();
    }, this.debounceMs);
  }

  /** 監視を停止し、保留中のデバウンスも破棄する。 */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.fsWatcher) {
      this.fsWatcher.dispose();
      this.fsWatcher = undefined;
    }
    if (this.nodeWatcher) {
      try {
        this.nodeWatcher.close();
      } catch {
        /* noop */
      }
      this.nodeWatcher = undefined;
    }
    this.currentDir = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
