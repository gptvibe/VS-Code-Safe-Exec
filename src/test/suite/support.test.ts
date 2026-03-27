import * as assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PermissionUI, ScriptedApprovalResponder } from "../../permissionUI";
import { ensureRulesFileExists, matchesAnyRegexPattern } from "../../rules";
import type { SafeExecSettings } from "../../rules";
import { activateExtension, resetTestState, waitFor } from "./helpers";

suite("support utilities", () => {
  test("open onboarding command renders the markdown guide", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    await vscode.commands.executeCommand("safeExec.openOnboarding");
    await waitFor(() => (vscode.window.activeTextEditor?.document.getText() ?? "").includes("# Safe Exec Onboarding"));

    const text = vscode.window.activeTextEditor?.document.getText() ?? "";
    assert.match(text, /# Safe Exec Onboarding/);
    assert.match(text, /## Policy Bundles/);
    assert.match(text, /## Proxy Keybindings/);

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  test("open recommended keybindings command renders proxy bindings json", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    await vscode.commands.executeCommand("safeExec.installRecommendedKeybindings");
    await waitFor(() => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return false;
      }

      return editor.document.languageId === "jsonc" && editor.document.getText().includes("safeExec.proxy");
    });

    const text = vscode.window.activeTextEditor?.document.getText() ?? "";
    assert.match(text, /safeExec\.proxy\.workbench\.action\.terminal\.runSelectedText/);
    assert.doesNotMatch(text, /description/);

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("permission UI preview flow and deferred helpers stay deterministic", async () => {
    const output = vscode.window.createOutputChannel("Safe Exec PermissionUI Test");
    const responder = new ScriptedApprovalResponder();
    const permissionUI = new PermissionUI(output, responder);

    responder.enqueue("review");
    responder.enqueue("allow");
    assert.ok(permissionUI.compareRisk("critical", "high") > 0);

    const approved = await permissionUI.requestApproval({
      title: "Preview Test",
      source: "test",
      risk: "medium",
      summary: "echo safe-exec",
      preview: "echo safe-exec",
      previewLanguage: "shellscript"
    });

    assert.equal(approved, true);
    await waitFor(() => (vscode.window.activeTextEditor?.document.getText() ?? "").includes("```shellscript"));
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? "", /echo safe-exec/);

    const reviewHandle = responder.enqueueDeferred();
    reviewHandle.review();
    assert.equal(await responder.requestDecision(), "review");

    const denyHandle = responder.enqueueDeferred();
    denyHandle.deny();
    assert.equal(await responder.requestDecision(), "deny");

    output.dispose();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("ensureRulesFileExists creates a sample rules file for an absolute path", async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "safe-exec-rules-"));
    const rulesPath = path.join(tempDirectory, "custom.rules.json");
    const settings: SafeExecSettings = {
      enabled: true,
      rulesPath,
      policyBundles: [],
      protectedCommands: [],
      terminalKillStrategy: "interruptThenDispose",
      terminalCriticalReplayPolicy: "bestEffort",
      editHeuristics: {},
      fileOps: {}
    };

    try {
      const uri = await ensureRulesFileExists(settings);
      assert.equal(uri?.fsPath.toLowerCase(), rulesPath.toLowerCase());
      const content = await fs.readFile(rulesPath, "utf8");
      assert.match(content, /"dangerousCommands"/);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("matchesAnyRegexPattern ignores invalid regex entries and still matches valid ones", () => {
    assert.equal(matchesAnyRegexPattern(["(", "^safe-exec$"], "safe-exec"), true);
    assert.equal(matchesAnyRegexPattern(["("], "safe-exec"), false);
  });
});
