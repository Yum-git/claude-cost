// 拡張機能全体で共有する型定義。
// データ取得層（タスク2）で使う型を定義する。コスト集計（Aggregate）系の型は
// コスト計算層（タスク3）で追加する。

/**
 * 1つのアシスタント応答から抽出した使用量レコード。
 * トランスクリプトの `message.usage` トップレベルのみを採用し、
 * `usage.iterations[]`（同値の再掲）は二重計上を避けるため使用しない。
 */
export interface UsageRecord {
  /** 応答時刻（epoch ミリ秒, UTC基準）。 */
  timestamp: number;
  /** モデル名（例: "claude-opus-4-8"）。不明時は "unknown"。 */
  model: string;
  /** 通常入力トークン（キャッシュ対象外）。 */
  inputTokens: number;
  /** 出力トークン。 */
  outputTokens: number;
  /** キャッシュ読み込みトークン。 */
  cacheReadTokens: number;
  /** キャッシュ書き込み（5分TTL）トークン。 */
  cacheWrite5mTokens: number;
  /** キャッシュ書き込み（1時間TTL）トークン。 */
  cacheWrite1hTokens: number;
  /** セッションID。欠損時はファイル名（拡張子除く）で代替。 */
  sessionId: string;
  /** プロジェクトスラッグ（projects 配下のディレクトリ名）。 */
  projectSlug: string;
}

/** レート制限（サブスク上限到達）の記録。JSONL の `error === "rate_limit"` 行に対応。 */
export interface RateLimitEvent {
  /** 上限到達時刻（epoch ミリ秒, UTC基準）。 */
  timestamp: number;
  sessionId: string;
  projectSlug: string;
}

/** 走査対象となる 1 つのトランスクリプトファイル。 */
export interface TranscriptFile {
  /** 絶対パス。 */
  filePath: string;
  /** プロジェクトスラッグ（親ディレクトリ名）。 */
  projectSlug: string;
}

/** 1ファイルのパース結果。 */
export interface ParseFileResult {
  records: UsageRecord[];
  rateLimitEvents: RateLimitEvent[];
  /** 非空行の総数。 */
  linesTotal: number;
  /** 解析対象行のうちパース失敗・必須フィールド欠損でスキップした行数。 */
  skippedLines: number;
}

/** 全トランスクリプト走査の集約結果。 */
export interface ScanResult {
  records: UsageRecord[];
  rateLimitEvents: RateLimitEvent[];
  stats: ScanStats;
}

/** 走査の統計（診断用）。 */
export interface ScanStats {
  /** 走査したファイル数。 */
  filesScanned: number;
  /** 非空行の総数。 */
  linesTotal: number;
  /** 抽出した使用量レコード数。 */
  usageRecords: number;
  /** 抽出したレート制限イベント数。 */
  rateLimitEvents: number;
  /** パース失敗・必須フィールド欠損でスキップした行数。 */
  skippedLines: number;
}

/** ログ出力関数（呼び出し側で出力先を決める。データ層は vscode に依存しない）。 */
export type LogFn = (message: string) => void;

// ---------------------------------------------------------------------------
// 設定・コスト計算で共有する型（vscode 非依存。設定読み込みは config.ts）。
// ---------------------------------------------------------------------------

/** モデル別価格の上書き 1 件分（部分指定可）。 */
export interface PriceOverrideEntry {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheWrite5mMultiplier?: number;
  cacheWrite1hMultiplier?: number;
  cacheReadMultiplier?: number;
}

/** 価格未定義モデルの扱い。 */
export type UnknownModelHandling = "zero" | "exclude" | "warn";

/** トークン種別ごとの内訳。 */
export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** モデル別の集計。 */
export interface ModelAggregate {
  model: string;
  tokens: TokenBreakdown;
  /** API 換算コスト（USD）。価格未定義モデルは 0。 */
  costUSD: number;
  /** 価格が定義されていたか（false=価格未定義モデル）。 */
  priced: boolean;
}

/** 1 期間（ウィンドウ）の集計。 */
export interface WindowAggregate {
  tokens: TokenBreakdown;
  /** API 換算コスト（USD）。 */
  costUSD: number;
  /** 集計に含めた使用記録数。 */
  recordCount: number;
  /** この期間内のレート制限到達イベント数。 */
  rateLimitCount: number;
  /** モデル別内訳（コスト降順）。 */
  byModel: ModelAggregate[];
}

/** 日次系列の 1 点。 */
export interface DailyPoint {
  /** ローカル日付 "YYYY-MM-DD"。 */
  date: string;
  tokens: TokenBreakdown;
  costUSD: number;
}

/** 全期間の集計結果。 */
export interface UsageAggregate {
  /** 直近 5 時間ローリングウィンドウ。 */
  fiveHour: WindowAggregate;
  /** 直近 7 日（週次）ウィンドウ。 */
  weekly: WindowAggregate;
  /** 当日（ローカル 0 時以降）。 */
  today: WindowAggregate;
  /** 全期間（このマシンのローカルデータ範囲）。 */
  total: WindowAggregate;
  /** 直近 N 日の日次系列（古い順・欠損日は 0 埋め）。 */
  daily: DailyPoint[];
  /** 価格未定義だったモデル名の一覧。 */
  unknownModels: string[];
  /** 価格未定義モデルに適用した扱い（UI が注記要否を判断するため）。 */
  unknownModelHandling: UnknownModelHandling;
  /** 集計を実行した時刻（epoch ミリ秒）。 */
  generatedAt: number;
}
