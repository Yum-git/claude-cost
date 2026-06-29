// 公式 CLI `claude -p "/usage"` を実行し、サブスク使用率（5時間/週次）とリセット時刻を取得する。
// OAuth トークンには一切触れない（公式クライアントが自身の認証で取得し、その標準出力を読むだけ）。
// このモジュールは vscode に依存しない（Node 標準モジュールのみ）。
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** `/usage` から取得した使用率（取得できない項目は null）。 */
export interface CliUsage {
  /** 5時間ウィンドウ（Current session）の使用率%。 */
  fiveHourPercent: number | null;
  /** 週次（Current week, all models）の使用率%。 */
  weeklyPercent: number | null;
  /** 週次（Sonnet only）の使用率%。 */
  sonnetWeeklyPercent: number | null;
  /** 5時間ウィンドウのリセット時刻（人間可読テキスト）。 */
  fiveHourResetText: string | null;
  /** 週次のリセット時刻（人間可読テキスト）。 */
  weeklyResetText: string | null;
}

/**
 * `claude` 実行ファイルの絶対パスを解決する。
 * 優先: 設定の上書き → PATH 上 → macOS 等の代表的な設置場所。
 * GUI 起動の VSCode は PATH を継承しないことがあるため代表パスもフォールバックする。
 * 見つからなければ null。
 */
export function resolveClaudePath(override?: string): string | null {
  const isExecutable = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  const trimmed = (override ?? "").trim();
  if (trimmed) {
    return isExecutable(trimmed) ? trimmed : null;
  }

  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, exe);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const fallbacks = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".claude", "local", "claude"),
    path.join(os.homedir(), ".npm-global", "bin", "claude"),
    path.join(os.homedir(), ".local", "bin", "claude"),
  ];
  for (const candidate of fallbacks) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** ANSI エスケープを除去する。 */
function stripAnsi(text: string): string {
  // CSI シーケンス全般を除去する（カラー(SGR, m終端)に限らず、カーソル移動・画面消去・
  // カーソル表示切替など）。ラベルと数値の間に制御文字が残ると使用率のパースが
  // 壊れるため、終端バイト（@-~）まで含めて広く除去する。
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function matchPercent(text: string, label: string): number | null {
  const re = new RegExp(
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "\\s*(\\d+(?:\\.\\d+)?)%\\s*used",
    "i"
  );
  const m = re.exec(text);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function matchReset(text: string, label: string): string | null {
  const re = new RegExp(
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "\\s*\\d+(?:\\.\\d+)?%\\s*used\\s*·\\s*resets\\s+(.+)",
    "i"
  );
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

/** `/usage` の標準出力テキストを CliUsage にパースする。 */
export function parseUsageOutput(text: string): CliUsage {
  const clean = stripAnsi(text);
  return {
    fiveHourPercent: matchPercent(clean, "Current session:"),
    weeklyPercent: matchPercent(clean, "Current week (all models):"),
    sonnetWeeklyPercent: matchPercent(clean, "Current week (Sonnet only):"),
    fiveHourResetText: matchReset(clean, "Current session:"),
    weeklyResetText: matchReset(clean, "Current week (all models):"),
  };
}

export interface ProbeOptions {
  claudePath: string;
  /** タイムアウト（ミリ秒, 既定 12000）。 */
  timeoutMs?: number;
  /** 失敗・タイムアウト時に渡される診断ログ関数（任意）。 */
  log?: (message: string) => void;
}

/**
 * `claude -p "/usage"` を実行して使用率をパースする。
 * stdin を閉じることで CLI の「stdin 待ち」（約3秒）を回避する。
 * 失敗・タイムアウト・5時間%が読めない場合は null を返す（例外は投げない）。
 */
export function probeClaudeUsage(options: ProbeOptions): Promise<CliUsage | null> {
  const timeoutMs = options.timeoutMs ?? 12000;
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value: CliUsage | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    // 認証・課金のルーティングを変える環境変数は子プロセスに渡さない。これらが
    // 設定されていると claude が API キー認証や別プロバイダ（Bedrock/Vertex/Foundry）、
    // 別エンドポイント/別アカウントで動作し、/usage の意味が変わる・予期せぬ課金が
    // 起き得るため。`ANTHROPIC_*` は全て除去（API_KEY/AUTH_TOKEN/BASE_URL/
    // CUSTOM_HEADERS/MODEL 等を網羅）し、OAuth トークンと別プロバイダ切替も除去する。
    // これらが無くても claude は保存済みのサブスク認証で動く。HOME/PATH 等は残す
    // （claude が自身の認証情報を見つけるために必要）。
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (
        key.startsWith("ANTHROPIC_") ||
        key === "CLAUDE_CODE_OAUTH_TOKEN" ||
        key === "CLAUDE_CODE_USE_BEDROCK" ||
        key === "CLAUDE_CODE_USE_VERTEX" ||
        key === "CLAUDE_CODE_USE_FOUNDRY"
      ) {
        delete childEnv[key];
      }
    }

    let child;
    try {
      child = spawn(options.claudePath, ["-p", "/usage"], {
        // stderr は読まないので破棄する。pipe のまま放置するとバッファが埋まった際に
        // 子プロセスがブロックし得るため "ignore" にする。
        stdio: ["ignore", "pipe", "ignore"],
        env: childEnv,
      });

    } catch (e) {
      options.log?.(`claude 実行に失敗しました（spawn）。`);
      return finish(null);
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      options.log?.("claude -p /usage がタイムアウトしました。");
      finish(null);
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      options.log?.("claude の実行中にエラーが発生しました。");
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        options.log?.(`claude -p /usage が異常終了しました（code=${code}）。`);
        return finish(null);
      }
      const usage = parseUsageOutput(stdout);
      // 5時間%が取れなければパース失敗扱い（出力フォーマット変更等）。
      if (usage.fiveHourPercent === null) {
        options.log?.("/usage の出力を解釈できませんでした。");
        return finish(null);
      }
      finish(usage);
    });
  });
}
