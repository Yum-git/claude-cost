// トランスクリプトファイル（~/.claude/projects/<slug>/*.jsonl）の列挙。
// このモジュールは vscode に依存しない（Node 標準モジュールのみ）。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TranscriptFile } from "../types";

/**
 * `claudeHome` 設定値から実際の Claude データディレクトリの絶対パスを解決する。
 * 空文字なら `~/.claude` を使う。先頭の `~` はホームディレクトリに展開する
 * （`~` 文字列のまま fs に渡さない）。
 */
export function resolveClaudeHome(claudeHome: string): string {
  const raw = (claudeHome ?? "").trim();
  if (!raw) {
    return path.join(os.homedir(), ".claude");
  }
  if (raw === "~") {
    return os.homedir();
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

/** projects ディレクトリの絶対パス。 */
export function getProjectsDir(claudeHome: string): string {
  return path.join(resolveClaudeHome(claudeHome), "projects");
}

/**
 * projects 配下の全 `*.jsonl` を再帰的に列挙する。
 *
 * トランスクリプトは 2 階層に分かれて保存される:
 *   - メインセッション: `projects/<slug>/<sessionId>.jsonl`
 *   - サブエージェント:  `projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl`
 * サブエージェントのトークン消費は親トランスクリプトには含まれず別ファイルに
 * 記録されるため、正確な集計には両方を読む必要がある。
 *
 * projectSlug は projects 直下のディレクトリ名（最上位のプロジェクト名）とする。
 * ディレクトリが存在しない・読めない場合は空配列を返す（例外は投げない）。
 */
export async function scanTranscriptFiles(
  claudeHome: string
): Promise<TranscriptFile[]> {
  const projectsDir = getProjectsDir(claudeHome);
  const files: TranscriptFile[] = [];

  let projectEntries: fs.Dirent[];
  try {
    projectEntries = await fs.promises.readdir(projectsDir, {
      withFileTypes: true,
    });
  } catch {
    return files; // projects ディレクトリが無い／読めない場合
  }

  for (const entry of projectEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const projectSlug = entry.name;
    const projectDir = path.join(projectsDir, projectSlug);
    await collectJsonlRecursive(projectDir, projectSlug, files);
  }

  return files;
}

/**
 * 指定ディレクトリ配下の `*.jsonl` を再帰的に収集する。
 * Dirent は lstat 相当で種別を判定するため、ディレクトリへのシンボリックリンクは
 * `isDirectory()` が false（`isSymbolicLink()` が true）となり辿らない。
 * 結果として実ディレクトリのみを辿るため循環参照に陥らない。
 * 読めないディレクトリはスキップする。
 */
async function collectJsonlRecursive(
  dir: string,
  projectSlug: string,
  out: TranscriptFile[]
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlRecursive(full, projectSlug, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push({ filePath: full, projectSlug });
    }
  }
}
