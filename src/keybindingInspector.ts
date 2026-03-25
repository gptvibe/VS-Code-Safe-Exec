import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface KeybindingEntry {
  key?: string;
  command?: string;
  when?: string;
  mac?: string;
}

export interface KeybindingInspection {
  sourcePath?: string;
  entries: KeybindingEntry[];
  warnings: string[];
  advisories: string[];
  error?: string;
}

export interface RecommendedKeybinding extends KeybindingEntry {
  description: string;
}

const GUARDED_BINDINGS = [
  {
    rawCommand: "workbench.action.terminal.runSelectedText",
    proxyCommand: "safeExec.proxy.workbench.action.terminal.runSelectedText",
    label: "Run selected text in terminal"
  },
  {
    rawCommand: "workbench.action.tasks.runTask",
    proxyCommand: "safeExec.proxy.workbench.action.tasks.runTask",
    label: "Run task"
  },
  {
    rawCommand: "github.copilot.generate",
    proxyCommand: "safeExec.proxy.github.copilot.generate",
    label: "Copilot generate"
  }
] as const;

export const RECOMMENDED_PROXY_KEYBINDINGS: RecommendedKeybinding[] = [
  {
    key: "ctrl+enter",
    mac: "cmd+enter",
    command: "safeExec.proxy.workbench.action.terminal.runSelectedText",
    when: "editorTextFocus && editorHasSelection",
    description: "Routes the common terminal-send shortcut through Safe Exec."
  },
  {
    key: "ctrl+alt+r",
    mac: "cmd+alt+r",
    command: "safeExec.proxy.workbench.action.tasks.runTask",
    when: "workbenchState != empty",
    description: "Adds a dedicated guarded shortcut for running tasks."
  },
  {
    key: "ctrl+alt+g",
    mac: "cmd+alt+g",
    command: "safeExec.proxy.github.copilot.generate",
    when: "editorTextFocus",
    description: "Adds a dedicated guarded shortcut for AI generation."
  }
];

export async function inspectUserKeybindings(): Promise<KeybindingInspection> {
  const sourcePath = resolveKeybindingsPath(vscode.env.appName);
  if (!sourcePath) {
      return {
        entries: [],
        warnings: [],
        advisories: [],
        error: "Safe Exec could not determine a keybindings.json path for this VS Code build."
      };
  }

  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const entries = parseKeybindingsFile(raw);
    const findings = collectFindings(entries);
    return {
      sourcePath,
      entries,
      warnings: findings.warnings,
      advisories: findings.advisories
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {
        sourcePath,
        entries: [],
        warnings: [],
        advisories: GUARDED_BINDINGS.map(
          (binding) =>
            `${binding.label} has no Safe Exec proxy keybinding yet, so common raw entry points may still be easier to reach than the proxy command.`
        ),
        error: "No user keybindings.json file was found yet."
      };
    }

    return {
      sourcePath,
      entries: [],
      warnings: [],
      advisories: [],
      error: `Safe Exec could not inspect ${sourcePath}: ${nodeError.message}`
    };
  }
}

export function renderRecommendedKeybindingsJson(): string {
  return `${JSON.stringify(
    RECOMMENDED_PROXY_KEYBINDINGS.map(({ description: _description, ...binding }) => binding),
    null,
    2
  )}\n`;
}

export function renderKeybindingSummary(inspection: KeybindingInspection): string {
  const lines = [
    "## Proxy Keybindings",
    "",
    "Safe Exec cannot transparently override built-in VS Code commands. Proxy coverage depends on which commands you bind and call.",
    ""
  ];

  if (inspection.sourcePath) {
    lines.push(`- Inspected file: ${inspection.sourcePath}`);
  }

  if (inspection.error) {
    lines.push(`- Inspection status: ${inspection.error}`);
  } else if (inspection.warnings.length === 0 && inspection.advisories.length === 0) {
    lines.push("- Inspection status: no explicit raw keybinding mismatches were found in user keybindings.json.");
  } else {
    if (inspection.warnings.length > 0) {
      lines.push("- Warnings:");
      lines.push(...inspection.warnings.map((warning) => `  - ${warning}`));
    }

    if (inspection.advisories.length > 0) {
      lines.push("- Advisories:");
      lines.push(...inspection.advisories.map((advisory) => `  - ${advisory}`));
    }
  }

  lines.push("");
  lines.push("Recommended starter bindings:");
  lines.push("");
  lines.push("```json");
  lines.push(renderRecommendedKeybindingsJson().trimEnd());
  lines.push("```");
  return lines.join("\n");
}

function collectFindings(entries: readonly KeybindingEntry[]): { warnings: string[]; advisories: string[] } {
  const warnings: string[] = [];
  const advisories: string[] = [];

  for (const guardedBinding of GUARDED_BINDINGS) {
    const rawEntries = entries.filter((entry) => entry.command === guardedBinding.rawCommand);
    const proxyEntries = entries.filter((entry) => entry.command === guardedBinding.proxyCommand);

    if (rawEntries.length > 0) {
      for (const rawEntry of rawEntries) {
        const matchingProxy = proxyEntries.find((entry) => {
          return (entry.key ?? "") === (rawEntry.key ?? "") && (entry.when ?? "") === (rawEntry.when ?? "");
        });

        if (!matchingProxy) {
          const keyLabel = rawEntry.key ? ` on "${rawEntry.key}"` : "";
          warnings.push(
            `${guardedBinding.label}${keyLabel} is bound to "${guardedBinding.rawCommand}" without an equivalent Safe Exec proxy binding.`
          );
        }
      }
    }

    if (proxyEntries.length === 0) {
      advisories.push(
        `${guardedBinding.label} has no Safe Exec proxy keybinding yet, so common raw entry points may still be easier to reach than the proxy command.`
      );
    }
  }

  return {
    warnings,
    advisories
  };
}

function parseKeybindingsFile(raw: string): KeybindingEntry[] {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");

  const parsed = JSON.parse(stripped);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is KeybindingEntry => Boolean(entry) && typeof entry === "object");
}

function resolveKeybindingsPath(appName: string): string | undefined {
  const productFolder = getProductFolderName(appName);
  const homeDirectory = os.homedir();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, productFolder, "User", "keybindings.json") : undefined;
  }

  if (process.platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", productFolder, "User", "keybindings.json");
  }

  return path.join(homeDirectory, ".config", productFolder, "User", "keybindings.json");
}

function getProductFolderName(appName: string): string {
  if (/insiders/i.test(appName)) {
    return "Code - Insiders";
  }

  if (/vscodium/i.test(appName)) {
    return "VSCodium";
  }

  return "Code";
}
