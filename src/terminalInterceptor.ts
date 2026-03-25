import * as vscode from "vscode";
import { AuditLog } from "./auditLog";
import { PermissionUI } from "./permissionUI";
import { CommandPatternRule, SafeExecRules } from "./rules";

type MatchBucket = "dangerousCommands" | "confirmationCommands";

interface TerminalInterceptorOptions {
  output: vscode.OutputChannel;
  permissionUI: PermissionUI;
  auditLog: AuditLog;
  getRules: () => SafeExecRules;
  isEnabled: () => boolean;
  getKillStrategy: () => "interruptThenDispose" | "dispose";
}

interface MatchedCommand {
  bucket: MatchBucket;
  rule: CommandPatternRule;
  normalizedCommand: string;
}

interface InterceptedExecutionContext {
  terminal: vscode.Terminal;
  commandLine: vscode.TerminalShellExecutionCommandLine;
  cwd?: vscode.Uri;
}

interface ReplayContext {
  terminal: vscode.Terminal;
  commandLine: vscode.TerminalShellExecutionCommandLine;
  cwd?: vscode.Uri;
  normalizedCommand: string;
  launchOptions?: Readonly<vscode.TerminalOptions>;
}

interface StopResult {
  stopped: boolean;
  interrupted: boolean;
  usedInterrupt: boolean;
  interruptError?: string;
  disposeError?: string;
  terminalStillPresent: boolean;
}

interface ReplayResult {
  terminal: vscode.Terminal;
  mode: "shellIntegration" | "sendText";
  degradedReasons: string[];
}

export interface SimulatedTerminalExecution {
  terminal: vscode.Terminal;
  commandLine: string;
  cwd?: vscode.Uri;
  isTrusted?: boolean;
  confidence?: vscode.TerminalShellExecutionCommandLineConfidence;
}

const INTERRUPT_WAIT_MS = 150;
const DISPOSE_WAIT_MS = 150;
const SHELL_INTEGRATION_WAIT_MS = 1500;

export class TerminalInterceptor {
  private readonly replayAllowances = new WeakMap<vscode.Terminal, Map<string, number>>();
  private readonly pendingPrompts = new WeakSet<vscode.Terminal>();
  private readonly replayExecutions = new WeakMap<vscode.TerminalShellExecution, { terminalName: string; normalizedCommand: string }>();
  private readonly warnedPatterns = new Set<string>();

  public constructor(private readonly options: TerminalInterceptorOptions) {}

  public register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        void this.handleShellExecutionStart(event);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        this.handleShellExecutionEnd(event);
      })
    );
  }

  public async simulateExecutionForTesting(execution: SimulatedTerminalExecution): Promise<void> {
    await this.handleInterceptedExecution({
      terminal: execution.terminal,
      commandLine: {
        value: execution.commandLine,
        isTrusted: execution.isTrusted ?? false,
        confidence: execution.confidence ?? vscode.TerminalShellExecutionCommandLineConfidence.Low
      },
      cwd: execution.cwd
    });
  }

  private async handleShellExecutionStart(event: vscode.TerminalShellExecutionStartEvent): Promise<void> {
    await this.handleInterceptedExecution({
      terminal: event.terminal,
      commandLine: event.execution.commandLine,
      cwd: event.execution.cwd
    });
  }

  private async handleInterceptedExecution(context: InterceptedExecutionContext): Promise<void> {
    if (!this.options.isEnabled()) {
      return;
    }

    if (this.pendingPrompts.has(context.terminal)) {
      return;
    }

    const normalizedCommand = normalizeCommand(context.commandLine.value);
    if (!normalizedCommand) {
      this.log(`Execution started in "${context.terminal.name}" but command text was empty.`);
      return;
    }

    if (this.consumeReplayAllowance(context.terminal, normalizedCommand)) {
      this.log(`Allowed one-shot replay in "${context.terminal.name}": ${normalizedCommand}`);
      return;
    }

    const match = this.matchCommand(normalizedCommand, this.options.getRules());
    if (!match) {
      return;
    }

    this.pendingPrompts.add(context.terminal);
    this.options.auditLog.record({
      action: "intercepted",
      surface: "terminal",
      source: `terminal:${context.terminal.name}`,
      summary: match.normalizedCommand,
      risk: match.rule.risk ?? (match.bucket === "dangerousCommands" ? "critical" : "high"),
      detail: `Matched ${match.bucket}: ${match.rule.description ?? "custom terminal rule"}`,
      metadata: {
        pattern: match.rule.pattern,
        trusted: context.commandLine.isTrusted,
        confidence: context.commandLine.confidence,
        cwdKnown: Boolean(context.cwd)
      }
    });

    try {
      await this.stopPromptAndReplay(context, match);
    } finally {
      this.pendingPrompts.delete(context.terminal);
    }
  }

  private handleShellExecutionEnd(event: vscode.TerminalShellExecutionEndEvent): void {
    const replay = this.replayExecutions.get(event.execution);
    if (!replay) {
      return;
    }

    this.log(
      `Replay finished in "${replay.terminalName}" with exit code ${event.exitCode ?? "unknown"}: ${replay.normalizedCommand}`
    );
    this.options.auditLog.record({
      action: "status",
      surface: "terminal",
      source: `terminal:${replay.terminalName}`,
      summary: `Replay finished: ${replay.normalizedCommand}`,
      detail: `Exit code: ${event.exitCode ?? "unknown"}`,
      metadata: {
        exitCode: event.exitCode ?? "unknown"
      }
    });
  }

  private async stopPromptAndReplay(context: InterceptedExecutionContext, match: MatchedCommand): Promise<void> {
    const replayContext = this.createReplayContext(context, match.normalizedCommand);
    const stopResult = await this.stopTerminal(context.terminal);
    const degradedContext = this.getContextWarnings(replayContext);

    if (stopResult.interrupted) {
      this.options.auditLog.record({
        action: "interrupted",
        surface: "terminal",
        source: `terminal:${context.terminal.name}`,
        summary: match.normalizedCommand,
        detail: `Kill strategy: ${this.options.getKillStrategy()}`,
        metadata: {
          usedInterrupt: stopResult.usedInterrupt,
          terminalStillPresent: stopResult.terminalStillPresent
        }
      });
    } else {
      this.options.auditLog.record({
        action: "failed-to-stop",
        surface: "terminal",
        source: `terminal:${context.terminal.name}`,
        summary: match.normalizedCommand,
        detail: buildStopFailureDetail(stopResult),
        metadata: {
          usedInterrupt: stopResult.usedInterrupt,
          terminalStillPresent: stopResult.terminalStillPresent
        }
      });
    }

    const detailLines = [
      `Matched ${match.bucket}: ${match.rule.description ?? "custom terminal rule"}`,
      `Rule pattern: ${match.rule.pattern}`,
      `Command trust: ${context.commandLine.isTrusted ? "trusted" : "untrusted"}`,
      `Command confidence: ${confidenceLabel(context.commandLine.confidence)}`,
      `Captured cwd: ${replayContext.cwd?.toString() ?? "unknown"}`,
      "Safe Exec replays in a new terminal. It preserves cwd and launch options when VS Code exposes them, but it cannot restore exact shell state.",
      "Replay prefers shell integration execution and falls back to sendText if shell integration is unavailable in the replay terminal."
    ];

    if (!stopResult.stopped) {
      detailLines.push("Warning: Safe Exec could not confirm the original terminal stopped cleanly. Replaying may double-run the command.");
    }

    if (degradedContext.length > 0) {
      detailLines.push("Degraded replay context:");
      detailLines.push(...degradedContext.map((reason) => `- ${reason}`));
    }

    const approved = await this.options.permissionUI.requestApproval({
      title: match.bucket === "dangerousCommands" ? "Allow risky terminal command?" : "Allow terminal command after confirmation?",
      source: `terminal:${context.terminal.name}`,
      risk: match.rule.risk ?? (match.bucket === "dangerousCommands" ? "critical" : "high"),
      summary: match.normalizedCommand,
      detail: detailLines.join("\n"),
      preview: context.commandLine.value,
      previewLanguage: "shellscript",
      allowLabel: stopResult.stopped ? "Replay Command" : "Replay Anyway",
      denyLabel: "Deny"
    });

    if (!approved) {
      this.options.auditLog.record({
        action: "denied",
        surface: "terminal",
        source: `terminal:${context.terminal.name}`,
        summary: match.normalizedCommand,
        risk: match.rule.risk ?? (match.bucket === "dangerousCommands" ? "critical" : "high")
      });
      this.log(`Denied terminal command from "${context.terminal.name}": ${match.normalizedCommand}`);
      return;
    }

    this.options.auditLog.record({
      action: "approved",
      surface: "terminal",
      source: `terminal:${context.terminal.name}`,
      summary: match.normalizedCommand,
      risk: match.rule.risk ?? (match.bucket === "dangerousCommands" ? "critical" : "high")
    });

    try {
      const replay = await this.replayCommand(replayContext);
      this.options.auditLog.record({
        action: "replayed",
        surface: "terminal",
        source: `terminal:${replay.terminal.name}`,
        summary: match.normalizedCommand,
        detail: `Replay mode: ${replay.mode}`,
        metadata: {
          shellIntegration: replay.mode === "shellIntegration",
          cwdKnown: Boolean(replayContext.cwd)
        }
      });

      if (replay.degradedReasons.length > 0) {
        this.options.auditLog.record({
          action: "replay-degraded",
          surface: "terminal",
          source: `terminal:${replay.terminal.name}`,
          summary: match.normalizedCommand,
          detail: replay.degradedReasons.join("; "),
          metadata: {
            degradationCount: replay.degradedReasons.length
          }
        });
      }

      this.log(`Replayed approved command in "${replay.terminal.name}" via ${replay.mode}: ${match.normalizedCommand}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.auditLog.record({
        action: "failed",
        surface: "terminal",
        source: `terminal:${context.terminal.name}`,
        summary: match.normalizedCommand,
        detail: `Replay failed: ${message}`
      });
      this.log(`Failed to replay approved command from "${context.terminal.name}": ${message}`);
      void vscode.window.showErrorMessage(`Safe Exec failed to replay the approved command: ${message}`);
    }
  }

  private createReplayContext(context: InterceptedExecutionContext, normalizedCommand: string): ReplayContext {
    return {
      terminal: context.terminal,
      commandLine: context.commandLine,
      cwd: context.cwd ?? getLaunchCwd(context.terminal.creationOptions),
      normalizedCommand,
      launchOptions: getReplayableLaunchOptions(context.terminal.creationOptions)
    };
  }

  private async stopTerminal(terminal: vscode.Terminal): Promise<StopResult> {
    const result: StopResult = {
      stopped: false,
      interrupted: false,
      usedInterrupt: false,
      terminalStillPresent: true
    };

    if (this.options.getKillStrategy() === "interruptThenDispose") {
      result.usedInterrupt = true;
      try {
        terminal.show(true);
        await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: "\u0003" });
      } catch (error) {
        result.interruptError = error instanceof Error ? error.message : String(error);
        this.log(`Interrupt attempt failed for "${terminal.name}": ${result.interruptError}`);
      }

      await delay(INTERRUPT_WAIT_MS);
    }

    try {
      terminal.dispose();
    } catch (error) {
      result.disposeError = error instanceof Error ? error.message : String(error);
      this.log(`Failed to dispose terminal "${terminal.name}": ${result.disposeError}`);
    }

    await delay(DISPOSE_WAIT_MS);
    result.terminalStillPresent = vscode.window.terminals.includes(terminal);
    result.stopped = !result.terminalStillPresent && !result.disposeError;
    result.interrupted = result.stopped;
    return result;
  }

  private async replayCommand(context: ReplayContext): Promise<ReplayResult> {
    const replayTerminal = vscode.window.createTerminal({
      name: `Safe Exec Replay: ${context.terminal.name}`,
      ...context.launchOptions,
      cwd: context.cwd
    });

    this.allowReplayOnce(replayTerminal, context.normalizedCommand);
    replayTerminal.show(true);

    const degradedReasons = this.getContextWarnings(context);
    const shellIntegration = await this.waitForShellIntegration(replayTerminal, SHELL_INTEGRATION_WAIT_MS);

    if (!shellIntegration) {
      degradedReasons.push("shell integration unavailable in the replay terminal");
      replayTerminal.sendText(context.commandLine.value, true);
      return {
        terminal: replayTerminal,
        mode: "sendText",
        degradedReasons
      };
    }

    try {
      const execution = shellIntegration.executeCommand(context.commandLine.value);
      this.replayExecutions.set(execution, {
        terminalName: replayTerminal.name,
        normalizedCommand: context.normalizedCommand
      });
      return {
        terminal: replayTerminal,
        mode: "shellIntegration",
        degradedReasons
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      degradedReasons.push(`shell integration replay failed: ${message}`);
      replayTerminal.sendText(context.commandLine.value, true);
      return {
        terminal: replayTerminal,
        mode: "sendText",
        degradedReasons
      };
    }
  }

  private getContextWarnings(context: ReplayContext): string[] {
    const warnings: string[] = [];

    if (!context.cwd) {
      warnings.push("cwd unknown");
    } else if (context.cwd.scheme !== "file") {
      warnings.push(`cwd reported as ${context.cwd.toString()}, which may not map cleanly into a local replay terminal`);
    }

    if (!context.commandLine.isTrusted) {
      warnings.push("command line was not reported as trusted by shell integration");
    }

    if (context.commandLine.confidence === vscode.TerminalShellExecutionCommandLineConfidence.Low) {
      warnings.push("command line confidence was low");
    }

    if (!context.launchOptions?.shellPath && !context.launchOptions?.shellArgs && !context.launchOptions?.env) {
      warnings.push("replay may not match original shell state");
    }

    return warnings;
  }

  private async waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return terminal.shellIntegration;
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        disposable.dispose();
        resolve(undefined);
      }, timeoutMs);

      const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (settled || event.terminal !== terminal) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        disposable.dispose();
        resolve(event.shellIntegration);
      });
    });
  }

  private matchCommand(command: string, rules: SafeExecRules): MatchedCommand | undefined {
    if (this.matchesAnyRule(command, rules.allowedCommands)) {
      return undefined;
    }

    const dangerousRule = this.findFirstMatch(command, rules.dangerousCommands);
    if (dangerousRule) {
      return {
        bucket: "dangerousCommands",
        rule: dangerousRule,
        normalizedCommand: command
      };
    }

    const confirmationRule = this.findFirstMatch(command, rules.confirmationCommands);
    if (confirmationRule) {
      return {
        bucket: "confirmationCommands",
        rule: confirmationRule,
        normalizedCommand: command
      };
    }

    return undefined;
  }

  private matchesAnyRule(command: string, rules: readonly CommandPatternRule[]): boolean {
    return Boolean(this.findFirstMatch(command, rules));
  }

  private findFirstMatch(command: string, rules: readonly CommandPatternRule[]): CommandPatternRule | undefined {
    for (const rule of rules) {
      try {
        if (new RegExp(rule.pattern, "i").test(command)) {
          return rule;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const key = `${rule.pattern}:${message}`;
        if (!this.warnedPatterns.has(key)) {
          this.warnedPatterns.add(key);
          this.log(`Ignoring invalid terminal rule pattern "${rule.pattern}": ${message}`);
        }
      }
    }

    return undefined;
  }

  private allowReplayOnce(terminal: vscode.Terminal, normalizedCommand: string): void {
    const allowances = this.replayAllowances.get(terminal) ?? new Map<string, number>();
    allowances.set(normalizedCommand, (allowances.get(normalizedCommand) ?? 0) + 1);
    this.replayAllowances.set(terminal, allowances);
  }

  private consumeReplayAllowance(terminal: vscode.Terminal, normalizedCommand: string): boolean {
    const allowances = this.replayAllowances.get(terminal);
    const count = allowances?.get(normalizedCommand) ?? 0;

    if (count <= 0) {
      return false;
    }

    if (count === 1) {
      allowances?.delete(normalizedCommand);
    } else {
      allowances?.set(normalizedCommand, count - 1);
    }

    return true;
  }

  private log(message: string): void {
    this.options.output.appendLine(`[terminal] ${message}`);
  }
}

export function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getReplayableLaunchOptions(
  creationOptions: Readonly<vscode.TerminalOptions | vscode.ExtensionTerminalOptions>
): Readonly<vscode.TerminalOptions> | undefined {
  if ("pty" in creationOptions) {
    return undefined;
  }

  return {
    shellPath: creationOptions.shellPath,
    shellArgs: creationOptions.shellArgs,
    env: creationOptions.env,
    strictEnv: creationOptions.strictEnv,
    iconPath: creationOptions.iconPath,
    color: creationOptions.color,
    isTransient: creationOptions.isTransient,
    location: typeof creationOptions.location === "number" ? creationOptions.location : undefined
  };
}

function getLaunchCwd(
  creationOptions: Readonly<vscode.TerminalOptions | vscode.ExtensionTerminalOptions>
): vscode.Uri | undefined {
  if ("pty" in creationOptions || !creationOptions.cwd) {
    return undefined;
  }

  if (typeof creationOptions.cwd === "string") {
    return vscode.Uri.file(creationOptions.cwd);
  }

  return creationOptions.cwd;
}

function buildStopFailureDetail(result: StopResult): string {
  const reasons = [
    result.interruptError ? `interrupt failed: ${result.interruptError}` : undefined,
    result.disposeError ? `dispose failed: ${result.disposeError}` : undefined,
    result.terminalStillPresent ? "terminal still appears present after dispose" : undefined
  ].filter((value): value is string => Boolean(value));

  return reasons.join("; ") || "Safe Exec could not confirm the original terminal stopped.";
}

function confidenceLabel(confidence: vscode.TerminalShellExecutionCommandLineConfidence): string {
  switch (confidence) {
    case vscode.TerminalShellExecutionCommandLineConfidence.High:
      return "high";
    case vscode.TerminalShellExecutionCommandLineConfidence.Medium:
      return "medium";
    default:
      return "low";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
