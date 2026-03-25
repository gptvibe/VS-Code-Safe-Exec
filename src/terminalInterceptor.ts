import * as vscode from "vscode";
import { PermissionUI } from "./permissionUI";
import { CommandPatternRule, SafeExecRules } from "./rules";

type MatchBucket = "dangerousCommands" | "confirmationCommands";

interface TerminalInterceptorOptions {
  output: vscode.OutputChannel;
  permissionUI: PermissionUI;
  getRules: () => SafeExecRules;
  isEnabled: () => boolean;
  getKillStrategy: () => "interruptThenDispose" | "dispose";
}

interface TerminalDataEventShim {
  terminal: vscode.Terminal;
  data: string;
}

interface CommandLineValueShim {
  value?: string;
}

interface TerminalShellExecutionShim {
  commandLine?: string | CommandLineValueShim;
}

interface TerminalShellExecutionStartEventShim {
  terminal: vscode.Terminal;
  execution?: TerminalShellExecutionShim;
  commandLine?: string | CommandLineValueShim;
}

interface OptionalTerminalWindowApi {
  onDidWriteTerminalData?: vscode.Event<TerminalDataEventShim>;
  onDidStartTerminalShellExecution?: vscode.Event<TerminalShellExecutionStartEventShim>;
}

interface MatchedCommand {
  bucket: MatchBucket;
  rule: CommandPatternRule;
  normalizedCommand: string;
}

const BUFFER_LIMIT = 4000;
const INTERRUPT_WAIT_MS = 150;

export class TerminalInterceptor {
  private readonly terminalBuffers = new WeakMap<vscode.Terminal, string>();
  private readonly replayAllowances = new WeakMap<vscode.Terminal, Map<string, number>>();
  private readonly pendingPrompts = new WeakSet<vscode.Terminal>();
  private readonly warnedPatterns = new Set<string>();

  public constructor(private readonly options: TerminalInterceptorOptions) {}

  public register(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    const windowApi = vscode.window as unknown as OptionalTerminalWindowApi;

    if (typeof windowApi.onDidWriteTerminalData === "function") {
      disposables.push(
        windowApi.onDidWriteTerminalData((event) => {
          this.recordTerminalData(event);
        })
      );
      this.log("Optional terminal data capture enabled.");
    } else {
      this.log("Optional terminal data capture API is unavailable in this VS Code build.");
    }

    if (typeof windowApi.onDidStartTerminalShellExecution === "function") {
      disposables.push(
        windowApi.onDidStartTerminalShellExecution((event) => {
          void this.handleShellExecutionStart(event);
        })
      );
      this.log("Terminal shell execution interception enabled.");
    } else {
      this.log("Terminal shell execution events are unavailable; command protection will be limited.");
    }

    return vscode.Disposable.from(...disposables);
  }

  private recordTerminalData(event: TerminalDataEventShim): void {
    const current = this.terminalBuffers.get(event.terminal) ?? "";
    const next = `${current}${stripAnsi(event.data)}`;
    this.terminalBuffers.set(event.terminal, next.slice(-BUFFER_LIMIT));
  }

  private async handleShellExecutionStart(event: TerminalShellExecutionStartEventShim): Promise<void> {
    if (!this.options.isEnabled()) {
      return;
    }

    if (this.pendingPrompts.has(event.terminal)) {
      return;
    }

    const rawCommand =
      this.extractCommandFromShellEvent(event) ??
      this.extractCommandFromBufferedTerminalData(event.terminal);

    if (!rawCommand) {
      this.log(`Execution started in "${event.terminal.name}" but no command text was available.`);
      return;
    }

    if (this.consumeReplayAllowance(event.terminal, rawCommand)) {
      this.log(`Allowed one-shot replay in "${event.terminal.name}": ${normalizeCommand(rawCommand)}`);
      return;
    }

    const match = this.matchCommand(rawCommand, this.options.getRules());
    if (!match) {
      return;
    }

    this.pendingPrompts.add(event.terminal);

    try {
      await this.stopPromptAndReplay(event.terminal, rawCommand, match);
    } finally {
      this.pendingPrompts.delete(event.terminal);
    }
  }

  private extractCommandFromShellEvent(event: TerminalShellExecutionStartEventShim): string | undefined {
    const values = [event.commandLine, event.execution?.commandLine];
    for (const value of values) {
      const commandText = unwrapCommandLine(value);
      if (normalizeCommand(commandText)) {
        return commandText;
      }
    }

    return undefined;
  }

  private extractCommandFromBufferedTerminalData(terminal: vscode.Terminal): string | undefined {
    const buffered = this.terminalBuffers.get(terminal);
    if (!buffered) {
      return undefined;
    }

    const extracted = extractPromptCommand(buffered);
    return extracted || undefined;
  }

  private matchCommand(command: string, rules: SafeExecRules): MatchedCommand | undefined {
    const normalizedCommand = normalizeCommand(command);
    if (!normalizedCommand) {
      return undefined;
    }

    if (this.matchesAnyRule(normalizedCommand, rules.allowedCommands)) {
      return undefined;
    }

    const dangerousRule = this.findFirstMatch(normalizedCommand, rules.dangerousCommands);
    if (dangerousRule) {
      return {
        bucket: "dangerousCommands",
        rule: dangerousRule,
        normalizedCommand
      };
    }

    const confirmationRule = this.findFirstMatch(normalizedCommand, rules.confirmationCommands);
    if (confirmationRule) {
      return {
        bucket: "confirmationCommands",
        rule: confirmationRule,
        normalizedCommand
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

  private async stopPromptAndReplay(
    terminal: vscode.Terminal,
    command: string,
    match: MatchedCommand
  ): Promise<void> {
    // This is best-effort only: the shell integration event fires when execution starts,
    // so Safe Exec can only try to interrupt/close the terminal and then ask to replay.
    await this.stopTerminal(terminal);

    const approved = await this.options.permissionUI.requestApproval({
      title: match.bucket === "dangerousCommands" ? "Allow risky terminal command?" : "Allow terminal command after confirmation?",
      source: `terminal:${terminal.name}`,
      risk: match.rule.risk ?? (match.bucket === "dangerousCommands" ? "critical" : "high"),
      summary: match.normalizedCommand,
      detail: [
        `Matched ${match.bucket}: ${match.rule.description ?? "custom terminal rule"}`,
        `Rule pattern: ${match.rule.pattern}`,
        "Safe Exec uses a kill-and-replay model here. The original terminal was already starting execution, so approval replays the exact command in a fresh terminal."
      ].join("\n"),
      preview: command,
      previewLanguage: "shellscript",
      allowLabel: "Replay Command",
      denyLabel: "Deny"
    });

    if (!approved) {
      this.log(`Denied terminal command from "${terminal.name}": ${match.normalizedCommand}`);
      return;
    }

    const replayTerminal = vscode.window.createTerminal({
      name: `Safe Exec Replay: ${terminal.name}`
    });

    this.allowReplayOnce(replayTerminal, command);
    replayTerminal.show(true);
    replayTerminal.sendText(command, true);
    this.log(`Replayed approved command in "${replayTerminal.name}": ${match.normalizedCommand}`);
  }

  private async stopTerminal(terminal: vscode.Terminal): Promise<void> {
    if (this.options.getKillStrategy() === "interruptThenDispose") {
      try {
        terminal.show(true);
        await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: "\u0003" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Interrupt attempt failed for "${terminal.name}": ${message}`);
      }

      await delay(INTERRUPT_WAIT_MS);
    }

    try {
      terminal.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to dispose terminal "${terminal.name}": ${message}`);
    }
  }

  private allowReplayOnce(terminal: vscode.Terminal, command: string): void {
    const normalizedCommand = normalizeCommand(command);
    const allowances = this.replayAllowances.get(terminal) ?? new Map<string, number>();
    allowances.set(normalizedCommand, (allowances.get(normalizedCommand) ?? 0) + 1);
    this.replayAllowances.set(terminal, allowances);
  }

  private consumeReplayAllowance(terminal: vscode.Terminal, command: string): boolean {
    const normalizedCommand = normalizeCommand(command);
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

function unwrapCommandLine(value: string | CommandLineValueShim | undefined): string {
  if (typeof value === "string") {
    return value;
  }

  return typeof value?.value === "string" ? value.value : "";
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function extractPromptCommand(value: string): string {
  const lines = stripAnsi(value)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return "";
  }

  const lastLine = lines[lines.length - 1] ?? "";
  const promptMatch = lastLine.match(/^(?:.+?[\$#>%]\s+)(.+)$/);
  return (promptMatch?.[1] ?? lastLine).trim();
}

export function normalizeCommand(value: string): string {
  return extractPromptCommand(value).replace(/\s+/g, " ").trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
