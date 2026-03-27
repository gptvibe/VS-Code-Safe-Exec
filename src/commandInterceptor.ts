import * as vscode from "vscode";
import type { AuditLog } from "./auditLog";
import type { PermissionUI } from "./permissionUI";
import {
  EXPLICIT_PROXY_COMMAND_DEFINITIONS,
  findProtectedCommandDefinition,
  type ExplicitProxyCommandDefinition
} from "./protectedCommandCatalog";
import { findMatchingProtectedCommandRule } from "./rules";
import type { CompiledRules, ProtectedCommandRule, RiskLevel } from "./rules";

export interface CommandInterceptorOptions {
  output: vscode.OutputChannel;
  permissionUI: PermissionUI;
  auditLog: AuditLog;
  getRules: () => CompiledRules;
  isEnabled: () => boolean;
}

interface ProxyDefinition {
  proxyCommand: string;
  targetCommand: string;
  defaultRisk: RiskLevel;
  reason: string;
}

export class CommandInterceptor {
  private readonly executingTargets = new Set<string>();

  public constructor(private readonly options: CommandInterceptorOptions) {}

  public register(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    for (const proxy of EXPLICIT_PROXY_COMMAND_DEFINITIONS) {
      disposables.push(
        vscode.commands.registerCommand(proxy.proxyCommand, async (...args: unknown[]) =>
          this.runProtectedCommand(proxy.targetCommand, args, this.toProxyDefinition(proxy))
        )
      );
    }

    disposables.push(
      vscode.commands.registerCommand("safeExec.runProtectedCommand", async (...args: unknown[]) => {
        const { targetCommand, targetArgs } = this.parseWrapperArguments(args);
        const commandDefinition = findProtectedCommandDefinition(targetCommand);
        return this.runProtectedCommand(targetCommand, targetArgs, {
          proxyCommand: "safeExec.runProtectedCommand",
          targetCommand,
          defaultRisk: commandDefinition?.defaultRisk ?? "medium",
          reason: commandDefinition?.reason ?? "This command was explicitly wrapped by Safe Exec."
        });
      })
    );

    this.log("Registered protected command proxies.");
    return vscode.Disposable.from(...disposables);
  }

  private async runProtectedCommand(
    targetCommand: string,
    targetArgs: readonly unknown[],
    proxy: ProxyDefinition
  ): Promise<unknown> {
    if (!targetCommand.trim()) {
      throw new Error("Safe Exec requires a non-empty target command ID.");
    }

    if (targetCommand.startsWith("safeExec.")) {
      const message = `Refusing to proxy "${targetCommand}" to avoid Safe Exec recursion.`;
      this.log(message);
      void vscode.window.showWarningMessage(message);
      return undefined;
    }

    if (this.executingTargets.has(targetCommand)) {
      const message = `Blocked recursive protected command execution for "${targetCommand}".`;
      this.log(message);
      void vscode.window.showWarningMessage(message);
      return undefined;
    }

    const availableCommands = await vscode.commands.getCommands(true);
    if (!availableCommands.includes(targetCommand)) {
      const message = `The command "${targetCommand}" is not available in this VS Code session.`;
      this.log(message);
      void vscode.window.showWarningMessage(message, { modal: true });
      return undefined;
    }

    if (!this.options.isEnabled()) {
      this.log(`Protection disabled; running "${targetCommand}" without approval.`);
      return this.executeCommand(targetCommand, targetArgs);
    }

    const matchedRule = this.findProtectedCommandRule(targetCommand);
    const approved = await this.options.permissionUI.requestApproval({
      title: "Allow protected VS Code command?",
      source: proxy.proxyCommand,
      risk: matchedRule?.risk ?? proxy.defaultRisk,
      summary: `Run "${targetCommand}" through Safe Exec?`,
      detail: [
        `Target command: ${targetCommand}`,
        `Reason: ${matchedRule?.description ?? proxy.reason}`,
        "Safe Exec cannot transparently override built-in commands, so this protection works through explicit proxy and wrapper commands."
      ].join("\n"),
      preview: JSON.stringify(
        {
          command: targetCommand,
          args: targetArgs
        },
        null,
        2
      ),
      previewLanguage: "json",
      allowLabel: "Run Command",
      denyLabel: "Deny"
    });

    if (!approved) {
      this.log(`Denied protected command "${targetCommand}".`);
      this.options.auditLog.record({
        action: "denied",
        surface: "command",
        source: proxy.proxyCommand,
        summary: `Denied "${targetCommand}"`,
        risk: matchedRule?.risk ?? proxy.defaultRisk
      });
      return undefined;
    }

    this.options.auditLog.record({
      action: "approved",
      surface: "command",
      source: proxy.proxyCommand,
      summary: `Approved "${targetCommand}"`,
      risk: matchedRule?.risk ?? proxy.defaultRisk
    });

    return this.executeCommand(targetCommand, targetArgs);
  }

  private async executeCommand(targetCommand: string, targetArgs: readonly unknown[]): Promise<unknown> {
    this.executingTargets.add(targetCommand);

    try {
      this.log(`Executing "${targetCommand}" with ${targetArgs.length} argument(s).`);
      return await vscode.commands.executeCommand(targetCommand, ...targetArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Execution failed for "${targetCommand}": ${message}`);
      this.options.auditLog.record({
        action: "failed",
        surface: "command",
        source: targetCommand,
        summary: `Failed to execute "${targetCommand}"`,
        detail: message
      });
      void vscode.window.showErrorMessage(`Safe Exec failed to execute "${targetCommand}": ${message}`);
      throw error;
    } finally {
      this.executingTargets.delete(targetCommand);
    }
  }

  private parseWrapperArguments(args: readonly unknown[]): { targetCommand: string; targetArgs: unknown[] } {
    const [targetCommand, ...rest] = args;

    if (typeof targetCommand !== "string" || targetCommand.trim().length === 0) {
      throw new Error("safeExec.runProtectedCommand expects a target command ID string as its first argument.");
    }

    if (rest.length === 1 && Array.isArray(rest[0])) {
      return {
        targetCommand,
        targetArgs: [...rest[0]]
      };
    }

    return {
      targetCommand,
      targetArgs: [...rest]
    };
  }

  private findProtectedCommandRule(targetCommand: string): ProtectedCommandRule | undefined {
    return findMatchingProtectedCommandRule(targetCommand, this.options.getRules().protectedCommands, (pattern, error) => {
      this.log(`Ignoring invalid protected command pattern "${pattern}": ${error}`);
    });
  }

  private toProxyDefinition(definition: ExplicitProxyCommandDefinition): ProxyDefinition {
    return {
      proxyCommand: definition.proxyCommand,
      targetCommand: definition.targetCommand,
      defaultRisk: definition.defaultRisk,
      reason: definition.reason
    };
  }

  private log(message: string): void {
    this.options.output.appendLine(`[command] ${message}`);
  }
}
