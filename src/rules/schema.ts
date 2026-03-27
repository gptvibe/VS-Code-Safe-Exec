import type { CommandPatternRule, EditHeuristics, FileOperationRules, ProtectedCommandRule } from "./types";

export type PartialRuleInput = Partial<{
  policyBundles: string[];
  dangerousCommands: Array<string | Partial<CommandPatternRule>>;
  allowedCommands: Array<string | Partial<CommandPatternRule>>;
  confirmationCommands: Array<string | Partial<CommandPatternRule>>;
  protectedCommands: Array<string | Partial<ProtectedCommandRule>>;
  editHeuristics: Partial<EditHeuristics>;
  fileOps: Partial<FileOperationRules>;
}>;
