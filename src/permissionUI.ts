import * as vscode from "vscode";
import { RiskLevel } from "./rules";

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
}

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export class PermissionUI {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public async requestApproval(request: PermissionRequest): Promise<boolean> {
    const allowLabel = request.allowLabel ?? "Allow";
    const denyLabel = request.denyLabel ?? "Deny";
    const previewLabel = request.preview ? "Open Preview" : undefined;

    while (true) {
      const detailLines = [
        request.title,
        `Source: ${request.source}`,
        `Risk: ${request.risk.toUpperCase()}`,
        request.detail ?? ""
      ].filter((line) => line.trim().length > 0);

      const selection = await vscode.window.showWarningMessage(
        request.summary,
        {
          modal: true,
          detail: detailLines.join("\n")
        },
        allowLabel,
        ...(previewLabel ? [previewLabel] : []),
        denyLabel
      );

      if (selection === allowLabel) {
        this.output.appendLine(`[ui] Allowed: ${request.title}`);
        return true;
      }

      if (selection === previewLabel && request.preview) {
        await this.openPreview(request);
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
