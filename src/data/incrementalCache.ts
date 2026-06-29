// プロセス内のインクリメンタルキャッシュ。
// ファイル別に {size, mtimeMs, byteOffset, 抽出済みレコード} を保持し、再走査時は
//   - 変化なし（size/mtime 一致） → 再利用（読まない）
//   - 追記（size 増加）           → byteOffset から差分のみ読む
//   - 新規 / 縮小（ローテート）    → 先頭から全読み
// として、毎回の全ファイル全読みを避ける。永続化はせずプロセス内に保持する
// （起動時に一度だけフル走査が走る）。このモジュールは vscode に依存しない。
import * as fs from "fs";
import type {
  LogFn,
  RateLimitEvent,
  ScanResult,
  ScanStats,
  UsageRecord,
} from "../types";
import { parseTranscriptFrom } from "./jsonlParser";
import { scanTranscriptFiles } from "./transcriptScanner";

interface FileCacheEntry {
  /** 最後に観測したファイルサイズ（バイト）。 */
  size: number;
  /** 最後に観測した更新時刻（ミリ秒）。 */
  mtimeMs: number;
  /** 次回の差分読みを開始すべきバイト位置。 */
  byteOffset: number;
  /** このファイルから抽出した使用量レコード（時系列順に蓄積）。 */
  records: UsageRecord[];
  /** このファイルから抽出したレート制限イベント。 */
  rateLimitEvents: RateLimitEvent[];
  linesTotal: number;
  skippedLines: number;
}

/** 大配列でも安全に（スプレッド引数のスタック超過を避けて）末尾連結する。 */
function appendAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) {
    target.push(item);
  }
}

/**
 * 差分読みによるトランスクリプト走査キャッシュ。
 * 同一インスタンスを使い回す限り、変化のないファイルは読み直さない。
 */
export class UsageCache {
  private readonly entries = new Map<string, FileCacheEntry>();

  /**
   * projects 配下を走査し、変化したファイルのみ（差分）読んで全レコードを返す。
   * 個々のファイルの stat/読み込みで例外が出ても全体は止めず、件数のみ記録する。
   */
  async refresh(claudeHome: string, log?: LogFn): Promise<ScanResult> {
    const files = await scanTranscriptFiles(claudeHome);
    const seen = new Set<string>();
    let failedFiles = 0;
    let updatedFiles = 0;
    let reusedFiles = 0;

    for (const file of files) {
      seen.add(file.filePath);
      try {
        const st = await fs.promises.stat(file.filePath);
        const cached = this.entries.get(file.filePath);

        if (
          cached &&
          cached.size === st.size &&
          cached.mtimeMs === st.mtimeMs
        ) {
          reusedFiles++;
          continue; // size・mtime とも不変 → 再利用
        }

        if (cached && st.size > cached.size) {
          // 追記（size 増加） → 前回位置から差分のみ読み、既存レコードに追加する。
          const part = await parseTranscriptFrom(file, cached.byteOffset);
          appendAll(cached.records, part.records);
          appendAll(cached.rateLimitEvents, part.rateLimitEvents);
          cached.linesTotal += part.linesTotal;
          cached.skippedLines += part.skippedLines;
          cached.size = st.size;
          cached.mtimeMs = st.mtimeMs;
          cached.byteOffset = part.nextByteOffset;
          updatedFiles++;
        } else {
          // 新規 / 縮小（ローテート）/ 同サイズだが mtime が変わった書き換え → 全読み。
          // （size も mtime も同一なら上の再利用分岐で検知対象外になる。JSONL は追記
          //  のみで size が単調増加するため、この取りこぼしは実運用上発生しない。）
          const part = await parseTranscriptFrom(file, 0);
          this.entries.set(file.filePath, {
            size: st.size,
            mtimeMs: st.mtimeMs,
            byteOffset: part.nextByteOffset,
            records: part.records,
            rateLimitEvents: part.rateLimitEvents,
            linesTotal: part.linesTotal,
            skippedLines: part.skippedLines,
          });
          updatedFiles++;
        }
      } catch {
        failedFiles++;
      }
    }

    // 削除されたファイルをキャッシュから除去する。
    for (const key of [...this.entries.keys()]) {
      if (!seen.has(key)) {
        this.entries.delete(key);
      }
    }

    // 全エントリを結合して ScanResult を組み立てる。
    const records: UsageRecord[] = [];
    const rateLimitEvents: RateLimitEvent[] = [];
    let linesTotal = 0;
    let skippedLines = 0;
    for (const entry of this.entries.values()) {
      appendAll(records, entry.records);
      appendAll(rateLimitEvents, entry.rateLimitEvents);
      linesTotal += entry.linesTotal;
      skippedLines += entry.skippedLines;
    }

    const stats: ScanStats = {
      filesScanned: files.length,
      linesTotal,
      usageRecords: records.length,
      rateLimitEvents: rateLimitEvents.length,
      skippedLines,
    };

    log?.(
      `走査完了(差分): ファイル=${stats.filesScanned} ` +
        `(更新=${updatedFiles}, 再利用=${reusedFiles}, 失敗=${failedFiles}), ` +
        `使用記録=${stats.usageRecords}, 上限到達=${stats.rateLimitEvents}, ` +
        `スキップ行=${stats.skippedLines}`
    );

    return { records, rateLimitEvents, stats };
  }

  /** キャッシュを破棄する（claudeHome 変更時などデータ範囲が変わる場合に呼ぶ）。 */
  clear(): void {
    this.entries.clear();
  }
}
