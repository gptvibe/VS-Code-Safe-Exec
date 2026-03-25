import * as vscode from "vscode";
import { RiskLevel } from "./rules";

export type ApprovalDecision = "allow" | "deny" | "review";

export interface PermissionRequest {
  title: string;
  source: string;
  risk: RiskLevel;
  summary: string;
  detail?: string;
  preview?: string;
  previewLanguage?: string;
  allowLabel?: string;
  denyLabel?: string;
  reviewAction?: {
    label?: string;
    open: () => Promise<void>;
  };
}

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export interface ApprovalResponder {
  requestDecision(request: PermissionRequest): Promise<ApprovalDecision>;
}

export interface DeferredApprovalHandle {
  resolve: (decision: ApprovalDecision) => void;
  allow: () => void;
  deny: () => void;
  review: () => void;
}

export class PermissionUI {
  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly responder: ApprovalResponder = new ModalApprovalResponder()
  ) {}

  public async requestApproval(request: PermissionRequest): Promise<boolean> {
    while (true) {
      const decision = await this.responder.requestDecision(request);
      if (decision === "allow") {
        this.output.appendLine(`[ui] Allowed: ${request.title}`);
        return true;
      }

      if (decision === "review") {
        if (request.reviewAction) {
          await request.reviewAction.open();
        } else if (request.preview) {
          await this.openPreview(request);
        }

        continue;
      }

      this.output.appendLine(`[ui] Denied: ${request.title}`);
      return false;
    }
  }

  public compareRisk(left: RiskLevel, right: RiskLevel): number {
    return RISK_ORDER[left] - RISK_ORDER[right];
  }

  private async openPreview(request: PermissionRequest): Promise<void> {
    const preview = request.preview ?? request.summary;
    const fenceLanguage = request.previewLanguage ?? "text";
    const content = [
      `# ${request.title}`,
      "",
      `- Source: ${request.source}`,
      `- Risk: ${request.risk.toUpperCase()}`,
      "",
      "## Summary",
      "",
      request.summary,
      "",
      "## Preview",
      "",
      `\`\`\`${fenceLanguage}`,
      preview,
      "```"
    ].join("\n");

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
      this.output.appendLine(`[ui] Failed to open preview: ${message}`);
      void vscode.window.showErrorMessage(`Safe Exec failed to open preview: ${message}`);
    }
  }
}

class ModalApprovalResponder implements ApprovalResponder {
  public async requestDecision(request: PermissionRequest): Promise<ApprovalDecision> {
    const allowLabel = request.allowLabel ?? "Allow";
    const denyLabel = request.denyLabel ?? "Deny";
    const reviewLabel = request.reviewAction?.label ?? (request.preview ? "Open Preview" : undefined);
    const detailLines = [
      request.title,
      `Source: ${request.source}`,
      `Risk: ${request.risk.toUpperCase()}`,
      request.detail ?? ""
    ].filter((line) => line.trim().length > 0);

    const actions = reviewLabel ? [reviewLabel, allowLabel, denyLabel] : [allowLabel, denyLabel];
    const selection = await vscode.window.showWarningMessage(
      request.summary,
      {
        modal: true,
        detail: detailLines.join("\n")
      },
      ...actions
    );

    if (selection === allowLabel) {
      return "allow";
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
      deny: () => resolve("deny"),
      review: () => resolve("review")
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
