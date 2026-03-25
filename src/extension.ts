import * as path from "path";
import * as vscode from "vscode";
import { AuditEvent, AuditLog } from "./auditLog";
import { CommandInterceptor } from "./commandInterceptor";
import { DiffContentProvider } from "./diffContentProvider";
import { EditInterceptor } from "./editInterceptor";
import { inspectUserKeybindings, renderRecommendedKeybindingsJson } from "./keybindingInspector";
import { createOnboardingMarkdown } from "./onboarding";
import { ApprovalDecision, PermissionUI, ScriptedApprovalResponder } from "./permissionUI";
import {
  DEFAULT_RULES,
  POLICY_BUNDLES,
  SAMPLE_RULES_JSON,
  SafeExecRules,
  ensureRulesFileExists,
  getSettings,
  loadEffectiveRules,
  resolveRulesPath
} from "./rules";
import { TerminalInterceptor } from "./terminalInterceptor";

export interface SafeExecExtensionApi {
  queueApproval: (decision: ApprovalDecision) => void;
  getAuditEvents: (limit?: number) => AuditEvent[];
  resetTestState: () => Promise<void>;
  simulateTerminalCommand: (execution: Parameters<TerminalInterceptor["simulateExecutionForTesting"]>[0]) => Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<SafeExecExtensionApi> {
  const output = vscode.window.createOutputChannel("Safe Exec", { log: true });
  const scriptedResponder = context.extensionMode === vscode.ExtensionMode.Test ? new ScriptedApprovalResponder() : undefined;
  const permissionUI = new PermissionUI(output, scriptedResponder);
  const auditLog = new AuditLog(output, context.workspaceState);
  const diffContentProvider = new DiffContentProvider();
  let effectiveRules: SafeExecRules = DEFAULT_RULES;
  let rulesWatcher: vscode.Disposable | undefined;
  let latestKeybindingWarnings: string[] = [];
  let keybindingStatusLine = "Keybinding coverage not checked yet.";
  let lastWarnedKeybindingHash = context.workspaceState.get<string>("safeExec.keybindingWarningHash.v1");

  const statusBar = vscode.window.createStatusBarItem("safeExec.status", vscode.StatusBarAlignment.Left, 1000);
  statusBar.command = "safeExec.openOnboarding";
  statusBar.show();

  const isEnabled = (): boolean => getSettings().enabled;
  const getRules = (): SafeExecRules => effectiveRules;
  const getKillStrategy = () => getSettings().terminalKillStrategy;

  const updateStatusBar = (): void => {
    if (!isEnabled()) {
      statusBar.text = "$(shield) Safe Exec Off";
      statusBar.tooltip = [
        "Safe Exec protection is disabled.",
        workspaceTrustLine(),
        keybindingStatusLine
      ].join("\n");
      return;
    }

    if (latestKeybindingWarnings.length > 0) {
      statusBar.text = "$(warning) Safe Exec";
    } else if (!vscode.workspace.isTrusted) {
      statusBar.text = "$(shield) Safe Exec Untrusted";
    } else {
      statusBar.text = "$(shield) Safe Exec";
    }

    statusBar.tooltip = [
      "Safe Exec is a best-effort approval layer, not a sandbox.",
      workspaceTrustLine(),
      keybindingStatusLine
    ].join("\n");
  };

  const reloadRules = async (reason: string): Promise<void> => {
    try {
      effectiveRules = await loadEffectiveRules(output);
      output.appendLine(`[extension] Reloaded rules (${reason}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[extension] Failed to reload rules (${reason}): ${message}`);
      void vscode.window.showErrorMessage(`Safe Exec could not reload rules: ${message}`);
    }
  };

  const refreshKeybindingDiagnostics = async (showWarning = false): Promise<void> => {
    const inspection = await inspectUserKeybindings();
    latestKeybindingWarnings = inspection.warnings;
    keybindingStatusLine = inspection.error
      ? `Keybinding inspection: ${inspection.error}`
      : inspection.warnings.length > 0
      ? `${inspection.warnings.length} raw guarded keybinding(s) are missing a Safe Exec proxy equivalent.`
      : "No explicit raw guarded keybinding mismatches were found in user keybindings.json.";
    updateStatusBar();

    if (showWarning && inspection.warnings.length > 0) {
      const warningHash = inspection.warnings.join("|");
      if (warningHash !== lastWarnedKeybindingHash) {
        lastWarnedKeybindingHash = warningHash;
        void context.workspaceState.update("safeExec.keybindingWarningHash.v1", warningHash);
        void vscode.window
          .showWarningMessage(
            "Safe Exec found guarded commands bound directly in keybindings.json without matching proxy bindings.",
            "Open Onboarding",
            "Review Keybindings"
          )
          .then((selection) => {
            if (selection === "Open Onboarding") {
              void vscode.commands.executeCommand("safeExec.openOnboarding");
            }

            if (selection === "Review Keybindings") {
              void vscode.commands.executeCommand("safeExec.installRecommendedKeybindings");
            }
          });
      }
    }
  };

  const openMarkdownDocument = async (content: string): Promise<void> => {
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content
    });
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside
    });
    document.isClosed;
  };

  const openOnboarding = async (): Promise<void> => {
    const inspection = await inspectUserKeybindings();
    latestKeybindingWarnings = inspection.warnings;
    keybindingStatusLine = inspection.error
      ? `Keybinding inspection: ${inspection.error}`
      : inspection.warnings.length > 0
      ? `${inspection.warnings.length} raw guarded keybinding(s) are missing a Safe Exec proxy equivalent.`
      : "No explicit raw guarded keybinding mismatches were found in user keybindings.json.";
    updateStatusBar();

    const content = createOnboardingMarkdown({
      isEnabled: isEnabled(),
      isTrustedWorkspace: vscode.workspace.isTrusted,
      keybindingInspection: inspection
    });
    await openMarkdownDocument(content);
  };

  const openRecommendedKeybindings = async (): Promise<void> => {
    const document = await vscode.workspace.openTextDocument({
      language: "jsonc",
      content: renderRecommendedKeybindingsJson()
    });

    await vscode.commands.executeCommand("workbench.action.openGlobalKeybindingsFile");
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside
    });
    void vscode.window.showInformationMessage(
      "Safe Exec opened your keybindings.json alongside a recommended proxy snippet. Merge the entries you want manually; Safe Exec does not edit keybindings automatically."
    );
  };

  const refreshRulesWatcher = (): void => {
    rulesWatcher?.dispose();
    const uri = resolveRulesPath(getSettings());
    if (!uri) {
      output.appendLine("[extension] No workspace rules path could be resolved.");
      return;
    }

    const pattern = new vscode.RelativePattern(path.dirname(uri.fsPath), path.basename(uri.fsPath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(() => void reloadRules("rules file changed"));
    watcher.onDidCreate(() => void reloadRules("rules file created"));
    watcher.onDidDelete(() => void reloadRules("rules file deleted"));
    rulesWatcher = watcher;
  };

  await reloadRules("activation");
  refreshRulesWatcher();
  await refreshKeybindingDiagnostics(context.extensionMode !== vscode.ExtensionMode.Test);
  updateStatusBar();

  const commandInterceptor = new CommandInterceptor({
    output,
    permissionUI,
    auditLog,
    getRules,
    isEnabled
  });
  const terminalInterceptor = new TerminalInterceptor({
    output,
    permissionUI,
    auditLog,
    getRules,
    isEnabled,
    getKillStrategy
  });
  const editInterceptor = new EditInterceptor({
    output,
    permissionUI,
    auditLog,
    diffContentProvider,
    getRules,
    isEnabled
  });

  context.subscriptions.push(
    output,
    diffContentProvider,
    diffContentProvider.register(),
    statusBar,
    new vscode.Disposable(() => rulesWatcher?.dispose()),
    commandInterceptor.register(),
    terminalInterceptor.register(),
    editInterceptor.register(),
    vscode.commands.registerCommand("safeExec.toggleProtection", async () => {
      const settings = getSettings();
      const nextValue = !settings.enabled;
      await vscode.workspace
        .getConfiguration("safeExec")
        .update(
          "enabled",
          nextValue,
          vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        );
      output.appendLine(`[extension] Protection ${nextValue ? "enabled" : "disabled"} by user.`);
      auditLog.record({
        action: "status",
        surface: "workspace",
        source: "safeExec.toggleProtection",
        summary: `Protection ${nextValue ? "enabled" : "disabled"}`
      });
      updateStatusBar();
      void vscode.window.showInformationMessage(`Safe Exec protection ${nextValue ? "enabled" : "disabled"}.`);
    }),
    vscode.commands.registerCommand("safeExec.openRulesFile", async () => {
      const uri = await ensureRulesFileExists(getSettings());
      if (!uri) {
        void vscode.window.showWarningMessage(
          "Safe Exec could not resolve a rules file path. Open a workspace folder or use an absolute safeExec.rulesPath."
        );
        return;
      }

      try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[extension] Failed to open rules file: ${message}`);
        void vscode.window.showErrorMessage(`Safe Exec could not open the rules file: ${message}`);
      }
    }),
    vscode.commands.registerCommand("safeExec.showEffectiveRules", async () => {
      const document = await vscode.workspace.openTextDocument({
        language: "json",
        content: `${JSON.stringify(getRules(), null, 2)}\n`
      });
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    }),
    vscode.commands.registerCommand("safeExec.openOnboarding", async () => {
      await openOnboarding();
    }),
    vscode.commands.registerCommand("safeExec.installRecommendedKeybindings", async () => {
      await openRecommendedKeybindings();
    }),
    vscode.commands.registerCommand("safeExec.showAuditHistory", async () => {
      await openMarkdownDocument(auditLog.renderMarkdown());
    }),
    vscode.commands.registerCommand("safeExec.reloadRules", async () => {
      await reloadRules("manual command");
      void vscode.window.showInformationMessage("Safe Exec rules reloaded.");
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("safeExec")) {
        return;
      }

      void reloadRules("configuration changed");
      void refreshKeybindingDiagnostics();
      updateStatusBar();
      refreshRulesWatcher();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      auditLog.record({
        action: "status",
        surface: "workspace",
        source: "workspaceTrust",
        summary: "Workspace trust granted",
        detail: "Workspace Trust is not a sandbox and does not replace Safe Exec approval."
      });
      updateStatusBar();
      void vscode.window.showInformationMessage(
        "This workspace is now trusted. Workspace Trust may enable more features, but it is not a sandbox and does not replace Safe Exec approval."
      );
    })
  );

  await maybeShowFirstRunOnboarding(context, openOnboarding);
  if (!vscode.workspace.isTrusted) {
    auditLog.record({
      action: "status",
      surface: "workspace",
      source: "workspaceTrust",
      summary: "Workspace is untrusted",
      detail: "Workspace Trust can reduce some VS Code capabilities, but it is not a sandbox."
    });
  }

  output.appendLine("[extension] Safe Exec activated.");
  output.appendLine(`[extension] Sample rules template size: ${SAMPLE_RULES_JSON.length} bytes.`);
  output.appendLine(`[extension] Available policy bundles: ${Object.keys(POLICY_BUNDLES).join(", ")}`);

  return {
    queueApproval: (decision: ApprovalDecision) => {
      scriptedResponder?.enqueue(decision);
    },
    getAuditEvents: (limit = 50) => auditLog.getRecentEvents(limit),
    resetTestState: async () => {
      scriptedResponder?.reset();
      await auditLog.clear();
    },
    simulateTerminalCommand: async (execution) => {
      await terminalInterceptor.simulateExecutionForTesting(execution);
    }
  };
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions automatically.
}

async function maybeShowFirstRunOnboarding(
  context: vscode.ExtensionContext,
  openOnboarding: () => Promise<void>
): Promise<void> {
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return;
  }

  const key = "safeExec.onboardingShown.v1";
  if (context.globalState.get<boolean>(key)) {
    return;
  }

  await context.globalState.update(key, true);
  const selection = await vscode.window.showInformationMessage(
    "Safe Exec is active. It is a best-effort approval layer, not a sandbox.",
    "Open Onboarding",
    "Later"
  );

  if (selection === "Open Onboarding") {
    await openOnboarding();
  }
}

function workspaceTrustLine(): string {
  return vscode.workspace.isTrusted
    ? "Workspace Trust: trusted. This helps VS Code decide what workspace features to enable, but it is not a sandbox."
    : "Workspace Trust: untrusted. This can reduce some automatic workspace behavior, but it is not a sandbox.";
}
