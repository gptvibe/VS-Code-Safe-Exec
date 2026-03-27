import * as assert from "assert/strict";
import * as vscode from "vscode";
import {
  compileRules,
  findFirstMatchingCommandRule,
  findMatchingProtectedCommandRule,
  loadEffectiveRules,
  matchesAnyCompiledRegexPattern
} from "../../rules";
import type { EditHeuristics, FileOperationRules } from "../../rules";
import type { SafeExecRules } from "../../rules";
import { activateExtension, getFixturePath, resetTestState, writeWorkspaceSettings } from "./helpers";

suite("rule loading", () => {
  test("merges defaults, workspace rules, and settings", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    await writeWorkspaceSettings({
      "safeExec.enabled": true,
      "safeExec.rulesPath": getFixturePath("..", "merge.rules.json"),
      "safeExec.policyBundles": ["git-ci"],
      "safeExec.protectedCommands": ["safeExec.fromSettings"],
      "safeExec.editHeuristics.minChangedCharacters": 7,
      "safeExec.fileOps.maxSnapshotBytes": 4096,
      "safeExec.fileOps.captureBinarySnapshots": false,
      "safeExec.fileOps.protectedPathPatterns": ["SETTINGS_FILE_OP_PROTECTED_PATH"],
      "safeExec.fileOps.sensitiveFileNames": ["settings-secret.txt"]
    }, {
      mergeWithDefaults: false
    });
    await vscode.commands.executeCommand("safeExec.reloadRules");

    const output = vscode.window.createOutputChannel("Safe Exec Test Rules");
    try {
      const rules = await loadEffectiveRules(output);

      assert.ok(rules.dangerousCommands.some((rule) => rule.pattern === "\\brm\\s+-rf\\b"));
      assert.ok(rules.dangerousCommands.some((rule) => rule.pattern === "TEST_RULE_DESTROY"));
      assert.ok(rules.confirmationCommands.some((rule) => rule.pattern.includes("gh\\s+workflow\\s+run")));
      assert.ok(rules.confirmationCommands.some((rule) => rule.pattern.includes("uv\\s+(?:pip|sync|lock)")));
      assert.ok(rules.protectedCommands.some((rule) => rule.command === "safeExec.fileProtected"));
      assert.ok(rules.protectedCommands.some((rule) => rule.command === "safeExec.fromSettings"));
      assert.equal(rules.editHeuristics.minChangedCharacters, 7);
      assert.equal(rules.editHeuristics.minAffectedLines, 5);
      assert.ok(rules.editHeuristics.protectedPathPatterns.includes("CUSTOM_PROTECTED_PATH"));
      assert.ok(rules.editHeuristics.protectedPathPatterns.some((pattern) => pattern.includes("requirements")));
      assert.equal(rules.fileOps.maxFilesPerOperation, 7);
      assert.equal(rules.fileOps.maxSnapshotBytes, 4096);
      assert.equal(rules.fileOps.captureBinarySnapshots, false);
      assert.ok(rules.fileOps.protectedPathPatterns.includes("CUSTOM_FILE_OP_PROTECTED_PATH"));
      assert.ok(rules.fileOps.protectedPathPatterns.includes("SETTINGS_FILE_OP_PROTECTED_PATH"));
      assert.ok(rules.fileOps.protectedPathPatterns.some((pattern) => pattern.includes("azure-pipelines")));
      assert.ok(rules.fileOps.sensitiveExtensions.includes(".fixture-secret"));
      assert.ok(rules.fileOps.sensitiveFileNames.includes("settings-secret.txt"));
    } finally {
      output.dispose();
    }
  });

  test("compiled matchers ignore invalid regex patterns and keep matching valid rules", () => {
    const compiled = compileRules(createTestRules({
      dangerousCommands: [
        { pattern: "(", description: "Broken dangerous rule", risk: "critical" },
        { pattern: "SAFE_EXEC_VALID_DANGER", description: "Valid dangerous rule", risk: "high" }
      ],
      protectedCommands: [
        { command: "/(/", description: "Broken protected command", risk: "medium" },
        { command: "safeExec.validProtected", description: "Valid protected command", risk: "medium" }
      ],
      editHeuristics: {
        protectedPathPatterns: ["(", "sample\\.ts$"],
        ignoredPathPatterns: ["(", "node_modules[\\\\/]"]
      },
      fileOps: {
        protectedPathPatterns: ["(", "package\\.json$"],
        ignoredPathPatterns: ["(", "\\.git[\\\\/]"]
      }
    }));
    const invalidCommandPatterns: string[] = [];
    const invalidProtectedPatterns: string[] = [];

    const dangerousRule = findFirstMatchingCommandRule(
      "echo SAFE_EXEC_VALID_DANGER",
      compiled.dangerousCommands,
      (pattern, error) => invalidCommandPatterns.push(`${pattern}: ${error}`)
    );
    const protectedRule = findMatchingProtectedCommandRule(
      "safeExec.validProtected",
      compiled.protectedCommands,
      (pattern, error) => invalidProtectedPatterns.push(`${pattern}: ${error}`)
    );

    assert.equal(dangerousRule?.pattern, "SAFE_EXEC_VALID_DANGER");
    assert.equal(protectedRule?.command, "safeExec.validProtected");
    assert.equal(matchesAnyCompiledRegexPattern(compiled.editHeuristics.protectedPathMatchers, "C:\\repo\\sample.ts"), true);
    assert.equal(
      matchesAnyCompiledRegexPattern(compiled.editHeuristics.ignoredPathMatchers, "C:\\repo\\node_modules\\pkg\\index.js"),
      true
    );
    assert.equal(matchesAnyCompiledRegexPattern(compiled.fileOps.protectedPathMatchers, "C:\\repo\\package.json"), true);
    assert.equal(matchesAnyCompiledRegexPattern(compiled.fileOps.ignoredPathMatchers, "C:\\repo\\.git\\config"), true);
    assert.ok(invalidCommandPatterns.some((entry) => entry.startsWith("(: ")));
    assert.ok(invalidProtectedPatterns.some((entry) => entry.startsWith("/(/: ")));
  });

  test("compiled matchers reuse precompiled regexes across repeated matches", () => {
    const originalRegExp = RegExp;
    let constructionCount = 0;

    class CountingRegExp extends originalRegExp {
      public constructor(pattern: string | RegExp, flags?: string) {
        super(pattern, flags);
        constructionCount += 1;
      }
    }

    const globalObject = globalThis as typeof globalThis & { RegExp: RegExpConstructor };
    globalObject.RegExp = CountingRegExp as unknown as RegExpConstructor;

    try {
      const compiled = compileRules(createTestRules({
        dangerousCommands: [{ pattern: "SAFE_EXEC_PERF_COMMAND", risk: "critical" }],
        protectedCommands: [{ command: "/^safeExec\\.perf$/", risk: "medium" }],
        editHeuristics: {
          protectedPathPatterns: ["perf\\.ts$"],
          ignoredPathPatterns: ["node_modules[\\\\/]"]
        },
        fileOps: {
          protectedPathPatterns: ["package\\.json$"],
          ignoredPathPatterns: ["\\.git[\\\\/]"]
        }
      }));
      const compiledConstructionCount = constructionCount;

      assert.ok(compiledConstructionCount > 0);

      for (let index = 0; index < 100; index += 1) {
        assert.equal(findFirstMatchingCommandRule("echo SAFE_EXEC_PERF_COMMAND", compiled.dangerousCommands)?.pattern, "SAFE_EXEC_PERF_COMMAND");
        assert.equal(findMatchingProtectedCommandRule("safeExec.perf", compiled.protectedCommands)?.command, "/^safeExec\\.perf$/");
        assert.equal(matchesAnyCompiledRegexPattern(compiled.editHeuristics.protectedPathMatchers, "C:\\repo\\perf.ts"), true);
        assert.equal(
          matchesAnyCompiledRegexPattern(compiled.editHeuristics.ignoredPathMatchers, "C:\\repo\\node_modules\\pkg\\index.js"),
          true
        );
        assert.equal(matchesAnyCompiledRegexPattern(compiled.fileOps.protectedPathMatchers, "C:\\repo\\package.json"), true);
        assert.equal(matchesAnyCompiledRegexPattern(compiled.fileOps.ignoredPathMatchers, "C:\\repo\\.git\\config"), true);
      }

      assert.equal(constructionCount, compiledConstructionCount);
    } finally {
      globalObject.RegExp = originalRegExp;
    }
  });
});

interface TestRuleOverrides {
  dangerousCommands?: SafeExecRules["dangerousCommands"];
  allowedCommands?: SafeExecRules["allowedCommands"];
  confirmationCommands?: SafeExecRules["confirmationCommands"];
  protectedCommands?: SafeExecRules["protectedCommands"];
  editHeuristics?: Partial<EditHeuristics>;
  fileOps?: Partial<FileOperationRules>;
}

function createTestRules(overrides: TestRuleOverrides = {}): SafeExecRules {
  return {
    dangerousCommands: overrides.dangerousCommands ?? [],
    allowedCommands: overrides.allowedCommands ?? [],
    confirmationCommands: overrides.confirmationCommands ?? [],
    protectedCommands: overrides.protectedCommands ?? [],
    editHeuristics: {
      minChangedCharacters: 5,
      minAffectedLines: 1,
      maxPreviewCharacters: 200,
      multipleChangeCount: 3,
      protectedPathPatterns: overrides.editHeuristics?.protectedPathPatterns ?? [],
      ignoredPathPatterns: overrides.editHeuristics?.ignoredPathPatterns ?? []
    },
    fileOps: {
      enabled: overrides.fileOps?.enabled ?? true,
      maxSnapshotBytes: overrides.fileOps?.maxSnapshotBytes ?? 4096,
      maxFilesPerOperation: overrides.fileOps?.maxFilesPerOperation ?? 10,
      minBulkOperationCount: overrides.fileOps?.minBulkOperationCount ?? 3,
      protectedPathPatterns: overrides.fileOps?.protectedPathPatterns ?? [],
      ignoredPathPatterns: overrides.fileOps?.ignoredPathPatterns ?? [],
      sensitiveExtensions: overrides.fileOps?.sensitiveExtensions ?? [],
      sensitiveFileNames: overrides.fileOps?.sensitiveFileNames ?? [],
      captureBinarySnapshots: overrides.fileOps?.captureBinarySnapshots ?? true
    }
  };
}
