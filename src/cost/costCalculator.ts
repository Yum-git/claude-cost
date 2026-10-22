// 1 使用記録の API 換算コスト計算。このモジュールは vscode に依存しない。
import type { UsageRecord } from "../types";
import type { ModelPrice } from "./priceTable";

/**
 * 1 つの UsageRecord の API 換算コスト（USD）を計算する。
 * cache read / cache write(5m/1h) は input 単価にそれぞれの倍率を掛ける。
 * 段階料金（price.longContext）を持つモデルは、そのリクエストのプロンプト長
 * （公式定義どおり input + cache read + cache write の合計）が閾値を超えたら
 * 入出力単価を上位料金に置き換える（キャッシュ倍率は共通）。
 * これが要件②「サブスクで使ったが、もし API だったらいくらか」の金額。
 */
export function recordCostUSD(record: UsageRecord, price: ModelPrice): number {
  const promptTokens =
    record.inputTokens +
    record.cacheReadTokens +
    record.cacheWrite5mTokens +
    record.cacheWrite1hTokens;
  const rates =
    price.longContext && promptTokens > price.longContext.thresholdTokens
      ? price.longContext
      : price;
  const inputPerMTok = rates.inputPerMTok;
  const usd =
    record.inputTokens * inputPerMTok +
    record.outputTokens * rates.outputPerMTok +
    record.cacheReadTokens * inputPerMTok * price.cacheReadMultiplier +
    record.cacheWrite5mTokens * inputPerMTok * price.cacheWrite5mMultiplier +
    record.cacheWrite1hTokens * inputPerMTok * price.cacheWrite1hMultiplier;
  return usd / 1_000_000;
}
