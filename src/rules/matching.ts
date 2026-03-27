import type {
  CommandPatternRule,
  CompiledCommandPatternRule,
  CompiledProtectedCommandRule,
  CompiledRegexPattern,
  ProtectedCommandRule
} from "./types";

export type InvalidMatcherReporter = (pattern: string, error: string) => void;

export function matchesAnyRegexPattern(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return false;
    }
  });
}

export function matchesAnyCompiledRegexPattern(
  matchers: readonly CompiledRegexPattern[],
  value: string,
  reportInvalid?: InvalidMatcherReporter
): boolean {
  return matchers.some((matcher) => matchesCompiledRegexPattern(matcher, value, reportInvalid));
}

export function findFirstMatchingCommandRule(
  value: string,
  rules: readonly CompiledCommandPatternRule[],
  reportInvalid?: InvalidMatcherReporter
): CommandPatternRule | undefined {
  for (const compiledRule of rules) {
    if (matchesCompiledRegexPattern(compiledRule.matcher, value, reportInvalid)) {
      return compiledRule.rule;
    }
  }

  return undefined;
}

export function findMatchingProtectedCommandRule(
  targetCommand: string,
  rules: readonly CompiledProtectedCommandRule[],
  reportInvalid?: InvalidMatcherReporter
): ProtectedCommandRule | undefined {
  for (const compiledRule of rules) {
    switch (compiledRule.matcher.kind) {
      case "empty":
        continue;
      case "exact":
        if (compiledRule.matcher.value === targetCommand) {
          return compiledRule.rule;
        }
        continue;
      case "regex":
        if (!compiledRule.matcher.regex) {
          if (compiledRule.matcher.error) {
            reportInvalid?.(compiledRule.matcher.pattern, compiledRule.matcher.error);
          }
          continue;
        }

        if (compiledRule.matcher.regex.test(targetCommand)) {
          return compiledRule.rule;
        }
        continue;
    }
  }

  return undefined;
}

function matchesCompiledRegexPattern(
  matcher: CompiledRegexPattern,
  value: string,
  reportInvalid?: InvalidMatcherReporter
): boolean {
  if (!matcher.regex) {
    if (matcher.error) {
      reportInvalid?.(matcher.pattern, matcher.error);
    }
    return false;
  }

  return matcher.regex.test(value);
}
