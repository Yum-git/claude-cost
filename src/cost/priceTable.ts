// モデル別 API 価格テーブル。価格は claude-api スキルで確認した公開 API 価格に基づく。
// このモジュールは vscode に依存しない。
import type { PriceOverrideEntry } from "../types";

/** 1 モデル分の価格（per MTok, USD）とキャッシュ倍率。 */
export interface ModelPrice {
  /** 通常入力 1M トークンあたりの USD。 */
  inputPerMTok: number;
  /** 出力 1M トークンあたりの USD。 */
  outputPerMTok: number;
  /** cache write(5分TTL) の入力単価倍率。 */
  cacheWrite5mMultiplier: number;
  /** cache write(1時間TTL) の入力単価倍率。 */
  cacheWrite1hMultiplier: number;
  /** cache read の入力単価倍率。 */
  cacheReadMultiplier: number;
}

// Anthropic 公式の課金倍率（input 単価に対する係数。claude-api スキルで確認）:
//   cache write 5分TTL = 1.25、cache write 1時間TTL = 2.0、cache read = 0.1。
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;

/** 入力・出力単価から、標準キャッシュ倍率を付与した ModelPrice を作る。 */
function price(inputPerMTok: number, outputPerMTok: number): ModelPrice {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheWrite5mMultiplier: CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1hMultiplier: CACHE_WRITE_1H_MULTIPLIER,
    cacheReadMultiplier: CACHE_READ_MULTIPLIER,
  };
}

/**
 * 既定の価格表（per MTok, USD）。キーはモデル名の前方一致用プレフィックス。
 * dated suffix（例: "claude-opus-4-5-20251101"）はより短いプレフィックス
 * "claude-opus-4-5" に前方一致してヒットする。
 *
 * 確認元（claude-api スキル）:
 *   - Fable 5 / Mythos 5 = $10 / $50（公式表に記載）
 *   - Opus 4.8 / 4.7 / 4.6 = $5 / $25（公式表に記載）
 *   - Sonnet 5 = $3 / $15（公式表に記載。2026-08-31 までの導入価格 $2 / $10 は
 *     期限付きのため採用せず正規価格を使用。必要なら設定で上書き可）
 *   - Sonnet 4.6 = $3 / $15（公式表に記載）, Haiku 4.5 = $1 / $5（公式表に記載）
 *   - Opus 4.5 = $5 / $25, Sonnet 4.5 = $3 / $15（同一ティアの価格を適用。設定で上書き可）
 */
export const DEFAULT_PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-fable-5": price(10, 50),
  "claude-mythos-5": price(10, 50),
  "claude-opus-4-8": price(5, 25),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-opus-4-5": price(5, 25),
  "claude-sonnet-5": price(3, 15),
  "claude-sonnet-4-6": price(3, 15),
  "claude-sonnet-4-5": price(3, 15),
  "claude-haiku-4-5": price(1, 5),
};

/**
 * 有限な非負数ならその値、それ以外（未指定・型不正・負数・NaN・Infinity）は
 * フォールバック値を返す。設定（ユーザー編集可能な JSON）由来の不正値が
 * コスト計算に混入して NaN/負コストになるのを防ぐ。
 */
function validNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * 既定の価格表に設定の上書き（部分指定可）をマージして実効価格表を作る。
 * 既定に無いプレフィックスを追加することもできる（未指定の入出力単価は 0、
 * 未指定のキャッシュ倍率は標準値）。不正な上書き値（文字列・負数・NaN 等）は
 * 無視してベース値を採用する。
 */
export function buildPriceTable(
  overrides?: Record<string, PriceOverrideEntry>
): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = {};
  for (const [key, value] of Object.entries(DEFAULT_PRICE_TABLE)) {
    table[key] = { ...value };
  }
  if (overrides && typeof overrides === "object") {
    for (const [key, ov] of Object.entries(overrides)) {
      if (!ov || typeof ov !== "object") {
        continue;
      }
      const base = table[key] ?? price(0, 0);
      table[key] = {
        inputPerMTok: validNumber(ov.inputPerMTok, base.inputPerMTok),
        outputPerMTok: validNumber(ov.outputPerMTok, base.outputPerMTok),
        cacheWrite5mMultiplier: validNumber(
          ov.cacheWrite5mMultiplier,
          base.cacheWrite5mMultiplier
        ),
        cacheWrite1hMultiplier: validNumber(
          ov.cacheWrite1hMultiplier,
          base.cacheWrite1hMultiplier
        ),
        cacheReadMultiplier: validNumber(
          ov.cacheReadMultiplier,
          base.cacheReadMultiplier
        ),
      };
    }
  }
  return table;
}

/**
 * モデル名に（区切り境界で）最も長く前方一致するプレフィックスの価格を返す。
 * 一致するものが無ければ null（価格未定義モデル）。
 */
export function lookupPrice(
  model: string,
  table: Record<string, ModelPrice>
): ModelPrice | null {
  let best: ModelPrice | null = null;
  let bestLength = -1;
  for (const [prefix, modelPrice] of Object.entries(table)) {
    if (!model.startsWith(prefix) || prefix.length <= bestLength) {
      continue;
    }
    // 前方一致に加え、prefix 直後が「文字列終端」または「区切り文字（英数字以外。
    // 例: dated suffix の "-"、ローカルモデルの ":" など）」であることを要求する。
    // これにより "claude-opus-4-8" が将来の別モデル "claude-opus-4-80" に誤って
    // 一致するのを防ぎつつ、"claude-opus-4-8-20251101" は正しく一致させる。
    const next = model.charAt(prefix.length);
    if (next !== "" && /[A-Za-z0-9]/.test(next)) {
      continue;
    }
    best = modelPrice;
    bestLength = prefix.length;
  }
  return best;
}
