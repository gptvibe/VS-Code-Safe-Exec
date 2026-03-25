import * as assert from "assert/strict";
import * as vscode from "vscode";
import { loadEffectiveRules } from "../../rules";
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
});
