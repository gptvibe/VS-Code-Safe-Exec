import {
  getKeybindingDiagnosticSeverity,
  renderKeybindingSummary,
  summarizeKeybindingInspection,
  type KeybindingInspection
} from "./keybindingInspector";
import {
  PROTECTED_COMMAND_VERIFICATION_NOTE,
  VERIFIED_EXPLICIT_PROXY_COMMAND_DEFINITIONS,
  WRAPPER_ONLY_PROTECTED_COMMAND_DEFINITIONS
} from "./protectedCommandCatalog";
import { POLICY_BUNDLES } from "./rules";

export type OnboardingDiagnosticStatus = "ok" | "info" | "warning";

export interface OnboardingDiagnosticEntry {
  status: OnboardingDiagnosticStatus;
  summary: string;
  details: string[];
}

export interface OnboardingDiagnostics {
  generatedAt: string;
  shellIntegration: OnboardingDiagnosticEntry;
  workspaceTrust: OnboardingDiagnosticEntry;
  proxyKeybindings: OnboardingDiagnosticEntry;
  policyBundles: OnboardingDiagnosticEntry;
}

export function createOnboardingMarkdown(options: {
  isEnabled: boolean;
  isTrustedWorkspace: boolean;
  keybindingInspection: KeybindingInspection;
  diagnostics: OnboardingDiagnostics;
  workspaceApprovalExceptionCount?: number;
}): string {
  const bundleList = Object.values(POLICY_BUNDLES)
    .map((bundle) => `- \`${bundle.id}\`: ${bundle.description}`)
    .join("\n");
  const explicitProxyList = VERIFIED_EXPLICIT_PROXY_COMMAND_DEFINITIONS.map(
    (definition) =>
      `- \`${definition.proxyCommand}\` -> \`${definition.targetCommand}\`: ${definition.reason}`
  ).join("\n");
  const wrapperOnlyList = WRAPPER_ONLY_PROTECTED_COMMAND_DEFINITIONS.map(
    (definition) => `- \`safeExec.runProtectedCommand\` for \`${definition.targetCommand}\`: ${definition.reason}`
  ).join("\n");

  return [
    "# Safe Exec Onboarding",
    "",
    `Protection is currently **${options.isEnabled ? "enabled" : "disabled"}**.`,
    "",
    "## First-Run Diagnostic",
    "",
    `Generated: ${options.diagnostics.generatedAt}`,
    "",
    renderDiagnosticSection("Shell Integration", options.diagnostics.shellIntegration),
    "",
    renderDiagnosticSection("Workspace Trust", options.diagnostics.workspaceTrust),
    "",
    renderDiagnosticSection("Proxy Keybindings", options.diagnostics.proxyKeybindings),
    "",
    renderDiagnosticSection("Selected Policy Bundles", options.diagnostics.policyBundles),
    "",
    "## What Safe Exec Covers",
    "",
    "- Risky terminal commands when VS Code shell integration reports a shell execution start event.",
    "- Explicit Safe Exec proxy and wrapper commands for selected built-in commands.",
    "- Large or sensitive text edits through rollback, diff review, and reapply.",
    "- Best-effort file create, delete, and rename evaluation for supported VS Code file-operation events, with bounded recovery snapshots for supported delete and rename flows.",
    "",
    "## Where Coverage Stops",
    "",
    "- It does not sandbox extensions, shells, or the OS.",
    "- It does not transparently override built-in commands unless you call a Safe Exec proxy or wrapper command.",
    "- It cannot guarantee a risky terminal command never starts, because shell execution events are post-start.",
    "- It only shows terminal approval prompts when VS Code shell integration reports the command.",
    "- It cannot preserve exact shell state when replaying an approved terminal command.",
    "- File operations are not approval-gated today; Safe Exec currently classifies them, snapshots when possible, and records them.",
    "- It does not claim coverage for external disk changes, and VS Code `workspace.fs` operations may bypass file-operation hooks.",
    "- It only restores file operations when Safe Exec captured a bounded snapshot first; oversized files can fall back to metadata-only history, and unsupported or unreadable targets can fall back to observed-only entries.",
    "",
    "## Workspace Trust",
    "",
    options.isTrustedWorkspace
      ? "- This workspace is trusted. Workspace Trust may enable more workspace features, but it is not a security boundary and does not replace Safe Exec approval."
      : "- This workspace is not trusted. Workspace Trust can reduce what VS Code enables automatically, but it is not a sandbox and Safe Exec remains a best-effort guardrail.",
    options.workspaceApprovalExceptionCount && options.workspaceApprovalExceptionCount > 0
      ? `- Safe Exec currently has ${options.workspaceApprovalExceptionCount} saved medium-risk workspace exception(s) for this workspace. Clear them from the Safe Exec menu if this workflow changes.`
      : "- Safe Exec currently has no saved medium-risk workspace exceptions for this workspace.",
    "",
    renderKeybindingSummary(options.keybindingInspection),
    "",
    "## Automation-Heavy Command Coverage",
    "",
    PROTECTED_COMMAND_VERIFICATION_NOTE,
    "",
    "Explicit Safe Exec proxies now cover these documented command IDs:",
    "",
    explicitProxyList,
    "",
    "Wrapper-first commands still stay explicit through `safeExec.runProtectedCommand`:",
    "",
    wrapperOnlyList,
    "",
    "## Policy Bundles",
    "",
    "Safe Exec includes opt-in bundle presets you can enable through rules or settings. They add stack-specific commands and path rules without pretending to cover every tool.",
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
    "- Clear saved medium-risk workspace exceptions if a workflow changes and you want prompts back.",
    "- Keep docs and expectations aligned with the extension's best-effort posture."
  ].join("\n");
}

export function createOnboardingDiagnostics(options: {
  shellIntegrationAvailable: boolean;
  shellIntegrationCheckedWithProbe: boolean;
  isTrustedWorkspace: boolean;
  keybindingInspection: KeybindingInspection;
  selectedPolicyBundleIds: string[];
  unknownPolicyBundleIds: string[];
}): OnboardingDiagnostics {
  const uniqueSelectedBundleIds = Array.from(new Set(options.selectedPolicyBundleIds));
  const shellIntegration: OnboardingDiagnosticEntry = options.shellIntegrationAvailable
    ? {
        status: "ok",
        summary: options.shellIntegrationCheckedWithProbe
          ? "Shell integration was detected during the Safe Exec diagnostic check."
          : "Shell integration has already been detected in this VS Code session.",
        details: [
          "Terminal approval prompts can appear when VS Code reports shell execution start events.",
          "This remains best effort and post-start; Safe Exec still cannot guarantee a command never began."
        ]
      }
    : {
        status: "warning",
        summary: options.shellIntegrationCheckedWithProbe
          ? "Safe Exec did not detect shell integration during the diagnostic check."
          : "Safe Exec has not observed shell integration in this session yet.",
        details: [
          "Risky terminal prompts only appear after VS Code shell integration reports a command start.",
          "Open an integrated terminal and confirm shell integration is enabled if you expect terminal approvals."
        ]
      };

  const workspaceTrust: OnboardingDiagnosticEntry = options.isTrustedWorkspace
    ? {
        status: "ok",
        summary: "This workspace is trusted.",
        details: [
          "Workspace Trust may enable more workspace features.",
          "It is not a sandbox and it does not replace Safe Exec approval."
        ]
      }
    : {
        status: "warning",
        summary: "This workspace is not trusted.",
        details: [
          "Workspace Trust can reduce some automatic workspace behavior.",
          "It is not a sandbox and Safe Exec remains best effort."
        ]
      };

  const proxyKeybindings: OnboardingDiagnosticEntry = {
    status: toOnboardingDiagnosticStatus(getKeybindingDiagnosticSeverity(options.keybindingInspection)),
    summary: summarizeKeybindingInspection(options.keybindingInspection),
    details: options.keybindingInspection.error
      ? [options.keybindingInspection.error]
      : [
          ...options.keybindingInspection.warnings.map((warning) => `Warning: ${warning}`),
          ...options.keybindingInspection.advisories.map((advisory) => `Advisory: ${advisory}`),
          ...(options.keybindingInspection.warnings.length === 0 && options.keybindingInspection.advisories.length === 0
            ? ["No explicit raw guarded keybinding mismatches were found in user keybindings.json."]
            : [])
        ]
  };

  const policyBundles: OnboardingDiagnosticEntry =
    options.unknownPolicyBundleIds.length > 0
      ? {
          status: "warning",
          summary: `Unknown policy bundle IDs are configured: ${options.unknownPolicyBundleIds.join(", ")}.`,
          details: [
            ...options.unknownPolicyBundleIds.map((bundleId) => `Unknown bundle: ${bundleId}`),
            ...(uniqueSelectedBundleIds.length > 0
              ? uniqueSelectedBundleIds.flatMap((bundleId) => {
                  const bundle = POLICY_BUNDLES[bundleId];
                  return bundle ? [`Selected bundle: ${bundle.id} (${bundle.description})`] : [];
                })
              : ["No valid opt-in policy bundles are selected right now."])
          ]
        }
      : uniqueSelectedBundleIds.length > 0
      ? {
          status: "ok",
          summary: `Selected policy bundles: ${uniqueSelectedBundleIds.join(", ")}.`,
          details: uniqueSelectedBundleIds.map((bundleId) => {
            const bundle = POLICY_BUNDLES[bundleId];
            return bundle ? `${bundle.id}: ${bundle.description}` : bundleId;
          })
        }
      : {
          status: "info",
          summary: "No opt-in policy bundles are selected right now.",
          details: ["Enable bundle presets in settings when you want stack-specific command and path coverage."]
        };

  return {
    generatedAt: new Date().toISOString(),
    shellIntegration,
    workspaceTrust,
    proxyKeybindings,
    policyBundles
  };
}

function renderDiagnosticSection(title: string, entry: OnboardingDiagnosticEntry): string {
  return [
    `### ${title}`,
    "",
    `- Status: ${formatDiagnosticStatus(entry.status)}`,
    `- Summary: ${entry.summary}`,
    ...entry.details.map((detail) => `- Detail: ${detail}`)
  ].join("\n");
}

function formatDiagnosticStatus(status: OnboardingDiagnosticStatus): string {
  switch (status) {
    case "ok":
      return "OK";
    case "info":
      return "Info";
    case "warning":
      return "Attention";
  }
}

function toOnboardingDiagnosticStatus(status: "ok" | "info" | "warning"): OnboardingDiagnosticStatus {
  return status;
}
