// 走査結果 → コスト集計 → 使用率/超過検知 を 1 つのビューモデルにまとめるサービス層。
// 走査（全読み or 差分キャッシュ）は呼び出し側が行い、その結果 scan を受け取る。
// 使用率%も呼び出し側が取得した CLI 実測値（cliUsage）を受け取るため、本モジュールは
// vscode・ファイル走査手段の双方に依存しない（テスタブル）。
import { aggregateUsage } from "./cost/windowAggregator";
import type { CliUsage } from "./data/claudeUsageProbe";
import { readOverageStatus } from "./data/overageStatusReader";
import {
  buildOverageResult,
  computeOverage,
  type OverageResult,
} from "./overage/overageDetector";
import type {
  PriceOverrideEntry,
  ScanResult,
  ScanStats,
  UnknownModelHandling,
  UsageAggregate,
} from "./types";

export interface UsageComputeOptions {
  /** トランスクリプト走査結果（呼び出し側が全読み or 差分キャッシュで取得）。 */
  scan: ScanResult;
  /** 超過課金フラグ（参考）の読み取りに使うデータディレクトリ設定。 */
  claudeHome: string;
  warnThresholdPercent: number;
  priceOverrides: Record<string, PriceOverrideEntry>;
  unknownModelHandling: UnknownModelHandling;
  now: number;
  /** 呼び出し側が取得した CLI 使用率（5分TTL等でキャッシュ済み）。未取得は null。 */
  cliUsage: CliUsage | null;
  /** 前回までに記録した T_over（globalState 由来）。 */
  priorOverageStartTs: number | null;
}

/** UI（ステータスバー・パネル・通知）が消費する統合ビューモデル。 */
export interface UsageView {
  stats: ScanStats;
  aggregate: UsageAggregate;
  cliUsage: CliUsage | null;
  overage: OverageResult;
  generatedAt: number;
}

/**
 * 走査結果からコスト集計・使用率/超過検知までを行って UsageView を返す。
 * 呼び出し側は `view.overage.overageStartTs` を次回のために永続化する。
 */
export function computeUsageView(options: UsageComputeOptions): UsageView {
  const scan = options.scan;
  const aggregate = aggregateUsage(scan.records, scan.rateLimitEvents, {
    now: options.now,
    priceOverrides: options.priceOverrides,
    unknownModelHandling: options.unknownModelHandling,
  });
  const status = readOverageStatus(options.claudeHome);

  const { overageStartTs, overageCostUSD } = computeOverage({
    records: scan.records,
    cliUsage: options.cliUsage,
    priorOverageStartTs: options.priorOverageStartTs,
    now: options.now,
    priceOverrides: options.priceOverrides,
  });

  const overage = buildOverageResult({
    cliUsage: options.cliUsage,
    status,
    warnThresholdPercent: options.warnThresholdPercent,
    overageStartTs,
    overageCostUSD,
  });

  return {
    stats: scan.stats,
    aggregate,
    cliUsage: options.cliUsage,
    overage,
    generatedAt: options.now,
  };
}
