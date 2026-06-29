// JSONL トランスクリプトの行単位パースと、全ファイル走査の集約。
// このモジュールは vscode に依存しない（Node 標準モジュールのみ）。
import * as fs from "fs";
import * as path from "path";
import type {
  ParseFileResult,
  RateLimitEvent,
  TranscriptFile,
  UsageRecord,
} from "../types";

/** 有限な数値ならその値、それ以外は 0 を返す。 */
function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** ISO8601 文字列を epoch ミリ秒に変換。失敗時は null。 */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** linesTotal / skippedLines をミューテートで集計するためのカウンタ。 */
interface LineCounters {
  linesTotal: number;
  skippedLines: number;
}

/**
 * トランスクリプト 1 行を解釈し、`type === "assistant"` の usage を UsageRecord、
 * `error === "rate_limit"` を RateLimitEvent として出力配列に push する。
 * parseTranscriptFrom（バイト位置からの読み取り）から行ごとに呼ばれる。
 */
function processLine(
  raw: string,
  fallbackSessionId: string,
  projectSlug: string,
  records: UsageRecord[],
  rateLimitEvents: RateLimitEvent[],
  counters: LineCounters
): void {
  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }
  counters.linesTotal++;

  // 高速フィルタ: 関心のある行（assistant 応答 / rate_limit エラー）以外は
  // JSON.parse のコストを避けてスキップする。assistant 応答行は必ず型値
  // "assistant" を、レート制限行は "rate_limit" を含むため取りこぼさない。
  if (!trimmed.includes("assistant") && !trimmed.includes("rate_limit")) {
    return;
  }

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    counters.skippedLines++;
    return;
  }
  if (!obj || typeof obj !== "object") {
    return;
  }

  const sessionId =
    typeof obj.sessionId === "string" ? obj.sessionId : fallbackSessionId;

  // レート制限（上限到達）記録。型に依存せず error フィールドで判定する。
  if (obj.error === "rate_limit") {
    const ts = parseTimestamp(obj.timestamp);
    if (ts === null) {
      counters.skippedLines++;
      return;
    }
    rateLimitEvents.push({ timestamp: ts, sessionId, projectSlug });
    return;
  }

  if (obj.type !== "assistant") {
    return;
  }

  const message = obj.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") {
    return;
  }

  const ts = parseTimestamp(obj.timestamp);
  if (ts === null) {
    counters.skippedLines++;
    return;
  }

  const model = typeof message?.model === "string" ? message.model : "unknown";

  // cache_creation の 5m/1h 内訳。オブジェクトが欠損している古い行では
  // cache_creation_input_tokens を保守的に 5m 扱いとする。
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  const cacheCreation = usage.cache_creation;
  if (cacheCreation && typeof cacheCreation === "object") {
    cacheWrite5m = toNumber(cacheCreation.ephemeral_5m_input_tokens);
    cacheWrite1h = toNumber(cacheCreation.ephemeral_1h_input_tokens);
  } else {
    cacheWrite5m = toNumber(usage.cache_creation_input_tokens);
  }

  records.push({
    timestamp: ts,
    model,
    inputTokens: toNumber(usage.input_tokens),
    outputTokens: toNumber(usage.output_tokens),
    cacheReadTokens: toNumber(usage.cache_read_input_tokens),
    cacheWrite5mTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
    sessionId,
    projectSlug,
  });
}

const NEWLINE = 0x0a;
// 1 行（改行までの連続バイト）の上限。これを超えたら異常行とみなして破棄し、
// 次の改行まで読み飛ばす（改行が来ない巨大入力による leftover 肥大＝メモリ枯渇を防ぐ）。
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** parseTranscriptFrom の戻り値（差分読み後の次回開始バイト位置を含む）。 */
export interface RangeParseResult extends ParseFileResult {
  /** 次回の差分読みを開始すべきバイト位置（最後に処理しきった改行の次）。 */
  nextByteOffset: number;
}

/**
 * 1ファイルを `startByte` から末尾までストリームで読み、UsageRecord と
 * RateLimitEvent を抽出する。インクリメンタルキャッシュの差分読みに使う。
 *
 * バイト境界の安全性: UTF-8 では改行 `\n`(0x0A) はマルチバイト文字の一部に
 * 現れないため、Buffer をバイト単位で改行分割しても文字を壊さない。チャンク
 * 境界をまたぐ不完全行は次チャンクと連結してから解釈する。末尾が改行で終わら
 * ない（書き込み途中の）行は処理せず持ち越し、その手前を nextByteOffset とする
 * ため、追記の途中状態を二重・破損なく読める。
 */
export async function parseTranscriptFrom(
  file: TranscriptFile,
  startByte: number
): Promise<RangeParseResult> {
  const records: UsageRecord[] = [];
  const rateLimitEvents: RateLimitEvent[] = [];
  const counters: LineCounters = { linesTotal: 0, skippedLines: 0 };
  const fallbackSessionId = path.basename(file.filePath, ".jsonl");

  // 完全に処理しきったバイト位置（= 次回開始位置）。
  let consumed = startByte;
  // Buffer のジェネリック型差に依存しないよう Uint8Array で扱い、デコードは
  // TextDecoder に任せる（行は常に完全な UTF-8 列なので部分列の取りこぼしは無い）。
  let leftover: Uint8Array = new Uint8Array(0);
  // 上限超過した巨大行の残りを読み飛ばし中かどうか。
  let skipping = false;
  const decoder = new TextDecoder("utf-8");

  const stream = fs.createReadStream(file.filePath, {
    start: startByte < 0 ? 0 : startByte,
  });

  try {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      let buf: Uint8Array;
      let searchStart = 0;
      if (skipping) {
        // 直前に上限超過した巨大行の残りを読み飛ばし中。次の改行まで捨てる。
        const nlSkip = chunk.indexOf(NEWLINE);
        if (nlSkip === -1) {
          consumed += chunk.length; // チャンク全体が巨大行の続き
          continue;
        }
        consumed += nlSkip + 1; // 改行まで読み飛ばし、その次から通常処理
        skipping = false;
        buf = chunk.subarray(nlSkip + 1);
      } else {
        buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      }
      let nl: number;
      while ((nl = buf.indexOf(NEWLINE, searchStart)) !== -1) {
        const line = decoder.decode(buf.subarray(searchStart, nl));
        processLine(
          line,
          fallbackSessionId,
          file.projectSlug,
          records,
          rateLimitEvents,
          counters
        );
        consumed += nl - searchStart + 1; // 行本体＋改行 1 バイト
        searchStart = nl + 1;
      }
      const rest =
        searchStart < buf.length ? buf.subarray(searchStart) : new Uint8Array(0);
      if (rest.length > MAX_LINE_BYTES) {
        // 1 行が異常に長い（改行が来ない）。メモリ枯渇を防ぐため破棄し、次の改行まで
        // 読み飛ばす。破棄分は消費済みとして次回開始位置を進める。
        counters.skippedLines++;
        consumed += rest.length;
        leftover = new Uint8Array(0);
        skipping = true;
      } else {
        // 改行で終わらなかった残り（不完全行）は次チャンク／次回へ持ち越す。
        leftover = rest;
      }
    }
  } finally {
    stream.destroy();
  }

  return {
    records,
    rateLimitEvents,
    linesTotal: counters.linesTotal,
    skippedLines: counters.skippedLines,
    nextByteOffset: consumed,
  };
}
