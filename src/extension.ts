import * as path from "path";
import * as vscode from "vscode";
import { CommandInterceptor } from "./commandInterceptor";
import { EditInterceptor } from "./editInterceptor";
import { PermissionUI } from "./permissionUI";
import {
  DEFAULT_RULES,
  SAMPLE_RULES_JSON,
  SafeExecRules,
  ensureRulesFileExists,
  getSettings,
  loadEffectiveRules,
  resolveRulesPath
} from "./rules";
import { TerminalInterceptor } from "./terminalInterceptor";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Safe Exec");
  const permissionUI = new PermissionUI(output);
  let effectiveRules: SafeExecRules = DEFAULT_RULES;
  let rulesWatcher: vscode.Disposable | undefined;

  const isEnabled = (): boolean => getSettings().enabled;
  const getRules = (): SafeExecRules => effectiveRules;
  const getKillStrategy = () => getSettings().terminalKillStrategy;

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

  const commandInterceptor = new CommandInterceptor({
    output,
    permissionUI,
    getRules,
    isEnabled
  });
  const terminalInterceptor = new TerminalInterceptor({
    output,
    permissionUI,
    getRules,
    isEnabled,
    getKillStrategy
  });
  const editInterceptor = new EditInterceptor({
    output,
    permissionUI,
    getRules,
    isEnabled
  });

  context.subscriptions.push(
    output,
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
    vscode.commands.registerCommand("safeExec.reloadRules", async () => {
      await reloadRules("manual command");
      void vscode.window.showInformationMessage("Safe Exec rules reloaded.");
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("safeExec")) {
        return;
      }

      void reloadRules("configuration changed");
      refreshRulesWatcher();
    })
  );

  output.appendLine("[extension] Safe Exec activated.");
  output.appendLine(`[extension] Sample rules template size: ${SAMPLE_RULES_JSON.length} bytes.`);
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions automatically.
}
