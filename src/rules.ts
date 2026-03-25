import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface CommandPatternRule {
  pattern: string;
  description?: string;
  risk?: RiskLevel;
}

export interface ProtectedCommandRule {
  command: string;
  description?: string;
  risk?: RiskLevel;
}

export interface EditHeuristics {
  minChangedCharacters: number;
  minAffectedLines: number;
  maxPreviewCharacters: number;
  multipleChangeCount: number;
  protectedPathPatterns: string[];
  ignoredPathPatterns: string[];
}

export interface SafeExecRules {
  dangerousCommands: CommandPatternRule[];
  allowedCommands: CommandPatternRule[];
  confirmationCommands: CommandPatternRule[];
  protectedCommands: ProtectedCommandRule[];
  editHeuristics: EditHeuristics;
}

export interface SafeExecSettings {
  enabled: boolean;
  rulesPath: string;
  protectedCommands: string[];
  terminalKillStrategy: "interruptThenDispose" | "dispose";
  editHeuristics: Pick<EditHeuristics, "minChangedCharacters" | "minAffectedLines" | "maxPreviewCharacters">;
}

type PartialRuleInput = Partial<{
  dangerousCommands: Array<string | Partial<CommandPatternRule>>;
  allowedCommands: Array<string | Partial<CommandPatternRule>>;
  confirmationCommands: Array<string | Partial<CommandPatternRule>>;
  protectedCommands: Array<string | Partial<ProtectedCommandRule>>;
  editHeuristics: Partial<EditHeuristics>;
}>;

export const DEFAULT_RULES: SafeExecRules = {
  dangerousCommands: [
    { pattern: "\\brm\\s+-rf\\b", description: "Recursive force delete", risk: "critical" },
    {
      pattern: "\\b(?:Remove-Item|ri|rm)\\b(?=[^\\n\\r]*-Recurse\\b)(?=[^\\n\\r]*-Force\\b)[^\\n\\r]*",
      description: "PowerShell recursive forced delete",
      risk: "critical"
    },
    {
      pattern: "\\b(?:del|erase)\\b(?=[^\\n\\r]*\\s/f\\b)(?=[^\\n\\r]*\\s/s\\b)(?=[^\\n\\r]*\\s/q\\b)[^\\n\\r]*",
      description: "Windows cmd recursive forced delete",
      risk: "critical"
    },
    {
      pattern: "\\b(?:rmdir|rd)\\b(?=[^\\n\\r]*\\s/s\\b)(?=[^\\n\\r]*\\s/q\\b)[^\\n\\r]*",
      description: "Windows cmd recursive directory removal",
      risk: "critical"
    },
    { pattern: "\\bgit\\s+reset\\s+--hard\\b", description: "Git hard reset", risk: "high" },
    { pattern: "\\bgit\\s+clean\\s+-fdx\\b", description: "Git clean destructive sweep", risk: "high" },
    { pattern: "\\bdocker\\s+system\\s+prune\\s+-f\\b", description: "Docker destructive cleanup", risk: "high" },
    { pattern: "\\bterraform\\s+destroy\\b", description: "Terraform destroy", risk: "critical" },
    { pattern: "\\bkubectl\\s+delete\\b", description: "Kubernetes delete", risk: "high" },
    { pattern: "\\bmkfs(?:\\.[A-Za-z0-9_+-]+)?\\b", description: "Filesystem formatting", risk: "critical" },
    { pattern: "\\bdd\\b[^\\n\\r]*\\bof=/dev/", description: "Raw device write", risk: "critical" },
    { pattern: "\\bdiskutil\\s+erase(?:Disk|Volume)\\b", description: "macOS disk erase", risk: "critical" },
    { pattern: "\\bFormat-Volume\\b", description: "Windows volume formatting", risk: "critical" },
    { pattern: "\\b(?:Clear-Disk|Initialize-Disk)\\b", description: "Windows disk reinitialization", risk: "critical" },
    { pattern: "\\bdiskpart\\b(?![^\\n\\r]*\\s+/\\?)", description: "Windows disk partitioning tool", risk: "critical" }
  ],
  allowedCommands: [
    {
      pattern: "^\\s*(pwd|ls|dir|Get-ChildItem|gci|Get-Location|gl|git\\s+(?:status|diff|log|show|branch))\\b",
      description: "Common read-only commands across Unix shells and PowerShell",
      risk: "low"
    }
  ],
  confirmationCommands: [
    { pattern: "\\bgit\\s+push\\b", description: "Git push", risk: "medium" },
    { pattern: "\\bnpm\\s+publish\\b", description: "Package publishing", risk: "high" },
    { pattern: "\\bgh\\s+pr\\s+merge\\b", description: "Pull request merge", risk: "high" },
    { pattern: "\\bcode\\s+--install-extension\\b", description: "Install extension", risk: "medium" },
    {
      pattern: "\\b(?:brew|apt(?:-get)?|dnf|yum|pacman|winget|choco|scoop)\\s+(?:install|upgrade|remove|uninstall)\\b",
      description: "System package manager mutation",
      risk: "medium"
    },
    { pattern: "\\bSet-ExecutionPolicy\\b", description: "PowerShell execution policy change", risk: "high" }
  ],
  protectedCommands: [
    {
      command: "workbench.action.terminal.runSelectedText",
      description: "Run selected text in terminal",
      risk: "high"
    },
    {
      command: "workbench.action.tasks.runTask",
      description: "Run a configured task",
      risk: "medium"
    },
    {
      command: "github.copilot.generate",
      description: "AI code generation",
      risk: "medium"
    }
  ],
  editHeuristics: {
    minChangedCharacters: 120,
    minAffectedLines: 8,
    maxPreviewCharacters: 1500,
    multipleChangeCount: 3,
    protectedPathPatterns: [
      "(^|[\\\\/])\\.github[\\\\/]",
      "(^|[\\\\/])\\.vscode[\\\\/]",
      "(^|[\\\\/])package\\.json$",
      "(^|[\\\\/])tsconfig\\.json$",
      "(^|[\\\\/])pnpm-lock\\.yaml$",
      "(^|[\\\\/])package-lock\\.json$"
    ],
    ignoredPathPatterns: [
      "(^|[\\\\/])node_modules[\\\\/]",
      "(^|[\\\\/])out[\\\\/]",
      "(^|[\\\\/])dist[\\\\/]",
      "\\.git[\\\\/]"
    ]
  }
};

export const SAMPLE_RULES_JSON = `${JSON.stringify(DEFAULT_RULES, null, 2)}\n`;

function normalizePatternRule(
  entry: string | Partial<CommandPatternRule>,
  fallbackRisk: RiskLevel
): CommandPatternRule | undefined {
  if (typeof entry === "string") {
    return { pattern: entry, risk: fallbackRisk };
  }

  if (!entry || typeof entry.pattern !== "string" || entry.pattern.trim().length === 0) {
    return undefined;
  }

  return {
    pattern: entry.pattern,
    description: entry.description,
    risk: entry.risk ?? fallbackRisk
  };
}

function normalizeProtectedCommandRule(
  entry: string | Partial<ProtectedCommandRule>,
  fallbackRisk: RiskLevel
): ProtectedCommandRule | undefined {
  if (typeof entry === "string") {
    return { command: entry, risk: fallbackRisk };
  }

  if (!entry || typeof entry.command !== "string" || entry.command.trim().length === 0) {
    return undefined;
  }

  return {
    command: entry.command,
    description: entry.description,
    risk: entry.risk ?? fallbackRisk
  };
}

function normalizeEditHeuristics(input: Partial<EditHeuristics> | undefined): Partial<EditHeuristics> {
  if (!input) {
    return {};
  }

  const result: Partial<EditHeuristics> = {};

  if (typeof input.minChangedCharacters === "number" && input.minChangedCharacters > 0) {
    result.minChangedCharacters = input.minChangedCharacters;
  }

  if (typeof input.minAffectedLines === "number" && input.minAffectedLines > 0) {
    result.minAffectedLines = input.minAffectedLines;
  }

  if (typeof input.maxPreviewCharacters === "number" && input.maxPreviewCharacters > 0) {
    result.maxPreviewCharacters = input.maxPreviewCharacters;
  }

  if (typeof input.multipleChangeCount === "number" && input.multipleChangeCount > 0) {
    result.multipleChangeCount = input.multipleChangeCount;
  }

  if (Array.isArray(input.protectedPathPatterns)) {
    result.protectedPathPatterns = input.protectedPathPatterns.filter((value): value is string => typeof value === "string");
  }

  if (Array.isArray(input.ignoredPathPatterns)) {
    result.ignoredPathPatterns = input.ignoredPathPatterns.filter((value): value is string => typeof value === "string");
  }

  return result;
}

function mergePatternRules(
  defaults: CommandPatternRule[],
  fromFile: Array<string | Partial<CommandPatternRule>> | undefined,
  fallbackRisk: RiskLevel
): CommandPatternRule[] {
  const additions = (fromFile ?? [])
    .map((entry) => normalizePatternRule(entry, fallbackRisk))
    .filter((entry): entry is CommandPatternRule => Boolean(entry));

  return [...defaults, ...additions];
}

function mergeProtectedCommands(
  defaults: ProtectedCommandRule[],
  fromFile: Array<string | Partial<ProtectedCommandRule>> | undefined,
  fromConfig: string[]
): ProtectedCommandRule[] {
  const merged = new Map<string, ProtectedCommandRule>();

  for (const rule of defaults) {
    merged.set(rule.command, rule);
  }

  for (const entry of fromFile ?? []) {
    const normalized = normalizeProtectedCommandRule(entry, "medium");
    if (normalized) {
      merged.set(normalized.command, normalized);
    }
  }

  for (const command of fromConfig) {
    if (!merged.has(command)) {
      merged.set(command, { command, risk: "medium", description: "Configured in settings" });
    }
  }

  return Array.from(merged.values());
}

export function getSettings(): SafeExecSettings {
  const config = vscode.workspace.getConfiguration("safeExec");

  return {
    enabled: config.get<boolean>("enabled", true),
    rulesPath: config.get<string>("rulesPath", ".vscode/safe-exec.rules.json"),
    protectedCommands: config.get<string[]>("protectedCommands", []),
    terminalKillStrategy: config.get<"interruptThenDispose" | "dispose">("terminal.killStrategy", "interruptThenDispose"),
    editHeuristics: {
      minChangedCharacters: config.get<number>("editHeuristics.minChangedCharacters", DEFAULT_RULES.editHeuristics.minChangedCharacters),
      minAffectedLines: config.get<number>("editHeuristics.minAffectedLines", DEFAULT_RULES.editHeuristics.minAffectedLines),
      maxPreviewCharacters: config.get<number>("editHeuristics.maxPreviewCharacters", DEFAULT_RULES.editHeuristics.maxPreviewCharacters)
    }
  };
}

export function resolveRulesPath(settings: SafeExecSettings): vscode.Uri | undefined {
  const configuredPath = settings.rulesPath.trim();
  if (!configuredPath) {
    return undefined;
  }

  if (path.isAbsolute(configuredPath)) {
    return vscode.Uri.file(configuredPath);
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  return vscode.Uri.joinPath(workspaceFolder.uri, configuredPath);
}

async function readFileRules(uri: vscode.Uri | undefined, output: vscode.OutputChannel): Promise<PartialRuleInput> {
  if (!uri) {
    return {};
  }

  try {
    const buffer = await fs.readFile(uri.fsPath, "utf8");
    const parsed = JSON.parse(buffer) as PartialRuleInput;
    output.appendLine(`[rules] Loaded rules file from ${uri.fsPath}`);
    return parsed;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      output.appendLine(`[rules] Rules file not found at ${uri.fsPath}; using defaults.`);
      return {};
    }

    output.appendLine(`[rules] Failed to read rules file at ${uri.fsPath}: ${nodeError.message}`);
    throw error;
  }
}

export async function loadEffectiveRules(output: vscode.OutputChannel): Promise<SafeExecRules> {
  const settings = getSettings();
  const fileRules = await readFileRules(resolveRulesPath(settings), output);
  const mergedEditHeuristics = {
    ...DEFAULT_RULES.editHeuristics,
    ...normalizeEditHeuristics(fileRules.editHeuristics),
    ...settings.editHeuristics
  };

  return {
    dangerousCommands: mergePatternRules(DEFAULT_RULES.dangerousCommands, fileRules.dangerousCommands, "critical"),
    allowedCommands: mergePatternRules(DEFAULT_RULES.allowedCommands, fileRules.allowedCommands, "low"),
    confirmationCommands: mergePatternRules(DEFAULT_RULES.confirmationCommands, fileRules.confirmationCommands, "high"),
    protectedCommands: mergeProtectedCommands(
      DEFAULT_RULES.protectedCommands,
      fileRules.protectedCommands,
      settings.protectedCommands
    ),
    editHeuristics: {
      minChangedCharacters: mergedEditHeuristics.minChangedCharacters ?? DEFAULT_RULES.editHeuristics.minChangedCharacters,
      minAffectedLines: mergedEditHeuristics.minAffectedLines ?? DEFAULT_RULES.editHeuristics.minAffectedLines,
      maxPreviewCharacters: mergedEditHeuristics.maxPreviewCharacters ?? DEFAULT_RULES.editHeuristics.maxPreviewCharacters,
      multipleChangeCount: mergedEditHeuristics.multipleChangeCount ?? DEFAULT_RULES.editHeuristics.multipleChangeCount,
      protectedPathPatterns: mergedEditHeuristics.protectedPathPatterns ?? DEFAULT_RULES.editHeuristics.protectedPathPatterns,
      ignoredPathPatterns: mergedEditHeuristics.ignoredPathPatterns ?? DEFAULT_RULES.editHeuristics.ignoredPathPatterns
    }
  };
}

export async function ensureRulesFileExists(settings: SafeExecSettings): Promise<vscode.Uri | undefined> {
  const uri = resolveRulesPath(settings);
  if (!uri) {
    return undefined;
  }

  try {
    await fs.access(uri.fsPath);
    return uri;
  } catch {
    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.writeFile(uri.fsPath, SAMPLE_RULES_JSON, "utf8");
    return uri;
  }
}

export function matchesAnyRegexPattern(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return false;
    }
  });
}
