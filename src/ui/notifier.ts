// 使用率が「接近」「上限到達」へ悪化したときにポップアップ通知する。重複通知は抑制する。
import * as vscode from "vscode";
import type { UsageLevel } from "../overage/overageDetector";
import type { UsageView } from "../usageService";

const RANK: Record<UsageLevel, number> = {
  unavailable: 0,
  ok: 1,
  approaching: 2,
  over: 3,
};

export class Notifier {
  /** 初回走査で既存状態をベースライン化したか（起動時に過去状態で鳴らさない）。 */
  private initialized = false;
  private prev = { fiveHour: "unavailable" as UsageLevel, weekly: "unavailable" as UsageLevel };

  /**
   * 使用率レベルが approaching / over へ「悪化（前回より深刻化）」したウィンドウがあれば通知する。
   * 初回はベースライン化のみ。notifyOnOverage が false の場合は状態更新のみで通知しない。
   */
  maybeNotify(view: UsageView, notifyOnOverage: boolean): void {
    const cur = {
      fiveHour: view.overage.fiveHour.level,
      weekly: view.overage.weekly.level,
    };

    if (!this.initialized) {
      this.initialized = true;
      this.prev = cur;
      return;
    }

    const escalated = (
      label: string,
      prev: UsageLevel,
      now: UsageLevel
    ): string | null => {
      // 取得不能(unavailable)からの復帰は「悪化」ではないので通知しない（誤発火防止）。
      if (prev === "unavailable") {
        return null;
      }
      if ((now === "approaching" || now === "over") && RANK[now] > RANK[prev]) {
        const pct =
          label === "5時間"
            ? view.overage.fiveHour.percent
            : view.overage.weekly.percent;
        if (now === "over") {
          return `Claude Code: ${label}の使用率が上限（${pct ?? 100}%）に到達しました。追加使用課金: ${billingLabel(view)}`;
        }
        return `Claude Code: ${label}の使用率が ${pct ?? ""}% に達しました（上限に接近）。`;
      }
      return null;
    };

    const messages: string[] = [];
    const m5 = escalated("5時間", this.prev.fiveHour, cur.fiveHour);
    if (m5) {
      messages.push(m5);
    }
    const mw = escalated("週次", this.prev.weekly, cur.weekly);
    if (mw) {
      messages.push(mw);
    }

    this.prev = cur;

    if (!notifyOnOverage || messages.length === 0) {
      return;
    }

    // 最も深刻な1件のみ通知（複数同時昇格時のスパム回避）。over を優先。
    const message =
      messages.find((m) => m.includes("到達しました")) ?? messages[0];
    void vscode.window
      .showWarningMessage(message, "パネルを開く")
      .then((choice) => {
        if (choice === "パネルを開く") {
          void vscode.commands.executeCommand("claudeCost.openPanel");
        }
      });
  }
}

function billingLabel(view: UsageView): string {
  const eu = view.overage.extraUsage;
  if (eu.billingEnabled === null) {
    return "不明";
  }
  return eu.billingEnabled
    ? "有効（超過分は課金され得る）"
    : `無効${eu.disabledReason ? `（${eu.disabledReason}）` : ""}`;
}
