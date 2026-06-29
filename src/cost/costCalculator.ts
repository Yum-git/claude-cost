// 1 使用記録の API 換算コスト計算。このモジュールは vscode に依存しない。
import type { UsageRecord } from "../types";
import type { ModelPrice } from "./priceTable";

/**
 * 1 つの UsageRecord の API 換算コスト（USD）を計算する。
 * cache read / cache write(5m/1h) は input 単価にそれぞれの倍率を掛ける。
 * これが要件②「サブスクで使ったが、もし API だったらいくらか」の金額。
 */
export function recordCostUSD(record: UsageRecord, price: ModelPrice): number {
  const inputPerMTok = price.inputPerMTok;
  const usd =
    record.inputTokens * inputPerMTok +
    record.outputTokens * price.outputPerMTok +
    record.cacheReadTokens * inputPerMTok * price.cacheReadMultiplier +
    record.cacheWrite5mTokens * inputPerMTok * price.cacheWrite5mMultiplier +
    record.cacheWrite1hTokens * inputPerMTok * price.cacheWrite1hMultiplier;
  return usd / 1_000_000;
}
