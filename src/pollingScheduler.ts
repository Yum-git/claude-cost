// 条件付き定期ポーリング。一定間隔でタイマーを回し、発火時に
//   ・VSCode ウィンドウがフォーカスされている、または
//   ・直近に活動があった（最終活動から間隔の2倍以内）
// のいずれかを満たすときだけ更新コールバックを呼ぶ。どちらも満たさない（＝VSCode を
// 見ておらず、かつ Claude Code も使っていない）ときは何もしない＝CLI を起動しない。
// これにより不使用時の無駄なポーリングを避けつつ、使用中は使用率%のリセットまたぎ等を
// 定期的に取得できる。活動駆動の即時更新（ファイル監視側）とは独立に併用する。
import * as vscode from "vscode";

export class PollingScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private intervalMs = 0;
  private activityWindowMs = 0;
  private lastActivityTs = 0;

  /**
   * @param onPoll ポーリング条件を満たしたときに呼ぶ更新コールバック。
   * @param log 診断ログ出力（内部詳細は UI に出さず Output チャネルへ）。
   */
  constructor(
    private readonly onPoll: () => void,
    private readonly log: (message: string) => void
  ) {}

  /** 活動があったことを記録する（ファイル監視の生イベントから呼ぶ）。 */
  markActivity(): void {
    this.lastActivityTs = Date.now();
  }

  /**
   * ポーリングを開始する。既に同じ間隔で動作中なら張り直さない。
   * 間隔は下限 30 秒にクランプ（settings.json 直接編集での過小値対策）。
   * 直近活動とみなす窓は間隔の 2 倍（活動が間隔程度の間隔で散発しても継続するように）。
   */
  start(intervalMs: number): void {
    const clamped = Math.max(30_000, intervalMs);
    if (this.timer && this.intervalMs === clamped) {
      return;
    }
    this.stop();
    this.intervalMs = clamped;
    this.activityWindowMs = clamped * 2;
    this.timer = setInterval(() => {
      if (this.shouldPoll()) {
        this.onPoll();
      }
    }, clamped);
    this.log(
      `定期ポーリングを開始しました（間隔 ${Math.round(clamped / 1000)} 秒・フォーカス中/直近活動時のみ）。`
    );
  }

  /** 発火時にポーリングすべきか（フォーカス中、または直近に活動あり）。 */
  private shouldPoll(): boolean {
    if (vscode.window.state.focused) {
      return true;
    }
    return Date.now() - this.lastActivityTs <= this.activityWindowMs;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stop();
  }
}
