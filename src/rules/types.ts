export type RiskLevel = "low" | "medium" | "high" | "critical";
export type TerminalCriticalReplayPolicy =
  | "bestEffort"
  | "shellIntegrationOnly"
  | "manualReplay"
  | "denyIfStopUnconfirmed";

export interface CommandPatternRule {
  pattern: string;
  description?: string;
  risk?: RiskLevel;
}

export interface ProtectedCommandRule {
  command: string;
  description?: string;
  risk?: RiskLevel;
}

export interface EditHeuristics {
  minChangedCharacters: number;
  minAffectedLines: number;
  maxPreviewCharacters: number;
  multipleChangeCount: number;
  protectedPathPatterns: string[];
  ignoredPathPatterns: string[];
}

export interface FileOperationRules {
  enabled: boolean;
  maxSnapshotBytes: number;
  maxFilesPerOperation: number;
  minBulkOperationCount: number;
  protectedPathPatterns: string[];
  ignoredPathPatterns: string[];
  sensitiveExtensions: string[];
  sensitiveFileNames: string[];
  captureBinarySnapshots: boolean;
}

export interface SafeExecRules {
  dangerousCommands: CommandPatternRule[];
  allowedCommands: CommandPatternRule[];
  confirmationCommands: CommandPatternRule[];
  protectedCommands: ProtectedCommandRule[];
  editHeuristics: EditHeuristics;
  fileOps: FileOperationRules;
}

export interface PolicyBundleDefinition {
  id: string;
  label: string;
  description: string;
  dangerousCommands?: CommandPatternRule[];
  allowedCommands?: CommandPatternRule[];
  confirmationCommands?: CommandPatternRule[];
  protectedCommands?: ProtectedCommandRule[];
  editHeuristics?: Partial<Pick<EditHeuristics, "protectedPathPatterns" | "ignoredPathPatterns">>;
  fileOps?: Partial<Pick<FileOperationRules, "protectedPathPatterns" | "ignoredPathPatterns" | "sensitiveExtensions" | "sensitiveFileNames">>;
}

export interface SafeExecSettings {
  enabled: boolean;
  rulesPath: string;
  policyBundles: string[];
  protectedCommands: string[];
  terminalKillStrategy: "interruptThenDispose" | "dispose";
  terminalCriticalReplayPolicy: TerminalCriticalReplayPolicy;
  editHeuristics: Partial<Pick<EditHeuristics, "minChangedCharacters" | "minAffectedLines" | "maxPreviewCharacters">>;
  fileOps: Partial<
    Pick<
      FileOperationRules,
      | "enabled"
      | "maxSnapshotBytes"
      | "maxFilesPerOperation"
      | "minBulkOperationCount"
      | "protectedPathPatterns"
      | "ignoredPathPatterns"
      | "sensitiveExtensions"
      | "sensitiveFileNames"
      | "captureBinarySnapshots"
    >
  >;
}

export interface CompiledRegexPattern {
  pattern: string;
  regex?: RegExp;
  error?: string;
}

export interface CompiledCommandPatternRule {
  rule: CommandPatternRule;
  matcher: CompiledRegexPattern;
}

export interface ExactProtectedCommandMatcher {
  kind: "exact";
  value: string;
}

export interface RegexProtectedCommandMatcher {
  kind: "regex";
  pattern: string;
  regex?: RegExp;
  error?: string;
}

export interface EmptyProtectedCommandMatcher {
  kind: "empty";
}

export type CompiledProtectedCommandMatcher =
  | ExactProtectedCommandMatcher
  | RegexProtectedCommandMatcher
  | EmptyProtectedCommandMatcher;

export interface CompiledProtectedCommandRule {
  rule: ProtectedCommandRule;
  matcher: CompiledProtectedCommandMatcher;
}

export interface CompiledEditHeuristics extends EditHeuristics {
  protectedPathMatchers: CompiledRegexPattern[];
  ignoredPathMatchers: CompiledRegexPattern[];
}

export interface CompiledFileOperationRules extends FileOperationRules {
  protectedPathMatchers: CompiledRegexPattern[];
  ignoredPathMatchers: CompiledRegexPattern[];
}

export interface CompiledRules {
  raw: SafeExecRules;
  dangerousCommands: CompiledCommandPatternRule[];
  allowedCommands: CompiledCommandPatternRule[];
  confirmationCommands: CompiledCommandPatternRule[];
  protectedCommands: CompiledProtectedCommandRule[];
  editHeuristics: CompiledEditHeuristics;
  fileOps: CompiledFileOperationRules;
}
