// モデル別 API 価格テーブル。価格は公式価格ページで確認した公開 API 価格に基づく。
// このモジュールは vscode に依存しない。
import type { PriceOverrideEntry } from "../types";

/** プロンプト長による段階料金（閾値を超えたリクエストに適用する入出力単価）。 */
export interface LongContextPrice {
  /** この値を超えるプロンプト長（トークン）のリクエストに上位料金を適用する。 */
  thresholdTokens: number;
  /** 閾値超過時の通常入力 1M トークンあたりの USD。 */
  inputPerMTok: number;
  /** 閾値超過時の出力 1M トークンあたりの USD。 */
  outputPerMTok: number;
}

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
  /**
   * プロンプト長による段階料金（現状は Claude Haiku 5.5 のみ）。未指定なら全長で同一料金。
   * キャッシュ倍率は段階によらず共通。設定（priceOverrides）で入出力単価を上書きした
   * モデルには適用しない（buildPriceTable 参照）。
   */
  longContext?: LongContextPrice;
}

// Anthropic 公式の課金倍率（input 単価に対する係数。公式価格ページで確認）:
//   cache write 5分TTL = 1.25、cache write 1時間TTL = 2.0、cache read = 0.1。
//   cache read のみ一部モデルが個別倍率（DEFAULT_PRICE_TABLE で指定）。
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * 入力・出力単価から、標準キャッシュ倍率を付与した ModelPrice を作る。
 * cache read が標準（0.1）と異なるモデルは cacheReadMultiplier で指定する。
 */
function price(
  inputPerMTok: number,
  outputPerMTok: number,
  cacheReadMultiplier: number = CACHE_READ_MULTIPLIER
): ModelPrice {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheWrite5mMultiplier: CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1hMultiplier: CACHE_WRITE_1H_MULTIPLIER,
    cacheReadMultiplier,
  };
}

/**
 * 既定の価格表（per MTok, USD）。キーはモデル名の前方一致用プレフィックス。
 * dated suffix（例: "claude-opus-4-5-20251101"）はより短いプレフィックス
 * "claude-opus-4-5" に前方一致してヒットする。"claude-opus-5-5" のように
 * 既存キー（"claude-opus-5"）を前方に含む新モデルは、最長一致で専用キーが優先される。
 *
 * 確認元: 公式価格ページ（https://platform.claude.com/docs/en/about-claude/pricing,
 * 2026-10-22 時点）。表の値をそのまま採用している。
 *   - Fable 5.1 / Mythos 5.1 = $10 / $50（cache read は 0.025 倍）
 *   - Fable 5 / Mythos 5 = $10 / $50
 *   - Opus 5.5 = $4 / $20（cache read は 0.05 倍）
 *   - Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 = $5 / $25
 *   - Sonnet 5.5 = $2 / $10（cache read は 0.05 倍）
 *   - Sonnet 5 = $2 / $10（導入価格として告知されたが、そのまま正規価格になった）
 *   - Sonnet 4.6 / 4.5 = $3 / $15
 *   - Haiku 5.5 = $0.10 / $0.50（プロンプト 100,000 トークン超は $0.50 / $2.50）
 *   - Haiku 4.5 = $1 / $5
 * 高速モード（speed: "fast"）・US 限定推論（1.1 倍）・Batch 割引は考慮しない。
 */
export const DEFAULT_PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-fable-5-1": price(10, 50, 0.025),
  "claude-mythos-5-1": price(10, 50, 0.025),
  "claude-fable-5": price(10, 50),
  "claude-mythos-5": price(10, 50),
  "claude-opus-5-5": price(4, 20, 0.05),
  "claude-opus-5": price(5, 25),
  "claude-opus-4-8": price(5, 25),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-opus-4-5": price(5, 25),
  "claude-sonnet-5-5": price(2, 10, 0.05),
  "claude-sonnet-5": price(2, 10),
  "claude-sonnet-4-6": price(3, 15),
  "claude-sonnet-4-5": price(3, 15),
  "claude-haiku-5-5": {
    ...price(0.1, 0.5),
    longContext: { thresholdTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
  },
  "claude-haiku-4-5": price(1, 5),
};

/** 有限な非負数か（未指定・型不正・負数・NaN・Infinity は false）。 */
function isValidNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 有限な非負数ならその値、それ以外（未指定・型不正・負数・NaN・Infinity）は
 * フォールバック値を返す。設定（ユーザー編集可能な JSON）由来の不正値が
 * コスト計算に混入して NaN/負コストになるのを防ぐ。
 */
function validNumber(value: unknown, fallback: number): number {
  return isValidNumber(value) ? value : fallback;
}

/**
 * 既定の価格表に設定の上書き（部分指定可）をマージして実効価格表を作る。
 * 既定に無いプレフィックスを追加することもできる（未指定の入出力単価は 0、
 * 未指定のキャッシュ倍率は標準値）。不正な上書き値（文字列・負数・NaN 等）は
 * 無視してベース値を採用する。段階料金（longContext）は、入出力単価のどちらかを
 * 有効な値で上書きした場合は外し（指定単価を全長に一律適用）、それ以外はベースの値を
 * 引き継ぐ。既定の上位料金を残すと、長いプロンプトの方が安くなる逆転が起き得るため。
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
      const overridesRates =
        isValidNumber(ov.inputPerMTok) || isValidNumber(ov.outputPerMTok);
      table[key] = {
        ...base,
        longContext: overridesRates ? undefined : base.longContext,
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
