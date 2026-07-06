import * as vscode from "vscode";
import { readConfig } from "./config";
import {
  probeClaudeUsage,
  resolveClaudePath,
  type CliUsage,
} from "./data/claudeUsageProbe";
import { UsageCache } from "./data/incrementalCache";
import { FileWatchCoordinator } from "./fileWatcher";
import { PollingScheduler } from "./pollingScheduler";
import { Notifier } from "./ui/notifier";
import { StatusBar } from "./ui/statusBar";
import { UsagePanel } from "./ui/webviewPanel";
import { computeUsageView, type UsageView } from "./usageService";

const OVERAGE_START_KEY = "claudeCost.overageStartTs";
// 使用率(CLI実測)を全 VSCode ウィンドウで共有するための globalState キー。
// ウィンドウごとにメモリキャッシュすると、開いているウィンドウ数ぶん /usage を
// 叩いて claude 側のスロットルを誘発するため、取得結果をここに集約して共有する。
const CLI_USAGE_CACHE_KEY = "claudeCost.cliUsageShared";
// 取得失敗時に直近の成功値を再利用してよい最大経過時間（stale 表示の上限）。
const CLI_USAGE_STALE_MAX_MS = 30 * 60 * 1000;
// 取得失敗が続くときの指数バックオフ状態を全ウィンドウで共有する globalState キー。
const CLI_USAGE_BACKOFF_KEY = "claudeCost.cliUsageBackoff";
// 指数バックオフの初期遅延（ミリ秒）。以降 2 倍ずつ増やし、上限は取得間隔(ttl)に連動。
const BACKOFF_INITIAL_MS = 30 * 1000;

interface SharedCliUsage {
  result: CliUsage;
  at: number;
}

/** 取得失敗時の指数バックオフ状態（全ウィンドウ共有）。 */
interface BackoffState {
  /** 連続失敗回数（1始まり。上限遅延に達したら据え置く）。 */
  failCount: number;
  /** 次に取得を試みてよい最早時刻（epoch ミリ秒）。 */
  nextEarliestAt: number;
}

let output: vscode.OutputChannel;
let statusBar: StatusBar;
let notifier: Notifier;
let extensionUri: vscode.Uri;
let globalState: vscode.Memento;
let usageCache: UsageCache;
let watcher: FileWatchCoordinator;
let poller: PollingScheduler;

let latestView: UsageView | undefined;
let scanning = false;
let pendingRefresh = false;

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  globalState = context.globalState;
  output = vscode.window.createOutputChannel("Claude Cost");
  context.subscriptions.push(output);

  statusBar = new StatusBar();
  statusBar.show();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  notifier = new Notifier();
  usageCache = new UsageCache();
  // 条件付き定期ポーリング（フォーカス中/直近活動時のみ）。活動駆動と独立に併用する。
  poller = new PollingScheduler(
    () => void refresh(),
    (m) => output.appendLine(m)
  );
  context.subscriptions.push({ dispose: () => poller.dispose() });
  watcher = new FileWatchCoordinator(
    // 活動駆動: 追記検知（デバウンス後）に再更新。forceProbe なし＝/usage は 5分TTL を尊重。
    () => void refresh(),
    (m) => output.appendLine(m),
    // 生イベント（デバウンス前）: ポーリングの有効化判定用に活動時刻を記録。
    () => poller.markActivity()
  );
  context.subscriptions.push({ dispose: () => watcher.dispose() });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "claudeCost.view",
      new EntryTreeProvider()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCost.openPanel", openPanel),
    // ステータスバークリックで開く内部メニュー。コマンドパレットに出す必要が
    // ないため package.json の contributes.commands には意図的に宣言しない。
    vscode.commands.registerCommand("claudeCost.menu", showMenu),
    // 手動の再スキャンは使用率も強制取得（TTLを無視）。
    vscode.commands.registerCommand("claudeCost.refresh", () =>
      refresh({ showProgress: true, forceProbe: true })
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("claudeCost")) {
        return;
      }
      // データディレクトリが変わったらキャッシュは無効（別データ範囲のため）。
      if (e.affectsConfiguration("claudeCost.claudeHome")) {
        usageCache.clear();
      }
      const config = readConfig();
      watcher.start(config.claudeHome, config.refreshDebounceMs);
      poller.start(config.usageRefreshIntervalSeconds * 1000);
      void refresh();
    })
  );

  // 起動時に監視・ポーリングを開始し、初回更新を行う（いずれもブロックしない）。
  const initialConfig = readConfig();
  watcher.start(initialConfig.claudeHome, initialConfig.refreshDebounceMs);
  poller.start(initialConfig.usageRefreshIntervalSeconds * 1000);
  void refresh();
}

export function deactivate(): void {
  // 登録した破棄可能リソースは context.subscriptions により自動的に破棄される。
}

function openPanel(): void {
  const config = readConfig();
  UsagePanel.show(
    extensionUri,
    {
      onRefresh: () => void refresh({ showProgress: true, forceProbe: true }),
      onOpenSettings: openSettings,
    },
    latestView
      ? {
          view: latestView,
          options: { showRawModelNames: config.showRawModelNames },
        }
      : undefined
  );
  if (!latestView && !scanning) {
    void refresh();
  }
}

function openSettings(): void {
  void vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "claudeCost"
  );
}

/** ステータスバークリックで開くメニュー（QuickPick）。 */
async function showMenu(): Promise<void> {
  type MenuItem = vscode.QuickPickItem & { action: "panel" | "refresh" | "settings" };
  const items: MenuItem[] = [
    { label: "$(graph) 使用状況を表示（パネル）", action: "panel" },
    { label: "$(sync) 強制更新（使用率を即時取得）", action: "refresh" },
    { label: "$(gear) 設定を開く", action: "settings" },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Claude Cost",
  });
  if (!picked) {
    return;
  }
  if (picked.action === "panel") {
    openPanel();
  } else if (picked.action === "refresh") {
    void refresh({ showProgress: true, forceProbe: true });
  } else {
    openSettings();
  }
}

/**
 * 連続失敗回数から次回の指数バックオフ遅延（ミリ秒）を返す。
 * failCount は今回の失敗を含む連続失敗回数（1始まり）。initialMs から 2 倍ずつ増やし maxMs で頭打ち。
 */
function nextBackoffDelayMs(
  failCount: number,
  initialMs: number,
  maxMs: number
): number {
  return Math.min(initialMs * 2 ** (failCount - 1), maxMs);
}

/**
 * CLI 使用率を取得する。useCliUsage が false なら null。
 * 取得結果は globalState で全ウィンドウ共有し、設定TTL（既定5分）内は再取得しない
 * （複数ウィンドウを開いても /usage 実行を全体で集約し、claude 側スロットルを回避）。
 * forceProbe 時は TTL を無視する。取得に失敗した場合は、直近の成功値を一定時間
 * （CLI_USAGE_STALE_MAX_MS）だけ再利用し、表示の安定を図る。さらに失敗が続く間は
 * 指数バックオフ（BACKOFF_INITIAL_MS 〜 ttl）で再取得を控え、claude への過剰アクセスを防ぐ。
 * forceProbe 時はバックオフも無視して即取得し、成功でバックオフをリセットする。
 */
async function getCliUsage(
  config: ReturnType<typeof readConfig>,
  forceProbe: boolean
): Promise<CliUsage | null> {
  if (!config.useCliUsage) {
    return null;
  }
  // settings.json 直接編集での過小値を防ぐため下限30秒にクランプ。
  const ttlMs = Math.max(30, config.usageRefreshIntervalSeconds) * 1000;
  const now = Date.now();
  const shared = globalState.get<SharedCliUsage>(CLI_USAGE_CACHE_KEY);
  const backoff = globalState.get<BackoffState>(CLI_USAGE_BACKOFF_KEY);

  // 直近の成功値が stale 上限内なら返す。無ければ null（表示は既存踏襲）。
  const staleOrNull = (): CliUsage | null =>
    shared && now - shared.at < CLI_USAGE_STALE_MAX_MS ? shared.result : null;

  // 全ウィンドウ共有の TTL キャッシュ。TTL 内なら叩かない（コール頻度を集約）。
  if (!forceProbe && shared && now - shared.at < ttlMs) {
    return shared.result;
  }

  // 取得失敗が続く間は指数バックオフで再取得を控える（claude への過剰アクセス防止）。
  // 手動更新（forceProbe）はユーザー明示操作なのでバックオフを無視して即取得する。
  if (!forceProbe && backoff && now < backoff.nextEarliestAt) {
    return staleOrNull();
  }

  // 取得失敗を記録し、次回の再取得可能時刻（指数バックオフ）を更新する。
  // 戻り値は次回まで控える秒数（ログ表示用）。
  const recordFailure = async (): Promise<number> => {
    const prevFailCount = backoff?.failCount ?? 0;
    // 既に上限遅延に達していたら failCount を据え置く（値の際限ない増大を防ぐ）。
    const atMax =
      prevFailCount > 0 &&
      nextBackoffDelayMs(prevFailCount, BACKOFF_INITIAL_MS, ttlMs) >= ttlMs;
    const failCount = atMax ? prevFailCount : prevFailCount + 1;
    const delayMs = nextBackoffDelayMs(failCount, BACKOFF_INITIAL_MS, ttlMs);
    // 起点は失敗確定時刻（probe 所要ぶんのズレを避けるため取り直す）。
    await globalState.update(CLI_USAGE_BACKOFF_KEY, {
      failCount,
      nextEarliestAt: Date.now() + delayMs,
    });
    return Math.round(delayMs / 1000);
  };

  const claudePath = resolveClaudePath(config.claudeCliPath);
  if (!claudePath) {
    const sec = await recordFailure();
    output.appendLine(
      `claude 実行ファイルが見つかりません。約 ${sec} 秒後に再確認します（claudeCost.claudeCliPath で指定可）。`
    );
    return staleOrNull();
  }

  const result = await probeClaudeUsage({
    claudePath,
    timeoutMs: 12000,
    log: (m) => output.appendLine(m),
  });

  if (result) {
    // 取得成功 → 共有キャッシュを更新（全ウィンドウが参照する）。バックオフはリセット。
    await globalState.update(CLI_USAGE_CACHE_KEY, { result, at: now });
    if (backoff) {
      await globalState.update(CLI_USAGE_BACKOFF_KEY, undefined);
    }
    return result;
  }

  // 取得失敗（claude が使用率を返さない等）。指数バックオフを進め、直近の成功値を一定時間は再利用する。
  const sec = await recordFailure();
  output.appendLine(
    `使用率を取得できませんでした。約 ${sec} 秒後に再試行します（直近値があれば表示を継続）。`
  );
  return staleOrNull();
}

interface RefreshOptions {
  showProgress?: boolean;
  forceProbe?: boolean;
}

async function refresh(options?: RefreshOptions): Promise<void> {
  if (scanning) {
    pendingRefresh = true;
    return;
  }
  scanning = true;
  statusBar.setScanning();

  const run = async (): Promise<void> => {
    const config = readConfig();
    const now = Date.now();
    const cliUsage = await getCliUsage(config, options?.forceProbe ?? false);
    const priorRaw = globalState.get<number>(OVERAGE_START_KEY);
    const priorOverageStartTs = typeof priorRaw === "number" ? priorRaw : null;

    // 差分キャッシュで走査（変化のないファイルは読み直さない）。
    const scan = await usageCache.refresh(config.claudeHome, (m) =>
      output.appendLine(m)
    );

    const view = computeUsageView({
      scan,
      claudeHome: config.claudeHome,
      warnThresholdPercent: config.warnThresholdPercent,
      priceOverrides: config.priceOverrides,
      unknownModelHandling: config.unknownModelHandling,
      now,
      cliUsage,
      priorOverageStartTs,
    });

    latestView = view;
    await globalState.update(
      OVERAGE_START_KEY,
      view.overage.overageStartTs ?? undefined
    );

    statusBar.update(view);
    notifier.maybeNotify(view, config.notifyOnOverage);
    UsagePanel.postToCurrent(view, {
      showRawModelNames: config.showRawModelNames,
    });
  };

  try {
    if (options?.showProgress) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Claude Cost: 使用状況を更新中...",
        },
        run
      );
    } else {
      await run();
    }
  } catch {
    output.appendLine("更新中に予期しないエラーが発生しました。");
    if (latestView) {
      statusBar.update(latestView);
    } else {
      statusBar.setIdle();
    }
    if (options?.showProgress) {
      vscode.window.showErrorMessage(
        "Claude Cost: 更新中にエラーが発生しました。詳細は出力パネル（Claude Cost）を確認してください。"
      );
    }
  } finally {
    scanning = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      void refresh();
    }
  }
}

/** アクティビティバーのエントリ。パネルへの導線となる単一ノードを返す。 */
class EntryTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const item = new vscode.TreeItem(
      "使用状況を表示",
      vscode.TreeItemCollapsibleState.None
    );
    item.command = {
      command: "claudeCost.openPanel",
      title: "使用状況を表示",
    };
    item.iconPath = new vscode.ThemeIcon("graph");
    return [item];
  }
}
