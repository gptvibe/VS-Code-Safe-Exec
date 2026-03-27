import * as vscode from "vscode";
import type { RiskLevel } from "./rules";

export type ApprovalDecision = "allow" | "allow-workspace" | "deny" | "review" | "details";
export type ApprovalResolution = "allow" | "workspace-exception" | "low-risk-repeat" | "deny";

export interface PermissionRequest {
  title: string;
  source: string;
  risk: RiskLevel;
  summary: string;
  explanation?: string;
  whyFlagged?: string[];
  detail?: string;
  preview?: string;
  previewLanguage?: string;
  actionKey?: string;
  suppressRepeatedApprovedLowRisk?: boolean;
  workspaceTrustOption?: {
    key?: string;
    label?: string;
    description?: string;
  };
  allowLabel?: string;
  denyLabel?: string;
  reviewAction?: {
    label?: string;
    open: () => Promise<void>;
  };
}

export interface ApprovalResult {
  approved: boolean;
  resolution: ApprovalResolution;
}

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

interface StoredWorkspaceApprovalException {
  key: string;
  title: string;
  source: string;
  summary: string;
  recordedAt: string;
}

export interface ApprovalResponder {
  requestDecision(request: PermissionRequest): Promise<ApprovalDecision>;
}

export interface DeferredApprovalHandle {
  resolve: (decision: ApprovalDecision) => void;
  allow: () => void;
  allowInWorkspace: () => void;
  deny: () => void;
  review: () => void;
  details: () => void;
}

const WORKSPACE_APPROVAL_EXCEPTIONS_KEY = "safeExec.workspaceApprovalExceptions.v1";
const MAX_WORKSPACE_APPROVAL_EXCEPTIONS = 100;
const MAX_LOW_RISK_SUPPRESSIONS = 100;

export class PermissionUI {
  private readonly lowRiskSuppressionOrder: string[] = [];
  private readonly lowRiskSuppressions = new Set<string>();

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly responder: ApprovalResponder = new DefaultApprovalResponder(),
    private readonly workspaceState?: Pick<vscode.Memento, "get" | "update">
  ) {}

  public async requestApproval(request: PermissionRequest): Promise<ApprovalResult> {
    const actionKey = normalizeActionKey(request.actionKey);
    const workspaceApprovalKey =
      request.risk === "medium" && actionKey ? this.getWorkspaceApprovalKey(request, actionKey) : undefined;

    if (workspaceApprovalKey && this.hasWorkspaceApprovalException(workspaceApprovalKey)) {
      this.output.appendLine(`[ui] Allowed via workspace exception: ${request.title}`);
      return {
        approved: true,
        resolution: "workspace-exception"
      };
    }

    if (request.risk === "low" && request.suppressRepeatedApprovedLowRisk && actionKey && this.lowRiskSuppressions.has(actionKey)) {
      this.output.appendLine(`[ui] Allowed via low-risk repeat suppression: ${request.title}`);
      return {
        approved: true,
        resolution: "low-risk-repeat"
      };
    }

    while (true) {
      const decision = await this.responder.requestDecision(request);
      if (decision === "allow") {
        if (request.risk === "low" && request.suppressRepeatedApprovedLowRisk && actionKey) {
          this.rememberLowRiskSuppression(actionKey);
        }

        this.output.appendLine(`[ui] Allowed: ${request.title}`);
        return {
          approved: true,
          resolution: "allow"
        };
      }

      if (decision === "allow-workspace") {
        if (!workspaceApprovalKey) {
          continue;
        }

        await this.storeWorkspaceApprovalException(workspaceApprovalKey, request);
        this.output.appendLine(`[ui] Allowed via workspace exception: ${request.title}`);
        return {
          approved: true,
          resolution: "workspace-exception"
        };
      }

      if (decision === "review") {
        if (request.reviewAction) {
          await request.reviewAction.open();
        } else if (request.preview) {
          await this.openPreview(request);
        }

        continue;
      }

      if (decision === "details") {
        await this.openExplanation(request);
        continue;
      }

      this.output.appendLine(`[ui] Denied: ${request.title}`);
      return {
        approved: false,
        resolution: "deny"
      };
    }
  }

  public async clearWorkspaceApprovalExceptions(): Promise<number> {
    const count = Object.keys(this.getStoredWorkspaceApprovalExceptions()).length;
    await this.workspaceState?.update(WORKSPACE_APPROVAL_EXCEPTIONS_KEY, {});
    return count;
  }

  public getWorkspaceApprovalExceptionCount(): number {
    return Object.keys(this.getStoredWorkspaceApprovalExceptions()).length;
  }

  public compareRisk(left: RiskLevel, right: RiskLevel): number {
    return RISK_ORDER[left] - RISK_ORDER[right];
  }

  private getWorkspaceApprovalKey(request: PermissionRequest, actionKey: string): string {
    return normalizeActionKey(request.workspaceTrustOption?.key) ?? actionKey;
  }

  private hasWorkspaceApprovalException(key: string): boolean {
    return Boolean(this.getStoredWorkspaceApprovalExceptions()[key]);
  }

  private getStoredWorkspaceApprovalExceptions(): Record<string, StoredWorkspaceApprovalException> {
    return this.workspaceState?.get<Record<string, StoredWorkspaceApprovalException>>(WORKSPACE_APPROVAL_EXCEPTIONS_KEY, {}) ?? {};
  }

  private async storeWorkspaceApprovalException(key: string, request: PermissionRequest): Promise<void> {
    const nextEntries = Object.values({
      ...this.getStoredWorkspaceApprovalExceptions(),
      [key]: {
        key,
        title: request.title,
        source: request.source,
        summary: request.summary,
        recordedAt: new Date().toISOString()
      }
    })
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
      .slice(-MAX_WORKSPACE_APPROVAL_EXCEPTIONS);

    await this.workspaceState?.update(
      WORKSPACE_APPROVAL_EXCEPTIONS_KEY,
      Object.fromEntries(nextEntries.map((entry) => [entry.key, entry]))
    );
  }

  private rememberLowRiskSuppression(actionKey: string): void {
    if (this.lowRiskSuppressions.has(actionKey)) {
      return;
    }

    this.lowRiskSuppressions.add(actionKey);
    this.lowRiskSuppressionOrder.push(actionKey);

    while (this.lowRiskSuppressionOrder.length > MAX_LOW_RISK_SUPPRESSIONS) {
      const evicted = this.lowRiskSuppressionOrder.shift();
      if (evicted) {
        this.lowRiskSuppressions.delete(evicted);
      }
    }
  }

  private async openExplanation(request: PermissionRequest): Promise<void> {
    const lines = [
      `# ${request.title}`,
      "",
      `- Source: ${request.source}`,
      `- Risk: ${describeRisk(request.risk)}`,
      `- Summary: ${request.summary}`,
      "",
      "## What Safe Exec Is Asking",
      "",
      request.explanation ?? defaultRiskExplanation(request.risk),
      "",
      "## Why Was This Flagged?",
      "",
      ...(request.whyFlagged?.length
        ? request.whyFlagged.map((reason) => `- ${reason}`)
        : ["- Safe Exec matched this action against its configured approval flow and asked before continuing."])
    ];

    if (request.detail) {
      lines.push("");
      lines.push("## Additional Context");
      lines.push("");
      lines.push(request.detail);
    }

    if (request.workspaceTrustOption && request.risk === "medium") {
      lines.push("");
      lines.push("## Workspace Exception");
      lines.push("");
      lines.push(
        request.workspaceTrustOption.description ??
          "Allow In This Workspace creates a Safe Exec exception for this exact medium-risk action in the current workspace only. It does not change VS Code Workspace Trust."
      );
    }

    if (request.reviewAction) {
      lines.push("");
      lines.push("## Review");
      lines.push("");
      lines.push(`Use "${request.reviewAction.label ?? "Review"}" from the prompt to inspect the captured diff or preview before allowing it.`);
    }

    if (request.preview) {
      lines.push("");
      lines.push("## Preview");
      lines.push("");
      lines.push(`\`\`\`${request.previewLanguage ?? "text"}`);
      lines.push(request.preview);
      lines.push("```");
    }

    await this.openMarkdownDocument(lines.join("\n"), "explanation");
  }

  private async openPreview(request: PermissionRequest): Promise<void> {
    const preview = request.preview ?? request.summary;
    const fenceLanguage = request.previewLanguage ?? "text";
    const content = [
      `# ${request.title}`,
      "",
      `- Source: ${request.source}`,
      `- Risk: ${describeRisk(request.risk)}`,
      "",
      "## Summary",
      "",
      request.summary,
      "",
      "## What Safe Exec Is Asking",
      "",
      request.explanation ?? defaultRiskExplanation(request.risk),
      "",
      "## Preview",
      "",
      `\`\`\`${fenceLanguage}`,
      preview,
      "```"
    ].join("\n");

    await this.openMarkdownDocument(content, "preview");
  }

  private async openMarkdownDocument(content: string, kind: "preview" | "explanation"): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content
      });
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[ui] Failed to open ${kind}: ${message}`);
      void vscode.window.showErrorMessage(`Safe Exec failed to open ${kind}: ${message}`);
    }
  }
}

class DefaultApprovalResponder implements ApprovalResponder {
  public async requestDecision(request: PermissionRequest): Promise<ApprovalDecision> {
    const allowLabel = request.allowLabel ?? "Allow";
    const denyLabel = request.denyLabel ?? "Deny";
    const reviewLabel = request.reviewAction?.label ?? (request.preview ? "Open Preview" : undefined);
    const detailsLabel = "Why Was This Flagged?";
    const allowWorkspaceLabel =
      request.risk === "medium" && request.actionKey
        ? request.workspaceTrustOption?.label ?? "Allow In This Workspace"
        : undefined;
    const detailLines = [
      request.title,
      `Source: ${request.source}`,
      `Risk: ${describeRisk(request.risk)}`,
      "",
      request.explanation ?? defaultRiskExplanation(request.risk),
      "",
      "Why Safe Exec flagged this:",
      ...(request.whyFlagged?.slice(0, 4).map((line) => `- ${line}`) ?? [
        "- Safe Exec matched this action against a configured approval path."
      ]),
      request.detail ? "" : undefined,
      request.detail,
      request.workspaceTrustOption && request.risk === "medium"
        ? ""
        : undefined,
      request.workspaceTrustOption && request.risk === "medium"
        ? request.workspaceTrustOption.description ??
          "Allow In This Workspace creates a Safe Exec exception for this exact medium-risk action in the current workspace only. It does not change VS Code Workspace Trust."
        : undefined,
      request.suppressRepeatedApprovedLowRisk && request.risk === "low"
        ? ""
        : undefined,
      request.suppressRepeatedApprovedLowRisk && request.risk === "low"
        ? "Allowing this exact low-risk action once suppresses repeated prompts for identical approved actions in this session."
        : undefined
    ].filter((line): line is string => typeof line === "string" && line.trim().length > 0);

    const actions = [detailsLabel, reviewLabel, allowWorkspaceLabel, allowLabel, denyLabel].filter(
      (action): action is string => Boolean(action)
    );
    const selection =
      request.risk === "low"
        ? await vscode.window.showInformationMessage(
            request.summary,
            {
              modal: false,
              detail: detailLines.join("\n")
            },
            ...actions
          )
        : await vscode.window.showWarningMessage(
            request.summary,
            {
              modal: request.risk === "critical",
              detail: detailLines.join("\n")
            },
            ...actions
          );

    if (selection === detailsLabel) {
      return "details";
    }

    if (selection === allowLabel) {
      return "allow";
    }

    if (allowWorkspaceLabel && selection === allowWorkspaceLabel) {
      return "allow-workspace";
    }

    if (reviewLabel && selection === reviewLabel) {
      return "review";
    }

    return "deny";
  }
}

export class ScriptedApprovalResponder implements ApprovalResponder {
  private readonly decisions: Array<ApprovalDecision | { promise: Promise<ApprovalDecision> }> = [];

  public enqueue(decision: ApprovalDecision): void {
    this.decisions.push(decision);
  }

  public enqueueDeferred(): DeferredApprovalHandle {
    let settled = false;
    let resolveDecision: ((decision: ApprovalDecision) => void) | undefined;
    const promise = new Promise<ApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });

    const resolve = (decision: ApprovalDecision): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolveDecision?.(decision);
    };

    this.decisions.push({ promise });
    return {
      resolve,
      allow: () => resolve("allow"),
      allowInWorkspace: () => resolve("allow-workspace"),
      deny: () => resolve("deny"),
      review: () => resolve("review"),
      details: () => resolve("details")
    };
  }

  public reset(): void {
    this.decisions.length = 0;
  }

  public async requestDecision(): Promise<ApprovalDecision> {
    const next = this.decisions.shift();
    if (!next) {
      return "deny";
    }

    if (typeof next === "string") {
      return next;
    }

    return next.promise;
  }
}

function normalizeActionKey(actionKey: string | undefined): string | undefined {
  const normalized = actionKey?.trim();
  return normalized ? normalized : undefined;
}

function defaultRiskExplanation(risk: RiskLevel): string {
  switch (risk) {
    case "low":
      return "This looks bounded, but Safe Exec is still asking because it matched a configured approval rule.";
    case "medium":
      return "This action can change workspace state or trigger automation, so Safe Exec is asking before it continues.";
    case "high":
      return "This action can execute code, change important files, or affect local or remote state, so Safe Exec wants an explicit decision.";
    case "critical":
      return "This action may be destructive or difficult to recover from. Safe Exec keeps critical prompts modal so they are harder to dismiss accidentally.";
  }
}

function describeRisk(risk: RiskLevel): string {
  return `${risk.toUpperCase()} (${defaultRiskExplanation(risk)})`;
}
