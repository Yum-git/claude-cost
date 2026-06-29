// 使用率・超過の判定。使用率%は公式CLI `/usage` の実測値を一次ソースとする。
// 超過コスト（要件③）は「5時間ウィンドウが100%到達を最初に観測した時刻(T_over)以降に
// JSONLへ記録されたトークン」をAPI価格で換算して求める（上限値や重み付けを知る必要がない）。
// このモジュールは vscode に依存しない。
import type { PriceOverrideEntry, UsageRecord } from "../types";
import type { CliUsage } from "../data/claudeUsageProbe";
import type { OverageStatus } from "../data/overageStatusReader";
import { recordCostUSD } from "../cost/costCalculator";
import { buildPriceTable, lookupPrice } from "../cost/priceTable";

const FIVE_HOUR_MS = 5 * 3_600_000;

/** 使用率のレベル。 */
export type UsageLevel =
  | "unavailable" // CLI から取得できなかった
  | "ok" // 余裕あり
  | "approaching" // 上限に接近（閾値超）
  | "over"; // 上限到達（100%以上）

/** 1 ウィンドウの使用率状態。 */
export interface WindowUsage {
  /** 使用率%（取得不可なら null）。 */
  percent: number | null;
  /** リセット時刻（人間可読テキスト）。 */
  resetText: string | null;
  level: UsageLevel;
}

/** ~/.claude.json から導いた追加使用課金の状態（すべて参考値）。 */
export interface ExtraUsageState {
  statusAvailable: boolean;
  /** 追加使用課金が有効か（true=超過分が課金され得る / false=無効=超過で停止 / null=不明）。 */
  billingEnabled: boolean | null;
  disabledReason: string | null;
  hasAvailableSubscription: boolean | null;
  passesRemaining: number | null;
  creditAvailable: boolean | null;
}

/** 超過検知の総合結果。 */
export interface OverageResult {
  fiveHour: WindowUsage;
  weekly: WindowUsage;
  /** 週次（Sonnet only）の使用率%。 */
  sonnetWeeklyPercent: number | null;
  extraUsage: ExtraUsageState;
  /** 5時間ウィンドウが100%到達を最初に観測した時刻（epoch ms）。null=未到達。 */
  overageStartTs: number | null;
  /** T_over 以降のトークンの API 換算コスト（USD）＝要件③の追加使用コスト概算。 */
  overageCostUSD: number;
  /** 現在 5時間ウィンドウが100%以上か。 */
  overActive: boolean;
}

/** 使用率%と閾値からレベルを決める。 */
export function deriveLevel(
  percent: number | null,
  warnThresholdPercent: number
): UsageLevel {
  if (percent === null) {
    return "unavailable";
  }
  if (percent >= 100) {
    return "over";
  }
  if (percent >= warnThresholdPercent) {
    return "approaching";
  }
  return "ok";
}

/** OverageStatus を UI 向けの ExtraUsageState に変換する。 */
export function buildExtraUsageState(status: OverageStatus): ExtraUsageState {
  const billingEnabled = !status.available
    ? null
    : status.extraUsageDisabledReason
      ? false
      : true;
  return {
    statusAvailable: status.available,
    billingEnabled,
    disabledReason: status.extraUsageDisabledReason,
    hasAvailableSubscription: status.hasAvailableSubscription,
    passesRemaining: status.passesRemaining,
    creditAvailable: status.overageCreditAvailable,
  };
}

export interface OverageComputeParams {
  records: UsageRecord[];
  cliUsage: CliUsage | null;
  /** 前回までに記録した T_over（globalState 由来）。 */
  priorOverageStartTs: number | null;
  now: number;
  priceOverrides: Record<string, PriceOverrideEntry>;
}

/**
 * T_over（5時間ウィンドウが100%到達を最初に観測した時刻）を更新し、
 * その時刻以降（かつ現5時間ウィンドウ内）のトークンの API 換算コストを求める。
 *
 * - 5時間% >= 100 を観測: T_over 未設定なら now を記録、設定済みなら維持。
 * - 5時間% < 100 を確認:  ウィンドウ未超過/リセットとみなし T_over をクリア。
 * - CLI 取得不可（null）: 情報が無いので前回値を維持。
 *
 * 注: T_over は「初めて100%を観測した時刻」であり、厳密な到達瞬間とは
 * ポーリング間隔ぶん（最大数分）ずれ得る（許容済みの近似値）。
 */
export function computeOverage(params: OverageComputeParams): {
  overageStartTs: number | null;
  overageCostUSD: number;
} {
  const pct = params.cliUsage?.fiveHourPercent ?? null;

  let overageStartTs: number | null;
  if (pct !== null && pct >= 100) {
    overageStartTs = params.priorOverageStartTs ?? params.now;
  } else if (pct !== null) {
    overageStartTs = null;
  } else {
    overageStartTs = params.priorOverageStartTs;
  }

  let overageCostUSD = 0;
  if (overageStartTs !== null) {
    // 現5時間ウィンドウ内に限定（ウィンドウが回ったのに未観測でも誤って遡らない）。
    const from = Math.max(overageStartTs, params.now - FIVE_HOUR_MS);
    const table = buildPriceTable(params.priceOverrides);
    for (const record of params.records) {
      if (record.timestamp >= from && record.timestamp <= params.now) {
        const price = lookupPrice(record.model, table);
        if (price) {
          overageCostUSD += recordCostUSD(record, price);
        }
      }
    }
  }

  return { overageStartTs, overageCostUSD };
}

/** CLI 使用率・超過状態・課金状態を統合して OverageResult を組み立てる。 */
export function buildOverageResult(params: {
  cliUsage: CliUsage | null;
  status: OverageStatus;
  warnThresholdPercent: number;
  overageStartTs: number | null;
  overageCostUSD: number;
}): OverageResult {
  const cli = params.cliUsage;
  const fiveHour: WindowUsage = {
    percent: cli?.fiveHourPercent ?? null,
    resetText: cli?.fiveHourResetText ?? null,
    level: deriveLevel(cli?.fiveHourPercent ?? null, params.warnThresholdPercent),
  };
  const weekly: WindowUsage = {
    percent: cli?.weeklyPercent ?? null,
    resetText: cli?.weeklyResetText ?? null,
    level: deriveLevel(cli?.weeklyPercent ?? null, params.warnThresholdPercent),
  };
  return {
    fiveHour,
    weekly,
    sonnetWeeklyPercent: cli?.sonnetWeeklyPercent ?? null,
    extraUsage: buildExtraUsageState(params.status),
    overageStartTs: params.overageStartTs,
    overageCostUSD: params.overageCostUSD,
    overActive: (cli?.fiveHourPercent ?? 0) >= 100,
  };
}
