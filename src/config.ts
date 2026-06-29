// VSCode 設定（claudeCost.*）の型付き読み込みラッパ。
import * as vscode from "vscode";
import type { PriceOverrideEntry, UnknownModelHandling } from "./types";

export type { PriceOverrideEntry, UnknownModelHandling } from "./types";

/** 拡張機能の全設定値。 */
export interface ClaudeCostConfig {
  claudeHome: string;
  warnThresholdPercent: number;
  priceOverrides: Record<string, PriceOverrideEntry>;
  unknownModelHandling: UnknownModelHandling;
  refreshDebounceMs: number;
  notifyOnOverage: boolean;
  showRawModelNames: boolean;
  /** 使用率%取得に公式 CLI (`claude -p /usage`) を使うか。 */
  useCliUsage: boolean;
  /** `claude` 実行ファイルの上書きパス（空=自動解決）。 */
  claudeCliPath: string;
  /** CLI 使用率の取得間隔（秒, キャッシュTTL）。 */
  usageRefreshIntervalSeconds: number;
}

const SECTION = "claudeCost";

/** 現在の設定値を読み取る。 */
export function readConfig(): ClaudeCostConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    claudeHome: c.get<string>("claudeHome", ""),
    warnThresholdPercent: c.get<number>("warnThresholdPercent", 80),
    priceOverrides: c.get<Record<string, PriceOverrideEntry>>(
      "priceOverrides",
      {}
    ),
    unknownModelHandling: c.get<UnknownModelHandling>(
      "unknownModelHandling",
      "zero"
    ),
    refreshDebounceMs: c.get<number>("refreshDebounceMs", 2000),
    notifyOnOverage: c.get<boolean>("notifyOnOverage", true),
    showRawModelNames: c.get<boolean>("showRawModelNames", false),
    useCliUsage: c.get<boolean>("useCliUsage", true),
    claudeCliPath: c.get<string>("claudeCliPath", ""),
    usageRefreshIntervalSeconds: c.get<number>(
      "usageRefreshIntervalSeconds",
      300
    ),
  };
}
