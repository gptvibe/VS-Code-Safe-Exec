import type { ProtectedCommandRule, RiskLevel } from "./rules/types";

export interface ProtectedCommandDefinition {
  label: string;
  targetCommand: string;
  defaultRisk: RiskLevel;
  reason: string;
  availability?: "required" | "optional";
  includeInDefaults?: boolean;
  proxyCommand?: string;
  proxyTitle?: string;
  recommendedKeybinding?: {
    key: string;
    mac: string;
    when?: string;
    description: string;
  };
}

export interface WrappedCommandKeybindingExample {
  key: string;
  mac: string;
  command: "safeExec.runProtectedCommand";
  args: readonly unknown[];
  when?: string;
  description: string;
}

export const PROTECTED_COMMAND_VERIFICATION_NOTE =
  "Command IDs were checked against the VS Code Built-in Commands reference updated 2026-03-25 and the VS Code 1.113.0 desktop test host bundled in this repository.";

const PROTECTED_COMMAND_DEFINITIONS: readonly ProtectedCommandDefinition[] = [
  {
    label: "Run selected text in terminal",
    targetCommand: "workbench.action.terminal.runSelectedText",
    defaultRisk: "high",
    reason: "This command can send editor text directly to an interactive terminal.",
    proxyCommand: "safeExec.proxy.workbench.action.terminal.runSelectedText",
    proxyTitle: "Safe Exec: Proxy Run Selected Text In Terminal",
    recommendedKeybinding: {
      key: "ctrl+enter",
      mac: "cmd+enter",
      when: "editorTextFocus && editorHasSelection",
      description: "Routes the common terminal-send shortcut through Safe Exec."
    }
  },
  {
    label: "Run task",
    targetCommand: "workbench.action.tasks.runTask",
    defaultRisk: "medium",
    reason: "Tasks can execute workspace-defined automation or shell commands.",
    proxyCommand: "safeExec.proxy.workbench.action.tasks.runTask",
    proxyTitle: "Safe Exec: Proxy Run Task",
    recommendedKeybinding: {
      key: "ctrl+alt+r",
      mac: "cmd+alt+r",
      when: "workbenchState != empty",
      description: "Adds a dedicated guarded shortcut for running tasks."
    }
  },
  {
    label: "Run all notebook cells",
    targetCommand: "notebook.execute",
    defaultRisk: "high",
    reason: "Notebook run-all can execute every cell in the current notebook with the active kernel.",
    proxyCommand: "safeExec.proxy.notebook.execute",
    proxyTitle: "Safe Exec: Proxy Run All Notebook Cells"
  },
  {
    label: "Execute notebook cell",
    targetCommand: "notebook.cell.execute",
    defaultRisk: "high",
    reason: "Notebook cell execution runs code in the active kernel and can mutate local or remote state.",
    proxyCommand: "safeExec.proxy.notebook.cell.execute",
    proxyTitle: "Safe Exec: Proxy Execute Notebook Cell",
    recommendedKeybinding: {
      key: "shift+enter",
      mac: "shift+enter",
      when: "notebookEditorFocused",
      description: "Rebinds the common notebook execute shortcut to the Safe Exec proxy."
    }
  },
  {
    label: "Execute interactive input",
    targetCommand: "interactive.execute",
    defaultRisk: "high",
    reason: "Interactive window execution can run code immediately in the attached kernel or REPL.",
    proxyCommand: "safeExec.proxy.interactive.execute",
    proxyTitle: "Safe Exec: Proxy Execute Interactive Input"
  },
  {
    label: "Install extension",
    targetCommand: "workbench.extensions.installExtension",
    defaultRisk: "high",
    reason: "Installing an extension expands VS Code's code execution and automation surface.",
    proxyCommand: "safeExec.proxy.workbench.extensions.installExtension",
    proxyTitle: "Safe Exec: Proxy Install Extension"
  },
  {
    label: "Uninstall extension",
    targetCommand: "workbench.extensions.uninstallExtension",
    defaultRisk: "high",
    reason: "Uninstalling an extension mutates the local VS Code environment and can remove tooling or guardrails.",
    proxyCommand: "safeExec.proxy.workbench.extensions.uninstallExtension",
    proxyTitle: "Safe Exec: Proxy Uninstall Extension"
  },
  {
    label: "Copilot generate",
    targetCommand: "github.copilot.generate",
    defaultRisk: "medium",
    reason: "AI generation may create or trigger follow-on edits.",
    availability: "optional",
    includeInDefaults: false,
    proxyCommand: "safeExec.proxy.github.copilot.generate",
    proxyTitle: "Safe Exec: Proxy GitHub Copilot Generate",
    recommendedKeybinding: {
      key: "ctrl+alt+g",
      mac: "cmd+alt+g",
      when: "editorTextFocus",
      description: "Adds a dedicated guarded shortcut for AI generation."
    }
  },
  {
    label: "Open folder or workspace",
    targetCommand: "vscode.openFolder",
    defaultRisk: "medium",
    reason: "Opening another folder or workspace can switch extension context, trust state, and available automation."
  },
  {
    label: "Open a new window",
    targetCommand: "vscode.newWindow",
    defaultRisk: "medium",
    reason: "Spawning a new VS Code window changes workspace context and can launch a fresh automation surface."
  }
];

export const WRAPPED_COMMAND_KEYBINDING_EXAMPLES: readonly WrappedCommandKeybindingExample[] = [
  {
    key: "ctrl+alt+shift+i",
    mac: "cmd+alt+shift+i",
    command: "safeExec.runProtectedCommand",
    args: ["workbench.extensions.installExtension", ["ms-python.python"]],
    when: "workbenchState != empty",
    description: "Example wrapper for extension installation. Replace the extension ID before use."
  },
  {
    key: "ctrl+alt+shift+n",
    mac: "cmd+alt+shift+n",
    command: "safeExec.runProtectedCommand",
    args: ["vscode.newWindow", [{ reuseWindow: false }]],
    when: "workbenchState != empty",
    description: "Routes a new-window automation shortcut through Safe Exec's generic wrapper."
  }
] as const;

export type ExplicitProxyCommandDefinition = ProtectedCommandDefinition & {
  proxyCommand: string;
  proxyTitle: string;
};

export const EXPLICIT_PROXY_COMMAND_DEFINITIONS: readonly ExplicitProxyCommandDefinition[] =
  PROTECTED_COMMAND_DEFINITIONS.filter(isExplicitProxyCommandDefinition);

export const VERIFIED_EXPLICIT_PROXY_COMMAND_DEFINITIONS: readonly ExplicitProxyCommandDefinition[] =
  EXPLICIT_PROXY_COMMAND_DEFINITIONS.filter((definition) => definition.availability !== "optional");

export const WRAPPER_ONLY_PROTECTED_COMMAND_DEFINITIONS: readonly ProtectedCommandDefinition[] =
  PROTECTED_COMMAND_DEFINITIONS.filter((definition) => !definition.proxyCommand);

export const DEFAULT_PROTECTED_COMMAND_RULES: readonly ProtectedCommandRule[] = PROTECTED_COMMAND_DEFINITIONS.filter(
  (definition) => definition.includeInDefaults !== false
).map(({ label, targetCommand, defaultRisk }) => ({
    command: targetCommand,
    description: label,
    risk: defaultRisk
  }));

export function findProtectedCommandDefinition(targetCommand: string): ProtectedCommandDefinition | undefined {
  return PROTECTED_COMMAND_DEFINITIONS.find((definition) => definition.targetCommand === targetCommand);
}

function isExplicitProxyCommandDefinition(
  definition: ProtectedCommandDefinition
): definition is ExplicitProxyCommandDefinition {
  return typeof definition.proxyCommand === "string" && typeof definition.proxyTitle === "string";
}
