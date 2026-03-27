import type * as vscode from "vscode";
import { DEFAULT_RULES } from "./defaults";
import { loadEffectiveRules } from "./loading";
import type {
  CommandPatternRule,
  CompiledCommandPatternRule,
  CompiledProtectedCommandRule,
  CompiledRegexPattern,
  CompiledRules,
  ProtectedCommandRule,
  SafeExecRules
} from "./types";

const PROTECTED_COMMAND_REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/i;

export function compileRules(rules: SafeExecRules): CompiledRules {
  return {
    raw: rules,
    dangerousCommands: compileCommandPatternRules(rules.dangerousCommands),
    allowedCommands: compileCommandPatternRules(rules.allowedCommands),
    confirmationCommands: compileCommandPatternRules(rules.confirmationCommands),
    protectedCommands: compileProtectedCommandRules(rules.protectedCommands),
    editHeuristics: {
      ...rules.editHeuristics,
      protectedPathMatchers: compileRegexPatternList(rules.editHeuristics.protectedPathPatterns),
      ignoredPathMatchers: compileRegexPatternList(rules.editHeuristics.ignoredPathPatterns)
    },
    fileOps: {
      ...rules.fileOps,
      protectedPathMatchers: compileRegexPatternList(rules.fileOps.protectedPathPatterns),
      ignoredPathMatchers: compileRegexPatternList(rules.fileOps.ignoredPathPatterns)
    }
  };
}

export async function loadCompiledRules(output: vscode.OutputChannel): Promise<CompiledRules> {
  const raw = await loadEffectiveRules(output);
  return compileRules(raw);
}

export const DEFAULT_COMPILED_RULES: CompiledRules = compileRules(DEFAULT_RULES);

function compileCommandPatternRules(rules: readonly CommandPatternRule[]): CompiledCommandPatternRule[] {
  return rules.map((rule) => ({
    rule,
    matcher: compileRegexPattern(rule.pattern)
  }));
}

function compileProtectedCommandRules(rules: readonly ProtectedCommandRule[]): CompiledProtectedCommandRule[] {
  return rules.map((rule) => {
    const trimmedCommand = rule.command.trim();
    if (!trimmedCommand) {
      return {
        rule,
        matcher: { kind: "empty" as const }
      };
    }

    const regexMatch = PROTECTED_COMMAND_REGEX_LITERAL.exec(trimmedCommand);
    if (!regexMatch) {
      return {
        rule,
        matcher: {
          kind: "exact" as const,
          value: trimmedCommand
        }
      };
    }

    try {
      return {
        rule,
        matcher: {
          kind: "regex" as const,
          pattern: trimmedCommand,
          regex: new RegExp(regexMatch[1], regexMatch[2])
        }
      };
    } catch (error) {
      return {
        rule,
        matcher: {
          kind: "regex" as const,
          pattern: trimmedCommand,
          error: getErrorMessage(error)
        }
      };
    }
  });
}

function compileRegexPatternList(patterns: readonly string[]): CompiledRegexPattern[] {
  return patterns.map((pattern) => compileRegexPattern(pattern));
}

function compileRegexPattern(pattern: string): CompiledRegexPattern {
  try {
    return {
      pattern,
      regex: new RegExp(pattern, "i")
    };
  } catch (error) {
    return {
      pattern,
      error: getErrorMessage(error)
    };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
