// 使用記録を期間（5時間/週次/当日/累計）と日次系列に集計する。
// このモジュールは vscode に依存しない。
import type {
  DailyPoint,
  ModelAggregate,
  PriceOverrideEntry,
  RateLimitEvent,
  TokenBreakdown,
  UnknownModelHandling,
  UsageAggregate,
  UsageRecord,
  WindowAggregate,
} from "../types";
import { recordCostUSD } from "./costCalculator";
import { buildPriceTable, lookupPrice, type ModelPrice } from "./priceTable";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface AggregateOptions {
  /** 集計基準時刻（epoch ミリ秒）。 */
  now: number;
  /** モデル別価格の上書き。 */
  priceOverrides?: Record<string, PriceOverrideEntry>;
  /** 価格未定義モデルの扱い（既定 "zero"）。 */
  unknownModelHandling?: UnknownModelHandling;
  /** 日次系列の日数（既定 30）。 */
  dailyDays?: number;
}

function emptyTokens(): TokenBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

function addTokens(target: TokenBreakdown, record: UsageRecord): void {
  target.inputTokens += record.inputTokens;
  target.outputTokens += record.outputTokens;
  target.cacheReadTokens += record.cacheReadTokens;
  target.cacheWrite5mTokens += record.cacheWrite5mTokens;
  target.cacheWrite1hTokens += record.cacheWrite1hTokens;
}

function totalTokens(tokens: TokenBreakdown): number {
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheReadTokens +
    tokens.cacheWrite5mTokens +
    tokens.cacheWrite1hTokens
  );
}

interface ModelAcc {
  tokens: TokenBreakdown;
  costUSD: number;
  priced: boolean;
}

interface BucketAcc {
  tokens: TokenBreakdown;
  costUSD: number;
  recordCount: number;
  rateLimitCount: number;
  byModel: Map<string, ModelAcc>;
}

function newBucket(): BucketAcc {
  return {
    tokens: emptyTokens(),
    costUSD: 0,
    recordCount: 0,
    rateLimitCount: 0,
    byModel: new Map(),
  };
}

function addToBucket(
  bucket: BucketAcc,
  record: UsageRecord,
  cost: number,
  priced: boolean
): void {
  addTokens(bucket.tokens, record);
  bucket.costUSD += cost;
  bucket.recordCount++;
  let model = bucket.byModel.get(record.model);
  if (!model) {
    model = { tokens: emptyTokens(), costUSD: 0, priced };
    bucket.byModel.set(record.model, model);
  }
  addTokens(model.tokens, record);
  model.costUSD += cost;
}

function finalizeBucket(bucket: BucketAcc): WindowAggregate {
  const byModel: ModelAggregate[] = [...bucket.byModel.entries()]
    .map(([model, acc]) => ({
      model,
      tokens: acc.tokens,
      costUSD: acc.costUSD,
      priced: acc.priced,
    }))
    .sort(
      (a, b) =>
        b.costUSD - a.costUSD || totalTokens(b.tokens) - totalTokens(a.tokens)
    );
  return {
    tokens: bucket.tokens,
    costUSD: bucket.costUSD,
    recordCount: bucket.recordCount,
    rateLimitCount: bucket.rateLimitCount,
    byModel,
  };
}

/**
 * epoch ミリ秒からローカル日付 "YYYY-MM-DD" を作る。
 * トランスクリプトの timestamp は UTC だが、日次系列・当日ウィンドウは
 * 利用者のローカルタイムゾーン基準で切り出す（このマシンのローカルツールのため）。
 */
function localDateKey(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 全使用記録とレート制限イベントを、5時間/週次/当日/累計の各ウィンドウと
 * 日次系列に集計する。価格未定義モデルは設定に応じて 0 円扱い or 除外する。
 */
export function aggregateUsage(
  records: UsageRecord[],
  rateLimitEvents: RateLimitEvent[],
  options: AggregateOptions
): UsageAggregate {
  const now = options.now;
  const handling = options.unknownModelHandling ?? "zero";
  const dailyDays = options.dailyDays ?? 30;
  const table = buildPriceTable(options.priceOverrides);

  const fiveHourCutoff = now - 5 * HOUR_MS;
  const weeklyCutoff = now - 7 * DAY_MS;
  const todayStartDate = new Date(now);
  todayStartDate.setHours(0, 0, 0, 0);
  const todayStart = todayStartDate.getTime();

  const total = newBucket();
  const fiveHour = newBucket();
  const weekly = newBucket();
  const today = newBucket();
  const dailyMap = new Map<string, { tokens: TokenBreakdown; costUSD: number }>();
  const unknownModels = new Set<string>();

  for (const record of records) {
    const modelPrice = lookupPrice(record.model, table);
    const priced = modelPrice !== null;
    if (!priced) {
      unknownModels.add(record.model);
      if (handling === "exclude") {
        continue;
      }
    }
    const cost = priced ? recordCostUSD(record, modelPrice as ModelPrice) : 0;

    addToBucket(total, record, cost, priced);
    if (record.timestamp >= fiveHourCutoff && record.timestamp <= now) {
      addToBucket(fiveHour, record, cost, priced);
    }
    if (record.timestamp >= weeklyCutoff && record.timestamp <= now) {
      addToBucket(weekly, record, cost, priced);
    }
    if (record.timestamp >= todayStart && record.timestamp <= now) {
      addToBucket(today, record, cost, priced);
    }

    // total と dailyMap は全期間を対象に加算する（`<= now` の上限は付けない。
    // 描画は now 起点の過去 dailyDays 日のみ参照するため未来日付は出力されない）。
    // 「直近の過去ウィンドウ」を表す 5h/週次/当日だけが now を上限とする。
    const key = localDateKey(record.timestamp);
    let point = dailyMap.get(key);
    if (!point) {
      point = { tokens: emptyTokens(), costUSD: 0 };
      dailyMap.set(key, point);
    }
    addTokens(point.tokens, record);
    point.costUSD += cost;
  }

  for (const event of rateLimitEvents) {
    total.rateLimitCount++;
    if (event.timestamp >= fiveHourCutoff && event.timestamp <= now) {
      fiveHour.rateLimitCount++;
    }
    if (event.timestamp >= weeklyCutoff && event.timestamp <= now) {
      weekly.rateLimitCount++;
    }
    if (event.timestamp >= todayStart && event.timestamp <= now) {
      today.rateLimitCount++;
    }
  }

  // 日次系列を 0 埋めで構築（古い順）。
  const daily: DailyPoint[] = [];
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  for (let i = dailyDays - 1; i >= 0; i--) {
    const d = new Date(base.getTime());
    d.setDate(base.getDate() - i);
    const key = localDateKey(d.getTime());
    const point = dailyMap.get(key);
    daily.push({
      date: key,
      tokens: point ? point.tokens : emptyTokens(),
      costUSD: point ? point.costUSD : 0,
    });
  }

  return {
    fiveHour: finalizeBucket(fiveHour),
    weekly: finalizeBucket(weekly),
    today: finalizeBucket(today),
    total: finalizeBucket(total),
    daily,
    unknownModels: [...unknownModels],
    unknownModelHandling: handling,
    generatedAt: now,
  };
}
