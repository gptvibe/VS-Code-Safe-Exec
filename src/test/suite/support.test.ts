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
    assert.match(text, /## First-Run Diagnostic/);
    assert.match(text, /## Policy Bundles/);
    assert.match(text, /## Proxy And Wrapper Keybindings/);
    assert.match(text, /## Automation-Heavy Command Coverage/);

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  test("open hardening checklist command renders the layered setup guide", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    await vscode.commands.executeCommand("safeExec.openHardeningChecklist");
    await waitFor(() => (vscode.window.activeTextEditor?.document.getText() ?? "").includes("# Safe Exec Hardening Checklist"));

    const text = vscode.window.activeTextEditor?.document.getText() ?? "";
    assert.match(text, /# Safe Exec Hardening Checklist/);
    assert.match(text, /agent hooks/i);
    assert.match(text, /does not replace sandboxing/i);
    assert.match(text, /starter-templates\/devcontainer\/devcontainer\.json/);

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
    assert.match(text, /safeExec\.proxy\.notebook\.cell\.execute/);
    assert.match(text, /safeExec\.runProtectedCommand/);
    assert.doesNotMatch(text, /description/);

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("permission UI preview flow and deferred helpers stay deterministic", async () => {
    const output = vscode.window.createOutputChannel("Safe Exec PermissionUI Test");
    const responder = new ScriptedApprovalResponder();
    const permissionUI = new PermissionUI(output, responder);

    responder.enqueue("details");
    responder.enqueue("review");
    responder.enqueue("allow");
    assert.ok(permissionUI.compareRisk("critical", "high") > 0);

    const approved = await permissionUI.requestApproval({
      title: "Preview Test",
      source: "test",
      risk: "medium",
      summary: "echo safe-exec",
      explanation: "Safe Exec is testing the preview and explanation flow.",
      whyFlagged: ["Matched a scripted test rule."],
      preview: "echo safe-exec",
      previewLanguage: "shellscript"
    });

    assert.equal(approved.approved, true);
    assert.equal(approved.resolution, "allow");
    await waitFor(() => (vscode.window.activeTextEditor?.document.getText() ?? "").includes("## Preview"));
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? "", /echo safe-exec/);

    const reviewHandle = responder.enqueueDeferred();
    reviewHandle.review();
    assert.equal(await responder.requestDecision(), "review");

    const denyHandle = responder.enqueueDeferred();
    denyHandle.deny();
    assert.equal(await responder.requestDecision(), "deny");

    const detailsHandle = responder.enqueueDeferred();
    detailsHandle.details();
    assert.equal(await responder.requestDecision(), "details");

    output.dispose();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("permission UI stores medium-risk workspace exceptions and suppresses identical approved low-risk prompts", async () => {
    const output = vscode.window.createOutputChannel("Safe Exec PermissionUI Trust Test");
    const responder = new ScriptedApprovalResponder();
    const workspaceState = new InMemoryMemento();
    const permissionUI = new PermissionUI(output, responder, workspaceState);

    responder.enqueue("allow-workspace");
    const mediumFirst = await permissionUI.requestApproval({
      title: "Workspace Exception Test",
      source: "test",
      risk: "medium",
      summary: "safeExec.runProtectedCommand test.medium",
      explanation: "This medium-risk test action is eligible for an exact workspace exception.",
      whyFlagged: ["Matched a medium-risk scripted test rule."],
      actionKey: "command:test.medium:[]",
      workspaceTrustOption: {}
    });
    assert.equal(mediumFirst.approved, true);
    assert.equal(mediumFirst.resolution, "workspace-exception");
    assert.equal(permissionUI.getWorkspaceApprovalExceptionCount(), 1);

    const mediumSecond = await permissionUI.requestApproval({
      title: "Workspace Exception Test",
      source: "test",
      risk: "medium",
      summary: "safeExec.runProtectedCommand test.medium",
      actionKey: "command:test.medium:[]",
      workspaceTrustOption: {}
    });
    assert.equal(mediumSecond.approved, true);
    assert.equal(mediumSecond.resolution, "workspace-exception");

    responder.enqueue("allow");
    const lowFirst = await permissionUI.requestApproval({
      title: "Low Risk Test",
      source: "test",
      risk: "low",
      summary: "echo safe-exec-low",
      actionKey: "terminal:echo safe-exec-low",
      suppressRepeatedApprovedLowRisk: true
    });
    assert.equal(lowFirst.approved, true);
    assert.equal(lowFirst.resolution, "allow");

    const lowSecond = await permissionUI.requestApproval({
      title: "Low Risk Test",
      source: "test",
      risk: "low",
      summary: "echo safe-exec-low",
      actionKey: "terminal:echo safe-exec-low",
      suppressRepeatedApprovedLowRisk: true
    });
    assert.equal(lowSecond.approved, true);
    assert.equal(lowSecond.resolution, "low-risk-repeat");

    output.dispose();
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

class InMemoryMemento implements Pick<vscode.Memento, "get" | "update"> {
  private readonly state = new Map<string, unknown>();

  public get<T>(key: string, defaultValue?: T): T {
    return (this.state.has(key) ? (this.state.get(key) as T) : defaultValue) as T;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.state.set(key, value);
  }
}
