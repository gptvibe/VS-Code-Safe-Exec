import * as vscode from "vscode";
import { RiskLevel } from "./rules";

export type AuditSurface = "terminal" | "edit" | "command" | "workspace" | "onboarding";
export type AuditAction =
  | "matched"
  | "intercepted"
  | "interrupted"
  | "interrupted-attempted"
  | "dispose-attempted"
  | "approved"
  | "reviewed"
  | "range-based"
  | "whole-document-fallback"
  | "replayed"
  | "replay-degraded"
  | "replay-failed"
  | "denied"
  | "failed-to-stop"
  | "failed"
  | "conflict"
  | "conflict-cancelled"
  | "status";

export interface AuditEvent {
  id: string;
  action: AuditAction;
  surface: AuditSurface;
  source: string;
  summary: string;
  recordedAt: string;
  risk?: RiskLevel;
  detail?: string;
  workspaceId: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface AuditEventInput {
  action: AuditAction;
  surface: AuditSurface;
  source: string;
  summary: string;
  risk?: RiskLevel;
  detail?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

const HISTORY_KEY = "safeExec.auditHistory.v1";
const MAX_EVENTS = 200;

export class AuditLog {
  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly workspaceState?: vscode.Memento
  ) {}

  public record(input: AuditEventInput): AuditEvent {
    const event: AuditEvent = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      action: input.action,
      surface: input.surface,
      source: input.source,
      summary: input.summary,
      recordedAt: new Date().toISOString(),
      risk: input.risk,
      detail: input.detail,
      workspaceId: getWorkspaceId(),
      metadata: sanitizeMetadata(input.metadata)
    };

    this.output.appendLine(`[audit] ${JSON.stringify(event)}`);
    void this.persist(event);
    return event;
  }

  public getRecentEvents(limit = 50): AuditEvent[] {
    const history = this.workspaceState?.get<AuditEvent[]>(HISTORY_KEY, []) ?? [];
    return history.slice(Math.max(0, history.length - limit)).reverse();
  }

  public async clear(): Promise<void> {
    if (!this.workspaceState) {
      return;
    }

    await this.workspaceState.update(HISTORY_KEY, []);
  }

  public renderMarkdown(limit = 50): string {
    const events = this.getRecentEvents(limit);
    const lines = [
      "# Safe Exec Recent Activity",
      "",
      "This is local extension history for the current workspace. It is best effort and not tamper-proof.",
      ""
    ];

    if (events.length === 0) {
      lines.push("No recent Safe Exec events were recorded in this workspace.");
      return lines.join("\n");
    }

    for (const event of events) {
      lines.push(`## ${event.action} · ${event.surface}`);
      lines.push("");
      lines.push(`- Time: ${event.recordedAt}`);
      lines.push(`- Source: ${event.source}`);
      lines.push(`- Summary: ${event.summary}`);
      lines.push(`- Workspace: ${event.workspaceId}`);
      if (event.risk) {
        lines.push(`- Risk: ${event.risk.toUpperCase()}`);
      }

      if (event.detail) {
        lines.push(`- Detail: ${event.detail}`);
      }

      if (event.metadata && Object.keys(event.metadata).length > 0) {
        lines.push(
          `- Metadata: ${Object.entries(event.metadata)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", ")}`
        );
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  private async persist(event: AuditEvent): Promise<void> {
    if (!this.workspaceState) {
      return;
    }

    const existing = this.workspaceState.get<AuditEvent[]>(HISTORY_KEY, []);
    const next = [...existing, event].slice(-MAX_EVENTS);
    await this.workspaceState.update(HISTORY_KEY, next);
  }
}

function sanitizeMetadata(
  metadata: Record<string, string | number | boolean | undefined> | undefined
): Record<string, string | number | boolean> | undefined {
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function getWorkspaceId(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return "no-workspace";
  }

  return workspaceFolders.map((folder) => folder.uri.toString()).join("|");
}
