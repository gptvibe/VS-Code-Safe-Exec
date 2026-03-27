import * as vscode from "vscode";
import type { AuditLog } from "./auditLog";
import type { PermissionUI } from "./permissionUI";
import { findFirstMatchingCommandRule } from "./rules";
import type { CommandPatternRule, CompiledCommandPatternRule, CompiledRules, RiskLevel, TerminalCriticalReplayPolicy } from "./rules";

type MatchBucket = "dangerousCommands" | "confirmationCommands";
type CompiledCommandRuleList = readonly CompiledCommandPatternRule[];

interface TerminalInterceptorOptions {
  output: vscode.OutputChannel;
  permissionUI: PermissionUI;
  auditLog: AuditLog;
  getRules: () => CompiledRules;
  isEnabled: () => boolean;
  getKillStrategy: () => "interruptThenDispose" | "dispose";
  getCriticalReplayPolicy: () => TerminalCriticalReplayPolicy;
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
  interruptAttempted: boolean;
  usedInterrupt: boolean;
  interruptError?: string;
  disposeAttempted: boolean;
  disposeError?: string;
  terminalStillPresent: boolean;
}

interface ReplayResult {
  kind: "automatic";
  terminal: vscode.Terminal;
  mode: "shellIntegration" | "sendText";
  degradedReasons: string[];
}

interface ManualReplayResult {
  kind: "manual";
  terminal: vscode.Terminal;
  degradedReasons: string[];
  reason: CriticalReplayManualReason;
  clipboardCopied: boolean;
  clipboardError?: string;
}

type ApprovedExecutionResult = ReplayResult | ManualReplayResult;

type CriticalReplayManualReason = "manualPolicy" | "stopUnconfirmed" | "shellIntegrationUnavailable";

type CriticalReplayDecision =
  | {
      kind: "automatic";
      shellIntegrationRequired: boolean;
    }
  | {
      kind: "manual";
      reason: CriticalReplayManualReason;
    }
  | {
      kind: "deny";
      reason: "stopUnconfirmed";
    };

interface ReplayAttemptOptions {
  risk: RiskLevel;
  criticalReplayPolicy: TerminalCriticalReplayPolicy;
  stopConfirmed: boolean;
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

export interface CriticalReplayDecisionInput {
  policy: TerminalCriticalReplayPolicy;
  stopConfirmed: boolean;
  shellIntegrationAvailable: boolean;
}

export function selectCriticalReplayDecision(input: CriticalReplayDecisionInput): CriticalReplayDecision {
  if (input.policy === "manualReplay") {
    return {
      kind: "manual",
      reason: "manualPolicy"
    };
  }

  if (!input.stopConfirmed) {
    if (input.policy === "bestEffort") {
      return {
        kind: "automatic",
        shellIntegrationRequired: false
      };
    }

    if (input.policy === "denyIfStopUnconfirmed") {
      return {
        kind: "deny",
        reason: "stopUnconfirmed"
      };
    }

    return {
      kind: "manual",
      reason: "stopUnconfirmed"
    };
  }

  if (!input.shellIntegrationAvailable) {
    if (input.policy === "bestEffort") {
      return {
        kind: "automatic",
        shellIntegrationRequired: false
      };
    }

    return {
      kind: "manual",
      reason: "shellIntegrationUnavailable"
    };
  }

  return {
    kind: "automatic",
    shellIntegrationRequired: input.policy !== "bestEffort"
  };
}

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

    const risk = this.getRisk(match);
    const criticalReplayPolicy = risk === "critical" ? this.options.getCriticalReplayPolicy() : undefined;
    this.pendingPrompts.add(context.terminal);
    this.options.auditLog.record({
      action: "matched",
      surface: "terminal",
      source: `terminal:${context.terminal.name}`,
      summary: match.normalizedCommand,
      risk,
      detail: `Matched ${match.bucket}: ${match.rule.description ?? "custom terminal rule"}`,
      metadata: {
        pattern: match.rule.pattern,
        trusted: context.commandLine.isTrusted,
        confidence: context.commandLine.confidence,
        cwdKnown: Boolean(context.cwd),
        criticalMatch: risk === "critical",
        criticalReplayPolicy
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
    const risk = this.getRisk(match);
    const isCritical = risk === "critical";
    const criticalReplayPolicy = isCritical ? this.options.getCriticalReplayPolicy() : "bestEffort";
    const replayContext = this.createReplayContext(context, match.normalizedCommand);
    const stopResult = await this.stopTerminal(context.terminal);
    const degradedContext = this.getContextWarnings(replayContext);
    const initialCriticalDecision = isCritical
      ? selectCriticalReplayDecision({
          policy: criticalReplayPolicy,
          stopConfirmed: stopResult.stopped,
          shellIntegrationAvailable: true
        })
      : undefined;

    if (stopResult.interruptAttempted) {
      this.options.auditLog.record({
        action: "interrupted-attempted",
        surface: "terminal",
        source: `terminal:${context.terminal.name}`,
        summary: match.normalizedCommand,
        detail: stopResult.interruptError
          ? `Interrupt attempt failed before replay: ${stopResult.interruptError}`
          : `Interrupt attempt sent before replay using ${this.options.getKillStrategy()}.`,
        metadata: {
          usedInterrupt: stopResult.usedInterrupt,
          terminalStillPresent: stopResult.terminalStillPresent,
          interruptFailed: Boolean(stopResult.interruptError),
          criticalMatch: isCritical,
          criticalReplayPolicy
        }
      });
    }

    this.options.auditLog.record({
      action: "dispose-attempted",
      surface: "terminal",
      source: `terminal:${context.terminal.name}`,
      summary: match.normalizedCommand,
      detail: stopResult.disposeError
        ? `Dispose attempt failed before replay: ${stopResult.disposeError}`
        : stopResult.stopped
        ? "Disposed original terminal before replay."
        : "Dispose was attempted, but Safe Exec could not confirm the original terminal stopped cleanly.",
      metadata: {
        usedInterrupt: stopResult.usedInterrupt,
        terminalStillPresent: stopResult.terminalStillPresent,
        disposeFailed: Boolean(stopResult.disposeError),
        stopped: stopResult.stopped,
        criticalMatch: isCritical,
        criticalReplayPolicy
      }
    });

    const detailLines = [
      `Matched ${match.bucket}: ${match.rule.description ?? "custom terminal rule"}`,
      `Rule pattern: ${match.rule.pattern}`,
      `Command trust: ${context.commandLine.isTrusted ? "trusted" : "untrusted"}`,
      `Command confidence: ${confidenceLabel(context.commandLine.confidence)}`,
      `Captured cwd: ${replayContext.cwd?.toString() ?? "unknown"}`,
      "Detection path: VS Code shell integration reported a shell execution start event for this integrated terminal.",
      "This flow is post-start. The original command may already have begun before Safe Exec tries to interrupt or dispose the terminal.",
      "Terminals without usable shell integration do not enter this approval flow.",
      "Safe Exec replays in a new terminal. It preserves cwd and launch options when VS Code exposes them, but it cannot restore exact shell state."
    ];

    if (isCritical) {
      detailLines.push(`Critical replay policy: ${criticalReplayPolicy}.`);
      if (initialCriticalDecision?.kind === "manual") {
        detailLines.push(
          `If you approve this critical command, Safe Exec will open a fresh terminal and copy the command to your clipboard for manual replay because ${describeManualReplayReason(initialCriticalDecision.reason)}.`
        );
      } else if (criticalReplayPolicy === "bestEffort") {
        detailLines.push(
          "Replay prefers shell integration execution and falls back to sendText if shell integration is unavailable in the replay terminal."
        );
      } else {
        detailLines.push(
          "If shell-integration replay is unavailable in the replay terminal, Safe Exec will switch to manual replay instead of falling back to sendText."
        );
      }
    } else {
      detailLines.push("Replay prefers shell integration execution and falls back to sendText if shell integration is unavailable in the replay terminal.");
    }

    if (!stopResult.stopped) {
      detailLines.push("Warning: Safe Exec could not confirm the original terminal stopped cleanly. Replaying may double-run the command.");
    }

    if (degradedContext.length > 0) {
      detailLines.push("Degraded replay context:");
      detailLines.push(...degradedContext.map((reason) => `- ${reason}`));
      this.log(`Replay context warnings for "${context.terminal.name}": ${degradedContext.join("; ")}`);
    }

    if (initialCriticalDecision?.kind === "deny") {
      const detail = `Critical replay policy denied replay because ${describePolicyBlockedReason(initialCriticalDecision.reason)}.`;
      this.options.auditLog.record({
        action: "replay-blocked",
        surface: "terminal",
        source: `terminal:${context.terminal.name}`,
        summary: match.normalizedCommand,
        risk,
        detail,
        metadata: {
          criticalReplayPolicy,
          stopConfirmed: stopResult.stopped,
          cwdKnown: Boolean(replayContext.cwd)
        }
      });
      this.log(`Blocked critical replay for "${context.terminal.name}": ${match.normalizedCommand} (${detail})`);
      void vscode.window.showWarningMessage(`Safe Exec denied replay of this critical command because ${describePolicyBlockedReason(initialCriticalDecision.reason)}.`);
      return;
    }

    const approvedOutcome = initialCriticalDecision?.kind === "manual" ? "manual-replay" : "automatic-replay";
    const approval = await this.options.permissionUI.requestApproval({
      title: match.bucket === "dangerousCommands" ? "Allow risky terminal command?" : "Allow terminal command after confirmation?",
      source: `terminal:${context.terminal.name}`,
      risk,
      summary: match.normalizedCommand,
      explanation:
        "Safe Exec saw this command after VS Code shell integration reported a terminal execution start. Approval decides whether Safe Exec should replay the captured command in a fresh terminal after trying to stop the original one.",
      whyFlagged: [
        `Matched ${match.bucket}: ${match.rule.description ?? "custom terminal rule"}`,
        `Rule pattern: ${match.rule.pattern}`,
        `Command trust: ${context.commandLine.isTrusted ? "trusted" : "untrusted"}`,
        `Command confidence: ${confidenceLabel(context.commandLine.confidence)}`,
        `Captured cwd: ${replayContext.cwd?.toString() ?? "unknown"}`
      ],
      detail: detailLines.join("\n"),
      preview: context.commandLine.value,
      previewLanguage: "shellscript",
      actionKey: buildTerminalActionKey(match.normalizedCommand, replayContext.cwd),
      suppressRepeatedApprovedLowRisk: true,
      workspaceTrustOption:
        risk === "medium" && stopResult.stopped && degradedContext.length === 0
          ? {
              description:
                "Allow In This Workspace creates a Safe Exec exception for this exact medium-risk command and captured working directory in the current workspace only. It does not change VS Code Workspace Trust."
            }
          : undefined,
      allowLabel:
        initialCriticalDecision?.kind === "manual"
          ? "Copy For Manual Replay"
          : stopResult.stopped
          ? "Replay Command"
          : "Replay Anyway",
      denyLabel: "Deny"
    });

    if (!approval.approved) {
      this.options.auditLog.record({
        action: "denied",
        surface: "terminal",
        source: `terminal:${context.terminal.name}`,
        summary: match.normalizedCommand,
        risk,
        metadata: {
          criticalMatch: isCritical,
          criticalReplayPolicy,
          stopConfirmed: stopResult.stopped,
          outcome: approvedOutcome,
          approvalResolution: approval.resolution
        }
      });
      this.log(`Denied terminal command from "${context.terminal.name}": ${match.normalizedCommand}`);
      return;
    }

    this.options.auditLog.record({
      action: "approved",
      surface: "terminal",
      source: `terminal:${context.terminal.name}`,
      summary: match.normalizedCommand,
      risk,
      metadata: {
        criticalMatch: isCritical,
        criticalReplayPolicy,
        stopConfirmed: stopResult.stopped,
        outcome: approvedOutcome,
        approvalResolution: approval.resolution
      }
    });

    try {
      const replay = await this.replayCommand(replayContext, {
        risk,
        criticalReplayPolicy,
        stopConfirmed: stopResult.stopped
      });
      if (replay.kind === "manual") {
        if (replay.clipboardCopied) {
          this.options.auditLog.record({
            action: "clipboard-copied",
            surface: "terminal",
            source: `terminal:${replay.terminal.name}`,
            summary: match.normalizedCommand,
            risk,
            detail: "Safe Exec copied the approved command to the clipboard for manual replay.",
            metadata: {
              criticalReplayPolicy,
              stopConfirmed: stopResult.stopped
            }
          });
        }

        this.options.auditLog.record({
          action: "manual-replay",
          surface: "terminal",
          source: `terminal:${replay.terminal.name}`,
          summary: match.normalizedCommand,
          risk,
          detail: replay.clipboardError
            ? `Manual replay prepared because ${describeManualReplayReason(replay.reason)}. Clipboard copy failed: ${replay.clipboardError}`
            : `Manual replay prepared because ${describeManualReplayReason(replay.reason)}.`,
          metadata: {
            criticalReplayPolicy,
            stopConfirmed: stopResult.stopped,
            cwdKnown: Boolean(replayContext.cwd),
            clipboardCopied: replay.clipboardCopied,
            degradationCount: replay.degradedReasons.length
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
              degradationCount: replay.degradedReasons.length,
              criticalReplayPolicy
            }
          });
        }

        this.log(
          `Prepared manual replay in "${replay.terminal.name}" for "${context.terminal.name}": ${match.normalizedCommand} (${describeManualReplayReason(replay.reason)})`
        );
        if (replay.clipboardError) {
          void vscode.window.showWarningMessage(
            `Safe Exec opened a manual replay terminal, but could not copy the command to your clipboard: ${replay.clipboardError}`
          );
        } else {
          void vscode.window.showInformationMessage(
            "Safe Exec opened a manual replay terminal and copied the approved command to your clipboard."
          );
        }
        return;
      }

      this.options.auditLog.record({
        action: "replayed",
        surface: "terminal",
        source: `terminal:${replay.terminal.name}`,
        summary: match.normalizedCommand,
        detail: `Replay mode: ${replay.mode}`,
        metadata: {
          shellIntegration: replay.mode === "shellIntegration",
          cwdKnown: Boolean(replayContext.cwd),
          criticalReplayPolicy,
          stopConfirmed: stopResult.stopped
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
            degradationCount: replay.degradedReasons.length,
            criticalReplayPolicy
          }
        });
        this.log(`Replayed with degraded context in "${replay.terminal.name}": ${replay.degradedReasons.join("; ")}`);
      }

      this.log(`Replayed approved command in "${replay.terminal.name}" via ${replay.mode}: ${match.normalizedCommand}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.auditLog.record({
        action: "replay-failed",
        surface: "terminal",
        source: `terminal:${context.terminal.name}`,
        summary: match.normalizedCommand,
        detail: `Replay failed: ${message}`,
        metadata: {
          criticalReplayPolicy,
          stopConfirmed: stopResult.stopped
        }
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
      interruptAttempted: false,
      usedInterrupt: false,
      disposeAttempted: false,
      terminalStillPresent: true
    };

    if (this.options.getKillStrategy() === "interruptThenDispose") {
      result.usedInterrupt = true;
      result.interruptAttempted = true;
      try {
        terminal.show(true);
        await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: "\u0003" });
      } catch (error) {
        result.interruptError = error instanceof Error ? error.message : String(error);
        this.log(`Interrupt attempt failed for "${terminal.name}": ${result.interruptError}`);
      }

      await delay(INTERRUPT_WAIT_MS);
    }

    result.disposeAttempted = true;
    try {
      terminal.dispose();
    } catch (error) {
      result.disposeError = error instanceof Error ? error.message : String(error);
      this.log(`Failed to dispose terminal "${terminal.name}": ${result.disposeError}`);
    }

    await delay(DISPOSE_WAIT_MS);
    result.terminalStillPresent = vscode.window.terminals.includes(terminal);
    result.stopped = !result.terminalStillPresent && !result.disposeError;
    return result;
  }

  private async replayCommand(context: ReplayContext, options: ReplayAttemptOptions): Promise<ApprovedExecutionResult> {
    const initialCriticalDecision =
      options.risk === "critical"
        ? selectCriticalReplayDecision({
            policy: options.criticalReplayPolicy,
            stopConfirmed: options.stopConfirmed,
            shellIntegrationAvailable: true
          })
        : undefined;

    if (initialCriticalDecision?.kind === "manual") {
      return this.prepareManualReplay(context, initialCriticalDecision.reason, this.getContextWarnings(context));
    }

    if (initialCriticalDecision?.kind === "deny") {
      throw new Error(`Critical replay was blocked because ${describePolicyBlockedReason(initialCriticalDecision.reason)}.`);
    }

    const replayTerminal = this.createReplayTerminal(context, "Replay");
    this.allowReplayOnce(replayTerminal, context.normalizedCommand);
    replayTerminal.show(true);

    const degradedReasons = this.getContextWarnings(context);
    const shellIntegration = await this.waitForShellIntegration(replayTerminal, SHELL_INTEGRATION_WAIT_MS);

    if (!shellIntegration) {
      degradedReasons.push("shell integration unavailable in the replay terminal");
      const criticalDecision =
        options.risk === "critical"
          ? selectCriticalReplayDecision({
              policy: options.criticalReplayPolicy,
              stopConfirmed: options.stopConfirmed,
              shellIntegrationAvailable: false
            })
          : undefined;
      if (criticalDecision?.kind === "manual") {
        return this.prepareManualReplay(context, criticalDecision.reason, degradedReasons, replayTerminal);
      }

      replayTerminal.sendText(context.commandLine.value, true);
      return {
        kind: "automatic",
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
        kind: "automatic",
        terminal: replayTerminal,
        mode: "shellIntegration",
        degradedReasons
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      degradedReasons.push(`shell integration replay failed: ${message}`);
      const criticalDecision =
        options.risk === "critical"
          ? selectCriticalReplayDecision({
              policy: options.criticalReplayPolicy,
              stopConfirmed: options.stopConfirmed,
              shellIntegrationAvailable: false
            })
          : undefined;
      if (criticalDecision?.kind === "manual") {
        return this.prepareManualReplay(context, criticalDecision.reason, degradedReasons, replayTerminal);
      }

      replayTerminal.sendText(context.commandLine.value, true);
      return {
        kind: "automatic",
        terminal: replayTerminal,
        mode: "sendText",
        degradedReasons
      };
    }
  }

  private async prepareManualReplay(
    context: ReplayContext,
    reason: CriticalReplayManualReason,
    degradedReasons: string[],
    replaceTerminal?: vscode.Terminal
  ): Promise<ManualReplayResult> {
    if (replaceTerminal) {
      try {
        replaceTerminal.dispose();
      } catch {
        // Ignore best-effort cleanup failures and continue with manual replay.
      }
    }

    const manualTerminal = this.createReplayTerminal(context, "Manual Replay");
    manualTerminal.show(true);

    let clipboardCopied = false;
    let clipboardError: string | undefined;
    try {
      await vscode.env.clipboard.writeText(context.commandLine.value);
      clipboardCopied = true;
    } catch (error) {
      clipboardError = error instanceof Error ? error.message : String(error);
      this.log(`Failed to copy manual replay command for "${manualTerminal.name}": ${clipboardError}`);
    }

    return {
      kind: "manual",
      terminal: manualTerminal,
      degradedReasons,
      reason,
      clipboardCopied,
      clipboardError
    };
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

  private createReplayTerminal(context: ReplayContext, label: "Replay" | "Manual Replay"): vscode.Terminal {
    return vscode.window.createTerminal({
      name: `Safe Exec ${label}: ${context.terminal.name}`,
      ...context.launchOptions,
      cwd: context.cwd
    });
  }

  private getRisk(match: MatchedCommand): RiskLevel {
    return match.rule.risk ?? (match.bucket === "dangerousCommands" ? "critical" : "high");
  }

  private matchCommand(command: string, rules: CompiledRules): MatchedCommand | undefined {
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

  private matchesAnyRule(command: string, rules: CompiledCommandRuleList): boolean {
    return Boolean(this.findFirstMatch(command, rules));
  }

  private findFirstMatch(command: string, rules: CompiledCommandRuleList): CommandPatternRule | undefined {
    return findFirstMatchingCommandRule(command, rules, (pattern, error) => {
      const key = `${pattern}:${error}`;
      if (!this.warnedPatterns.has(key)) {
        this.warnedPatterns.add(key);
        this.log(`Ignoring invalid terminal rule pattern "${pattern}": ${error}`);
      }
    });
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

function describeManualReplayReason(reason: CriticalReplayManualReason): string {
  switch (reason) {
    case "manualPolicy":
      return "the critical replay policy requires manual replay";
    case "stopUnconfirmed":
      return "Safe Exec could not confirm the original terminal stopped cleanly";
    case "shellIntegrationUnavailable":
      return "shell-integration replay was unavailable";
  }
}

function describePolicyBlockedReason(reason: "stopUnconfirmed"): string {
  switch (reason) {
    case "stopUnconfirmed":
      return "Safe Exec could not confirm the original terminal stopped cleanly";
  }
}

function buildTerminalActionKey(command: string, cwd: vscode.Uri | undefined): string {
  return `terminal:${command}:cwd:${cwd?.toString() ?? "unknown"}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
