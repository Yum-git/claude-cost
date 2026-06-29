// ステータスバー表示。CLI 実測の使用率%・状態色を常時表示し、クリックでメニュー
// （強制更新 / パネル表示 / 設定）を開く。
import * as vscode from "vscode";
import type { UsageLevel, WindowUsage } from "../overage/overageDetector";
import type { UsageView } from "../usageService";

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** 2 レベルのうち深刻な方を返す。 */
function worstLevel(a: UsageLevel, b: UsageLevel): UsageLevel {
  const rank: Record<UsageLevel, number> = {
    unavailable: 0,
    ok: 1,
    approaching: 2,
    over: 3,
  };
  return rank[a] >= rank[b] ? a : b;
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = "claudeCost.menu";
    this.item.name = "Claude Cost";
    this.setIdle();
  }

  show(): void {
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  setIdle(): void {
    this.item.text = "$(graph) Claude Cost";
    this.item.tooltip = "Claude Code の使用状況（クリックでメニュー）";
    this.item.backgroundColor = undefined;
  }

  setScanning(): void {
    // 背景色（深刻度）は更新中もあえてクリアせず維持する（警告/上限到達の色が
    // 一瞬消えてちらつかないように）。テキストのみスキャン表示に切り替える。
    this.item.text = "$(sync~spin) Claude Cost";
    this.item.tooltip = "使用状況を更新中...";
  }

  update(view: UsageView): void {
    const fiveHour = view.overage.fiveHour;
    const weekly = view.overage.weekly;
    const level = worstLevel(fiveHour.level, weekly.level);

    let icon = "$(graph)";
    let background: vscode.ThemeColor | undefined;
    if (level === "over") {
      icon = "$(error)";
      background = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (level === "approaching") {
      icon = "$(warning)";
      background = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (level === "unavailable") {
      // 使用率% を取得できていない状態。
      icon = "$(question)";
    }

    // 使用率が取れていれば 5時間・週次の % を併記。取れていなければ（CLI 未取得時）
    // 「%取得不可」と明示し、代替として 5時間・週次の API 換算コストを併記する。
    let label: string;
    if (fiveHour.percent !== null) {
      label = `5h ${fiveHour.percent}%`;
      if (weekly.percent !== null) {
        label += ` · 7d ${weekly.percent}%`;
      }
    } else {
      label =
        `%取得不可 · 5h ${usd(view.aggregate.fiveHour.costUSD)}` +
        ` · 7d ${usd(view.aggregate.weekly.costUSD)}`;
    }
    const overagePart =
      view.overage.overActive && view.overage.overageCostUSD > 0
        ? ` · 追加${usd(view.overage.overageCostUSD)}`
        : "";

    this.item.text = `${icon} Claude ${label}${overagePart}`;
    this.item.backgroundColor = background;
    this.item.tooltip = this.buildTooltip(view);
  }

  private buildTooltip(view: UsageView): vscode.MarkdownString {
    const a = view.aggregate;
    const o = view.overage;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Claude Code 使用状況**\n\n`);
    md.appendMarkdown(`使用率（公式 /usage 実測）\n`);
    if (o.fiveHour.percent === null && o.weekly.percent === null) {
      md.appendMarkdown(
        `- 使用率% は取得できていません（\`claude\` CLI 未検出、または取得失敗）。下記はローカルの API 換算コストです\n`
      );
    } else {
      md.appendMarkdown(windowLine("5時間", o.fiveHour));
      md.appendMarkdown(windowLine("週次", o.weekly));
    }
    md.appendMarkdown(`\nAPI換算コスト（もしAPIだったら）\n`);
    md.appendMarkdown(`- 5時間: ${usd(a.fiveHour.costUSD)}\n`);
    md.appendMarkdown(`- 週次: ${usd(a.weekly.costUSD)}\n`);
    md.appendMarkdown(`- 累計: ${usd(a.total.costUSD)}\n`);
    if (o.overActive && o.overageCostUSD > 0) {
      md.appendMarkdown(`\n追加使用（超過）コスト: ${usd(o.overageCostUSD)}\n`);
    }
    md.appendMarkdown(
      `\n追加使用課金(参考): ${extraUsageLabel(o.extraUsage.billingEnabled, o.extraUsage.disabledReason)}\n\n`
    );
    md.appendMarkdown(`_クリックでメニュー（更新 / 表示 / 設定）_`);
    return md;
  }
}

function windowLine(label: string, w: WindowUsage): string {
  if (w.percent === null) {
    return `- ${label}: 取得不可\n`;
  }
  const reset = w.resetText ? ` · リセット ${w.resetText}` : "";
  return `- ${label}: ${w.percent}%（${levelLabel(w.level)}）${reset}\n`;
}

function levelLabel(level: UsageLevel): string {
  switch (level) {
    case "over":
      return "⚠ 上限到達";
    case "approaching":
      return "⚠ 接近";
    case "ok":
      return "余裕あり";
    case "unavailable":
      return "取得不可";
  }
}

function extraUsageLabel(
  billingEnabled: boolean | null,
  reason: string | null
): string {
  if (billingEnabled === null) {
    return "不明";
  }
  if (billingEnabled) {
    return "有効（超過分は課金され得る）";
  }
  return `無効${reason ? `（${reason}）` : ""}`;
}
