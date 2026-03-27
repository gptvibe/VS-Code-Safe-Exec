import type {
  CommandPatternRule,
  EditHeuristics,
  FileOperationRules,
  ProtectedCommandRule,
  RiskLevel
} from "./types";

export function normalizePatternRule(
  entry: string | Partial<CommandPatternRule>,
  fallbackRisk: RiskLevel
): CommandPatternRule | undefined {
  if (typeof entry === "string") {
    return { pattern: entry, risk: fallbackRisk };
  }

  if (!entry || typeof entry.pattern !== "string" || entry.pattern.trim().length === 0) {
    return undefined;
  }

  return {
    pattern: entry.pattern,
    description: entry.description,
    risk: entry.risk ?? fallbackRisk
  };
}

export function normalizeProtectedCommandRule(
  entry: string | Partial<ProtectedCommandRule>,
  fallbackRisk: RiskLevel
): ProtectedCommandRule | undefined {
  if (typeof entry === "string") {
    return { command: entry, risk: fallbackRisk };
  }

  if (!entry || typeof entry.command !== "string" || entry.command.trim().length === 0) {
    return undefined;
  }

  return {
    command: entry.command,
    description: entry.description,
    risk: entry.risk ?? fallbackRisk
  };
}

export function normalizeEditHeuristics(input: Partial<EditHeuristics> | undefined): Partial<EditHeuristics> {
  if (!input) {
    return {};
  }

  const result: Partial<EditHeuristics> = {};

  if (typeof input.minChangedCharacters === "number" && input.minChangedCharacters > 0) {
    result.minChangedCharacters = input.minChangedCharacters;
  }

  if (typeof input.minAffectedLines === "number" && input.minAffectedLines > 0) {
    result.minAffectedLines = input.minAffectedLines;
  }

  if (typeof input.maxPreviewCharacters === "number" && input.maxPreviewCharacters > 0) {
    result.maxPreviewCharacters = input.maxPreviewCharacters;
  }

  if (typeof input.multipleChangeCount === "number" && input.multipleChangeCount > 0) {
    result.multipleChangeCount = input.multipleChangeCount;
  }

  if (Array.isArray(input.protectedPathPatterns)) {
    result.protectedPathPatterns = input.protectedPathPatterns.filter((value): value is string => typeof value === "string");
  }

  if (Array.isArray(input.ignoredPathPatterns)) {
    result.ignoredPathPatterns = input.ignoredPathPatterns.filter((value): value is string => typeof value === "string");
  }

  return result;
}

export function normalizeFileOperationRules(input: Partial<FileOperationRules> | undefined): Partial<FileOperationRules> {
  if (!input) {
    return {};
  }

  const result: Partial<FileOperationRules> = {};

  if (typeof input.enabled === "boolean") {
    result.enabled = input.enabled;
  }

  if (typeof input.maxSnapshotBytes === "number" && input.maxSnapshotBytes > 0) {
    result.maxSnapshotBytes = input.maxSnapshotBytes;
  }

  if (typeof input.maxFilesPerOperation === "number" && input.maxFilesPerOperation > 0) {
    result.maxFilesPerOperation = input.maxFilesPerOperation;
  }

  if (typeof input.minBulkOperationCount === "number" && input.minBulkOperationCount > 0) {
    result.minBulkOperationCount = input.minBulkOperationCount;
  }

  if (Array.isArray(input.protectedPathPatterns)) {
    result.protectedPathPatterns = input.protectedPathPatterns.filter((value): value is string => typeof value === "string");
  }

  if (Array.isArray(input.ignoredPathPatterns)) {
    result.ignoredPathPatterns = input.ignoredPathPatterns.filter((value): value is string => typeof value === "string");
  }

  if (Array.isArray(input.sensitiveExtensions)) {
    result.sensitiveExtensions = input.sensitiveExtensions.filter((value): value is string => typeof value === "string");
  }

  if (Array.isArray(input.sensitiveFileNames)) {
    result.sensitiveFileNames = input.sensitiveFileNames.filter((value): value is string => typeof value === "string");
  }

  if (typeof input.captureBinarySnapshots === "boolean") {
    result.captureBinarySnapshots = input.captureBinarySnapshots;
  }

  return result;
}

export function normalizeStringArray(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function mergePatternRules(
  defaults: readonly CommandPatternRule[],
  fromFile: Array<string | Partial<CommandPatternRule>> | undefined,
  fallbackRisk: RiskLevel
): CommandPatternRule[] {
  const additions = (fromFile ?? [])
    .map((entry) => normalizePatternRule(entry, fallbackRisk))
    .filter((entry): entry is CommandPatternRule => Boolean(entry));

  return [...defaults, ...additions];
}

export function mergeProtectedCommands(
  defaults: readonly ProtectedCommandRule[],
  fromFile: Array<string | Partial<ProtectedCommandRule>> | undefined,
  fromConfig: readonly string[]
): ProtectedCommandRule[] {
  const merged = new Map<string, ProtectedCommandRule>();

  for (const rule of defaults) {
    merged.set(rule.command, rule);
  }

  for (const entry of fromFile ?? []) {
    const normalized = normalizeProtectedCommandRule(entry, "medium");
    if (normalized) {
      merged.set(normalized.command, normalized);
    }
  }

  for (const command of fromConfig) {
    if (!merged.has(command)) {
      merged.set(command, { command, risk: "medium", description: "Configured in settings" });
    }
  }

  return Array.from(merged.values());
}

export function mergePatternLists(...lists: ReadonlyArray<readonly string[]>): string[] {
  return Array.from(new Set(lists.flat().filter((value) => value.trim().length > 0)));
}
