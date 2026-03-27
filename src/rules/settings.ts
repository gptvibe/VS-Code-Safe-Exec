import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { SAMPLE_RULES_JSON } from "./defaults";
import { normalizeStringArray } from "./normalization";
import type { SafeExecSettings } from "./types";

export function getSettings(): SafeExecSettings {
  const config = vscode.workspace.getConfiguration("safeExec");
  const editHeuristics: SafeExecSettings["editHeuristics"] = {};
  const fileOps: SafeExecSettings["fileOps"] = {};
  const minChangedCharacters = getExplicitSafeExecSetting<number>(config, "editHeuristics.minChangedCharacters");
  const minAffectedLines = getExplicitSafeExecSetting<number>(config, "editHeuristics.minAffectedLines");
  const maxPreviewCharacters = getExplicitSafeExecSetting<number>(config, "editHeuristics.maxPreviewCharacters");
  const fileOpsEnabled = getExplicitSafeExecSetting<boolean>(config, "fileOps.enabled");
  const maxSnapshotBytes = getExplicitSafeExecSetting<number>(config, "fileOps.maxSnapshotBytes");
  const maxFilesPerOperation = getExplicitSafeExecSetting<number>(config, "fileOps.maxFilesPerOperation");
  const minBulkOperationCount = getExplicitSafeExecSetting<number>(config, "fileOps.minBulkOperationCount");
  const protectedPathPatterns = getExplicitSafeExecSetting<string[]>(config, "fileOps.protectedPathPatterns");
  const ignoredPathPatterns = getExplicitSafeExecSetting<string[]>(config, "fileOps.ignoredPathPatterns");
  const sensitiveExtensions = getExplicitSafeExecSetting<string[]>(config, "fileOps.sensitiveExtensions");
  const sensitiveFileNames = getExplicitSafeExecSetting<string[]>(config, "fileOps.sensitiveFileNames");
  const captureBinarySnapshots = getExplicitSafeExecSetting<boolean>(config, "fileOps.captureBinarySnapshots");

  if (typeof minChangedCharacters === "number") {
    editHeuristics.minChangedCharacters = minChangedCharacters;
  }

  if (typeof minAffectedLines === "number") {
    editHeuristics.minAffectedLines = minAffectedLines;
  }

  if (typeof maxPreviewCharacters === "number") {
    editHeuristics.maxPreviewCharacters = maxPreviewCharacters;
  }

  if (typeof fileOpsEnabled === "boolean") {
    fileOps.enabled = fileOpsEnabled;
  }

  if (typeof maxSnapshotBytes === "number") {
    fileOps.maxSnapshotBytes = maxSnapshotBytes;
  }

  if (typeof maxFilesPerOperation === "number") {
    fileOps.maxFilesPerOperation = maxFilesPerOperation;
  }

  if (typeof minBulkOperationCount === "number") {
    fileOps.minBulkOperationCount = minBulkOperationCount;
  }

  if (Array.isArray(protectedPathPatterns)) {
    fileOps.protectedPathPatterns = normalizeStringArray(protectedPathPatterns);
  }

  if (Array.isArray(ignoredPathPatterns)) {
    fileOps.ignoredPathPatterns = normalizeStringArray(ignoredPathPatterns);
  }

  if (Array.isArray(sensitiveExtensions)) {
    fileOps.sensitiveExtensions = normalizeStringArray(sensitiveExtensions);
  }

  if (Array.isArray(sensitiveFileNames)) {
    fileOps.sensitiveFileNames = normalizeStringArray(sensitiveFileNames);
  }

  if (typeof captureBinarySnapshots === "boolean") {
    fileOps.captureBinarySnapshots = captureBinarySnapshots;
  }

  return {
    enabled: config.get<boolean>("enabled", true),
    rulesPath: config.get<string>("rulesPath", ".vscode/safe-exec.rules.json"),
    policyBundles: config.get<string[]>("policyBundles", []),
    protectedCommands: config.get<string[]>("protectedCommands", []),
    terminalKillStrategy: config.get<"interruptThenDispose" | "dispose">("terminal.killStrategy", "interruptThenDispose"),
    terminalCriticalReplayPolicy: config.get<SafeExecSettings["terminalCriticalReplayPolicy"]>(
      "terminal.criticalReplayPolicy",
      "bestEffort"
    ),
    editHeuristics,
    fileOps
  };
}

export function resolveRulesPath(settings: SafeExecSettings): vscode.Uri | undefined {
  const configuredPath = settings.rulesPath.trim();
  if (!configuredPath) {
    return undefined;
  }

  if (path.isAbsolute(configuredPath)) {
    return vscode.Uri.file(configuredPath);
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  return vscode.Uri.joinPath(workspaceFolder.uri, configuredPath);
}

export async function ensureRulesFileExists(settings: SafeExecSettings): Promise<vscode.Uri | undefined> {
  const uri = resolveRulesPath(settings);
  if (!uri) {
    return undefined;
  }

  try {
    await fs.access(uri.fsPath);
    return uri;
  } catch {
    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.writeFile(uri.fsPath, SAMPLE_RULES_JSON, "utf8");
    return uri;
  }
}

function getExplicitSafeExecSetting<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const inspected = config.inspect<T>(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}
