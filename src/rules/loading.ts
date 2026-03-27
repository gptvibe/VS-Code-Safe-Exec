import * as fs from "fs/promises";
import type * as vscode from "vscode";
import { DEFAULT_RULES } from "./defaults";
import {
  mergePatternLists,
  mergePatternRules,
  mergeProtectedCommands,
  normalizeEditHeuristics,
  normalizeFileOperationRules,
  normalizeStringArray
} from "./normalization";
import { getPolicyBundleDefinitions } from "./policyBundles";
import type { PartialRuleInput } from "./schema";
import { getSettings, resolveRulesPath } from "./settings";
import type { SafeExecRules } from "./types";

async function readFileRules(uri: vscode.Uri | undefined, output: vscode.OutputChannel): Promise<PartialRuleInput> {
  if (!uri) {
    return {};
  }

  try {
    const buffer = await fs.readFile(uri.fsPath, "utf8");
    const parsed = JSON.parse(buffer) as PartialRuleInput;
    output.appendLine(`[rules] Loaded rules file from ${uri.fsPath}`);
    return parsed;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      output.appendLine(`[rules] Rules file not found at ${uri.fsPath}; using defaults.`);
      return {};
    }

    output.appendLine(`[rules] Failed to read rules file at ${uri.fsPath}: ${nodeError.message}`);
    throw error;
  }
}

export async function loadEffectiveRules(output: vscode.OutputChannel): Promise<SafeExecRules> {
  const settings = getSettings();
  const fileRules = await readFileRules(resolveRulesPath(settings), output);
  const bundleDefinitions = getPolicyBundleDefinitions(
    [...normalizeStringArray(fileRules.policyBundles), ...normalizeStringArray(settings.policyBundles)],
    output
  );
  const bundledDangerousCommands = bundleDefinitions.flatMap((bundle) => bundle.dangerousCommands ?? []);
  const bundledAllowedCommands = bundleDefinitions.flatMap((bundle) => bundle.allowedCommands ?? []);
  const bundledConfirmationCommands = bundleDefinitions.flatMap((bundle) => bundle.confirmationCommands ?? []);
  const bundledProtectedCommands = bundleDefinitions.flatMap((bundle) => bundle.protectedCommands ?? []);
  const bundledProtectedPathPatterns = bundleDefinitions.flatMap((bundle) => bundle.editHeuristics?.protectedPathPatterns ?? []);
  const bundledIgnoredPathPatterns = bundleDefinitions.flatMap((bundle) => bundle.editHeuristics?.ignoredPathPatterns ?? []);
  const bundledFileProtectedPathPatterns = bundleDefinitions.flatMap(
    (bundle) => bundle.fileOps?.protectedPathPatterns ?? bundle.editHeuristics?.protectedPathPatterns ?? []
  );
  const bundledFileIgnoredPathPatterns = bundleDefinitions.flatMap(
    (bundle) => bundle.fileOps?.ignoredPathPatterns ?? bundle.editHeuristics?.ignoredPathPatterns ?? []
  );
  const bundledSensitiveExtensions = bundleDefinitions.flatMap((bundle) => bundle.fileOps?.sensitiveExtensions ?? []);
  const bundledSensitiveFileNames = bundleDefinitions.flatMap((bundle) => bundle.fileOps?.sensitiveFileNames ?? []);
  const normalizedFileEditHeuristics = normalizeEditHeuristics(fileRules.editHeuristics);
  const normalizedSettingEditHeuristics = normalizeEditHeuristics(settings.editHeuristics);
  const normalizedFileFileOps = normalizeFileOperationRules(fileRules.fileOps);
  const normalizedSettingFileOps = normalizeFileOperationRules(settings.fileOps);
  const mergedEditHeuristics = {
    ...DEFAULT_RULES.editHeuristics,
    ...normalizedFileEditHeuristics,
    ...normalizedSettingEditHeuristics
  };
  const mergedFileOps = {
    ...DEFAULT_RULES.fileOps,
    ...normalizedFileFileOps,
    ...normalizedSettingFileOps
  };

  return {
    dangerousCommands: mergePatternRules(
      [...DEFAULT_RULES.dangerousCommands, ...bundledDangerousCommands],
      fileRules.dangerousCommands,
      "critical"
    ),
    allowedCommands: mergePatternRules(
      [...DEFAULT_RULES.allowedCommands, ...bundledAllowedCommands],
      fileRules.allowedCommands,
      "low"
    ),
    confirmationCommands: mergePatternRules(
      [...DEFAULT_RULES.confirmationCommands, ...bundledConfirmationCommands],
      fileRules.confirmationCommands,
      "high"
    ),
    protectedCommands: mergeProtectedCommands(
      [...DEFAULT_RULES.protectedCommands, ...bundledProtectedCommands],
      fileRules.protectedCommands,
      settings.protectedCommands
    ),
    editHeuristics: {
      minChangedCharacters: mergedEditHeuristics.minChangedCharacters ?? DEFAULT_RULES.editHeuristics.minChangedCharacters,
      minAffectedLines: mergedEditHeuristics.minAffectedLines ?? DEFAULT_RULES.editHeuristics.minAffectedLines,
      maxPreviewCharacters: mergedEditHeuristics.maxPreviewCharacters ?? DEFAULT_RULES.editHeuristics.maxPreviewCharacters,
      multipleChangeCount: mergedEditHeuristics.multipleChangeCount ?? DEFAULT_RULES.editHeuristics.multipleChangeCount,
      protectedPathPatterns: mergePatternLists(
        DEFAULT_RULES.editHeuristics.protectedPathPatterns,
        bundledProtectedPathPatterns,
        normalizedFileEditHeuristics.protectedPathPatterns ?? [],
        normalizedSettingEditHeuristics.protectedPathPatterns ?? []
      ),
      ignoredPathPatterns: mergePatternLists(
        DEFAULT_RULES.editHeuristics.ignoredPathPatterns,
        bundledIgnoredPathPatterns,
        normalizedFileEditHeuristics.ignoredPathPatterns ?? [],
        normalizedSettingEditHeuristics.ignoredPathPatterns ?? []
      )
    },
    fileOps: {
      enabled: mergedFileOps.enabled ?? DEFAULT_RULES.fileOps.enabled,
      maxSnapshotBytes: mergedFileOps.maxSnapshotBytes ?? DEFAULT_RULES.fileOps.maxSnapshotBytes,
      maxFilesPerOperation: mergedFileOps.maxFilesPerOperation ?? DEFAULT_RULES.fileOps.maxFilesPerOperation,
      minBulkOperationCount: mergedFileOps.minBulkOperationCount ?? DEFAULT_RULES.fileOps.minBulkOperationCount,
      protectedPathPatterns: mergePatternLists(
        DEFAULT_RULES.fileOps.protectedPathPatterns,
        bundledFileProtectedPathPatterns,
        normalizedFileEditHeuristics.protectedPathPatterns ?? [],
        normalizedFileFileOps.protectedPathPatterns ?? [],
        normalizedSettingFileOps.protectedPathPatterns ?? []
      ),
      ignoredPathPatterns: mergePatternLists(
        DEFAULT_RULES.fileOps.ignoredPathPatterns,
        bundledFileIgnoredPathPatterns,
        normalizedFileEditHeuristics.ignoredPathPatterns ?? [],
        normalizedFileFileOps.ignoredPathPatterns ?? [],
        normalizedSettingFileOps.ignoredPathPatterns ?? []
      ),
      sensitiveExtensions: mergePatternLists(
        DEFAULT_RULES.fileOps.sensitiveExtensions,
        bundledSensitiveExtensions,
        normalizedFileFileOps.sensitiveExtensions ?? [],
        normalizedSettingFileOps.sensitiveExtensions ?? []
      ),
      sensitiveFileNames: mergePatternLists(
        DEFAULT_RULES.fileOps.sensitiveFileNames,
        bundledSensitiveFileNames,
        normalizedFileFileOps.sensitiveFileNames ?? [],
        normalizedSettingFileOps.sensitiveFileNames ?? []
      ),
      captureBinarySnapshots: mergedFileOps.captureBinarySnapshots ?? DEFAULT_RULES.fileOps.captureBinarySnapshots
    }
  };
}
