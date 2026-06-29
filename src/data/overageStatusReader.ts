// ~/.claude.json から「追加使用（超過）課金」に関する状態のみを抽出する。
// このモジュールは vscode に依存しない。
//
// セキュリティ: このファイルは他にも多くの情報を含むが、本リーダーは
// 超過関連の 4 フィールドのみを読み取り、他の内容は一切保持・出力しない。
// 認証情報ファイル(.credentials.json)は読み取らない（別ファイル）。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveClaudeHome } from "./transcriptScanner";

/** ~/.claude.json から抽出した超過課金関連の状態（すべてキャッシュ値=参考）。 */
export interface OverageStatus {
  /** ファイルを読み取り・パースできたか。 */
  available: boolean;
  /** 追加使用課金が無効な理由（例: "group_zero_credit_limit"）。null=理由なし/有効/不明。 */
  extraUsageDisabledReason: string | null;
  /** サブスク枠の有無（参考）。 */
  hasAvailableSubscription: boolean | null;
  /** 残りパス数（参考）。 */
  passesRemaining: number | null;
  /** 超過用クレジットが利用可能/付与済みか（参考）。 */
  overageCreditAvailable: boolean | null;
}

function emptyStatus(): OverageStatus {
  return {
    available: false,
    extraUsageDisabledReason: null,
    hasAvailableSubscription: null,
    passesRemaining: null,
    overageCreditAvailable: null,
  };
}

/**
 * .claude.json の候補パス。`~/.claude.json`（ホーム直下）が基本。
 * claudeHome 設定で .claude ディレクトリを上書きしている場合は、その親の
 * .claude.json も候補に含める。
 */
function claudeJsonCandidates(claudeHome: string): string[] {
  const home = resolveClaudeHome(claudeHome);
  const candidates = [
    path.join(path.dirname(home), ".claude.json"),
    path.join(os.homedir(), ".claude.json"),
  ];
  return [...new Set(candidates)];
}

/** json オブジェクトから超過関連 4 フィールドのみを取り出す。 */
function extract(json: any): OverageStatus {
  const reason =
    typeof json.cachedExtraUsageDisabledReason === "string" &&
    json.cachedExtraUsageDisabledReason.length > 0
      ? json.cachedExtraUsageDisabledReason
      : null;

  const hasSubscription =
    typeof json.hasAvailableSubscription === "boolean"
      ? json.hasAvailableSubscription
      : null;

  const passesRemaining =
    typeof json.passesLastSeenRemaining === "number" &&
    Number.isFinite(json.passesLastSeenRemaining)
      ? json.passesLastSeenRemaining
      : null;

  let overageCreditAvailable: boolean | null = null;
  const grantCache = json.overageCreditGrantCache;
  if (grantCache && typeof grantCache === "object") {
    const entries = Object.values(grantCache);
    if (entries.length > 0) {
      overageCreditAvailable = entries.some((entry: any) => {
        const info = entry && typeof entry === "object" ? entry.info : null;
        return (
          !!info &&
          typeof info === "object" &&
          (info.available === true || info.granted === true)
        );
      });
    }
  }

  return {
    available: true,
    extraUsageDisabledReason: reason,
    hasAvailableSubscription: hasSubscription,
    passesRemaining,
    overageCreditAvailable,
  };
}

/**
 * 超過課金関連の状態を読み取る。ファイル不在・パース失敗時は
 * available=false の空状態を返す（例外は投げない）。
 */
export function readOverageStatus(claudeHome: string): OverageStatus {
  for (const candidate of claudeJsonCandidates(claudeHome)) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    if (json && typeof json === "object") {
      return extract(json);
    }
  }
  return emptyStatus();
}
