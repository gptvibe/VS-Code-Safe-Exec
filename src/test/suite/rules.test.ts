import * as assert from "assert/strict";
import * as vscode from "vscode";
import { loadEffectiveRules } from "../../rules";
import { activateExtension, getFixturePath, resetTestState, writeWorkspaceSettings } from "./helpers";

suite("rule loading", () => {
  teardown(async () => {
    const api = await activateExtension();
    await resetTestState(api);
  });

  test("merges defaults, workspace rules, and settings", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    await writeWorkspaceSettings({
      "safeExec.enabled": true,
      "safeExec.rulesPath": getFixturePath("..", "merge.rules.json"),
      "safeExec.policyBundles": ["git-ci"],
      "safeExec.protectedCommands": ["safeExec.fromSettings"],
      "safeExec.editHeuristics.minChangedCharacters": 7
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
    } finally {
      output.dispose();
    }
  });
});
