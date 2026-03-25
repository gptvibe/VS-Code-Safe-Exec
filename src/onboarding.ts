import { KeybindingInspection, renderKeybindingSummary } from "./keybindingInspector";
import { POLICY_BUNDLES } from "./rules";

export function createOnboardingMarkdown(options: {
  isEnabled: boolean;
  isTrustedWorkspace: boolean;
  keybindingInspection: KeybindingInspection;
}): string {
  const bundleList = Object.values(POLICY_BUNDLES)
    .map((bundle) => `- \`${bundle.id}\`: ${bundle.description}`)
    .join("\n");

  return [
    "# Safe Exec Onboarding",
    "",
    `Protection is currently **${options.isEnabled ? "enabled" : "disabled"}**.`,
    "",
    "## What Safe Exec Protects",
    "",
    "- Risky terminal commands detected through VS Code shell integration.",
    "- Explicit Safe Exec proxy commands for selected built-in commands.",
    "- Large or sensitive text edits through rollback, diff review, and reapply.",
    "- Best-effort file create, delete, and rename evaluation for supported VS Code file-operation events, with bounded recovery snapshots for supported delete and rename flows.",
    "",
    "## What It Does Not Protect",
    "",
    "- It does not sandbox extensions, shells, or the OS.",
    "- It does not transparently override built-in commands unless you call a Safe Exec proxy.",
    "- It cannot guarantee a risky terminal command never starts, because shell execution events are post-start.",
    "- It cannot preserve exact shell state when replaying an approved terminal command.",
    "- It does not claim coverage for external disk changes, and VS Code `workspace.fs` operations may bypass file-operation hooks.",
    "- It only restores file operations when Safe Exec captured a bounded snapshot first; oversized files and some non-file or non-recoverable cases fall back to metadata only.",
    "",
    "## Workspace Trust",
    "",
    options.isTrustedWorkspace
      ? "- This workspace is trusted. Workspace Trust may enable more workspace features, but it is not a security boundary and does not replace Safe Exec approval."
      : "- This workspace is not trusted. Workspace Trust can reduce what VS Code enables automatically, but it is not a sandbox and Safe Exec remains a best-effort guardrail.",
    "",
    renderKeybindingSummary(options.keybindingInspection),
    "",
    "## Policy Bundles",
    "",
    "Safe Exec includes opt-in bundle presets you can enable through rules or settings. They add stack-specific commands and protected paths without pretending to cover every tool.",
    "",
    bundleList,
    "",
    "## Suggested Next Steps",
    "",
    "- Use `Safe Exec: Open Safe Exec` or click the status bar item to reach onboarding, rules, keybinding help, and recent activity.",
    "- Use `Safe Exec: Show Recent File Operations` to review file-operation preflights, snapshot limits, and restore history.",
    "- Use `Safe Exec: Restore Last Recoverable File Operation` or `Safe Exec: Browse Recoverable File Operations` when you want to bring back a supported delete or rename flow.",
    "- Review or create `.vscode/safe-exec.rules.json`.",
    "- Wire common shortcuts to Safe Exec proxy commands.",
    "- Enable policy bundles that match your stack.",
    "- Keep docs and expectations aligned with the extension's best-effort posture."
  ].join("\n");
}
