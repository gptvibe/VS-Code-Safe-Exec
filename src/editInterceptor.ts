import * as vscode from "vscode";
import { PermissionUI } from "./permissionUI";
import { EditHeuristics, RiskLevel, SafeExecRules, matchesAnyRegexPattern } from "./rules";

interface EditInterceptorOptions {
  output: vscode.OutputChannel;
  permissionUI: PermissionUI;
  getRules: () => SafeExecRules;
  isEnabled: () => boolean;
}

interface DocumentSnapshot {
  text: string;
  version: number;
}

interface CapturedContentChange {
  range: vscode.Range;
  rangeLength: number;
  text: string;
}

interface CapturedChangeEvent {
  uri: vscode.Uri;
  version: number;
  languageId: string;
  newText: string;
  changes: CapturedContentChange[];
}

interface SuspiciousEditEvaluation {
  changedCharacters: number;
  affectedLines: number;
  reasons: string[];
  risk: RiskLevel;
  preview: string;
}

export class EditInterceptor {
  private readonly snapshots = new Map<string, DocumentSnapshot>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly mutedDocuments = new Map<string, number>();
  private readonly approvalsInFlight = new Set<string>();

  public constructor(private readonly options: EditInterceptorOptions) {}

  public register(): vscode.Disposable {
    for (const document of vscode.workspace.textDocuments) {
      this.captureSnapshot(document);
    }

    return vscode.Disposable.from(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.captureSnapshot(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const key = this.getKey(document.uri);
        this.snapshots.delete(key);
        this.queues.delete(key);
        this.mutedDocuments.delete(key);
        this.approvalsInFlight.delete(key);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const captured = this.captureChangeEvent(event);
        this.enqueue(captured);
      })
    );
  }

  private enqueue(event: CapturedChangeEvent): void {
    const key = this.getKey(event.uri);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.processChange(event))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Unexpected edit processing failure for ${event.uri.toString()}: ${message}`);
      });

    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    });
  }

  private captureChangeEvent(event: vscode.TextDocumentChangeEvent): CapturedChangeEvent {
    return {
      uri: event.document.uri,
      version: event.document.version,
      languageId: event.document.languageId,
      newText: event.document.getText(),
      changes: event.contentChanges.map((change) => ({
        range: change.range,
        rangeLength: change.rangeLength,
        text: change.text
      }))
    };
  }

  private async processChange(event: CapturedChangeEvent): Promise<void> {
    const key = this.getKey(event.uri);

    if (this.consumeMute(key)) {
      this.captureSnapshotFromEvent(event);
      return;
    }

    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === event.uri.toString());
    if (!document) {
      this.captureSnapshotFromEvent(event);
      return;
    }

    if (!this.isSupportedDocument(document)) {
      this.captureSnapshot(document);
      return;
    }

    if (!this.options.isEnabled()) {
      this.captureSnapshot(document);
      return;
    }

    const previousSnapshot = this.snapshots.get(key);
    if (!previousSnapshot) {
      this.captureSnapshot(document);
      return;
    }

    if (document.version !== event.version) {
      this.log(`Skipping stale change event for ${document.uri.toString()} (${event.version} != ${document.version}).`);
      this.captureSnapshot(document);
      return;
    }

    const heuristics = this.options.getRules().editHeuristics;
    const evaluation = this.evaluateChange(document, previousSnapshot.text, event, heuristics);
    if (!evaluation) {
      this.captureSnapshot(document);
      return;
    }

    if (this.approvalsInFlight.has(key)) {
      this.log(`Approval already in flight for ${document.uri.toString()}; accepting latest state as snapshot.`);
      this.captureSnapshot(document);
      return;
    }

    this.approvalsInFlight.add(key);

    try {
      await this.rollbackPromptAndMaybeReapply(document, previousSnapshot, event, evaluation);
    } finally {
      this.approvalsInFlight.delete(key);
    }
  }

  private evaluateChange(
    document: vscode.TextDocument,
    previousText: string,
    event: CapturedChangeEvent,
    heuristics: EditHeuristics
  ): SuspiciousEditEvaluation | undefined {
    if (event.changes.length === 0) {
      return undefined;
    }

    const path = document.uri.scheme === "file" ? document.uri.fsPath : document.uri.toString();
    if (matchesAnyRegexPattern(heuristics.ignoredPathPatterns, path)) {
      return undefined;
    }

    const reasons: string[] = [];
    const changedCharacters = this.calculateChangedCharacters(event.changes);
    const affectedLines = this.calculateAffectedLines(event.changes);
    const protectedPath = matchesAnyRegexPattern(heuristics.protectedPathPatterns, path);

    if (changedCharacters >= heuristics.minChangedCharacters) {
      reasons.push(`changed ${changedCharacters} characters`);
    }

    if (affectedLines >= heuristics.minAffectedLines) {
      reasons.push(`touched ${affectedLines} lines`);
    }

    if (event.changes.length >= heuristics.multipleChangeCount) {
      reasons.push(`used ${event.changes.length} separate edit ranges`);
    }

    if (protectedPath) {
      reasons.push("matched a protected path rule");
    }

    if (reasons.length === 0) {
      return undefined;
    }

    return {
      changedCharacters,
      affectedLines,
      reasons,
      risk: this.deriveRiskLevel(changedCharacters, affectedLines, heuristics, protectedPath, event.changes.length),
      preview: this.buildPreview(previousText, event.newText, changedCharacters, affectedLines, heuristics.maxPreviewCharacters)
    };
  }

  private async rollbackPromptAndMaybeReapply(
    document: vscode.TextDocument,
    previousSnapshot: DocumentSnapshot,
    event: CapturedChangeEvent,
    evaluation: SuspiciousEditEvaluation
  ): Promise<void> {
    this.log(`Intercepting suspicious edit in ${document.uri.toString()}: ${evaluation.reasons.join("; ")}`);

    const rolledBack = await this.replaceWholeDocument(document, previousSnapshot.text);
    if (!rolledBack) {
      this.log(`Rollback failed for ${document.uri.toString()}; leaving document as-is.`);
      this.captureSnapshot(document);
      return;
    }

    const rolledBackDocument = await vscode.workspace.openTextDocument(document.uri);
    const rollbackVersion = rolledBackDocument.version;
    this.captureSnapshot(rolledBackDocument);

    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const approved = await this.options.permissionUI.requestApproval({
      title: "Reapply suspicious edit?",
      source: `edit:${relativePath}`,
      risk: evaluation.risk,
      summary: `Safe Exec rolled back a large or sensitive edit in ${relativePath}.`,
      detail: [
        `Reasons: ${evaluation.reasons.join("; ")}`,
        "This is a post-change rollback flow. VS Code applied the edit first, Safe Exec restored the previous snapshot, and approval reapplies the exact change."
      ].join("\n"),
      preview: evaluation.preview,
      previewLanguage: "markdown",
      allowLabel: "Reapply Edit",
      denyLabel: "Keep Rollback"
    });

    const currentDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === document.uri.toString());
    if (!currentDocument) {
      return;
    }

    if (!approved) {
      this.log(`Denied suspicious edit in ${document.uri.toString()}.`);
      this.captureSnapshot(currentDocument);
      return;
    }

    if (currentDocument.version !== rollbackVersion) {
      this.log(`Skipping reapply for ${document.uri.toString()} because the document changed during approval.`);
      this.captureSnapshot(currentDocument);
      return;
    }

    const reapplied = await this.replaceWholeDocument(currentDocument, event.newText);
    if (!reapplied) {
      this.log(`Failed to reapply approved edit for ${document.uri.toString()}.`);
      this.captureSnapshot(currentDocument);
      return;
    }

    this.log(`Reapplied approved edit in ${document.uri.toString()}.`);
  }

  private calculateChangedCharacters(changes: readonly CapturedContentChange[]): number {
    return changes.reduce((total, change) => total + change.rangeLength + change.text.length, 0);
  }

  private calculateAffectedLines(changes: readonly CapturedContentChange[]): number {
    return changes.reduce((total, change) => {
      const removedLines = Math.max(1, change.range.end.line - change.range.start.line + 1);
      const addedLines = Math.max(1, change.text.split(/\r\n|\r|\n/).length);
      return total + Math.max(removedLines, addedLines);
    }, 0);
  }

  private deriveRiskLevel(
    changedCharacters: number,
    affectedLines: number,
    heuristics: EditHeuristics,
    protectedPath: boolean,
    changeCount: number
  ): RiskLevel {
    if (protectedPath && (changedCharacters >= heuristics.minChangedCharacters * 2 || affectedLines >= heuristics.minAffectedLines * 2)) {
      return "critical";
    }

    if (protectedPath || changeCount >= heuristics.multipleChangeCount + 2) {
      return "high";
    }

    if (changedCharacters >= heuristics.minChangedCharacters * 3 || affectedLines >= heuristics.minAffectedLines * 3) {
      return "high";
    }

    return "medium";
  }

  private buildPreview(
    previousText: string,
    newText: string,
    changedCharacters: number,
    affectedLines: number,
    maxPreviewCharacters: number
  ): string {
    return [
      `Changed characters: ${changedCharacters}`,
      `Affected lines: ${affectedLines}`,
      "",
      "## Before",
      "",
      "```text",
      this.truncate(previousText, maxPreviewCharacters),
      "```",
      "",
      "## After",
      "",
      "```text",
      this.truncate(newText, maxPreviewCharacters),
      "```"
    ].join("\n");
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    const headLength = Math.floor(maxLength / 2);
    const tailLength = maxLength - headLength;
    return `${value.slice(0, headLength)}\n\n... preview truncated ...\n\n${value.slice(value.length - tailLength)}`;
  }

  private async replaceWholeDocument(document: vscode.TextDocument, text: string): Promise<boolean> {
    if (document.getText() === text) {
      return true;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);

    this.incrementMute(this.getKey(document.uri));
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.decrementMute(this.getKey(document.uri));
      return false;
    }

    return true;
  }

  private captureSnapshot(document: vscode.TextDocument): void {
    if (!this.isSupportedDocument(document)) {
      return;
    }

    this.snapshots.set(this.getKey(document.uri), {
      text: document.getText(),
      version: document.version
    });
  }

  private captureSnapshotFromEvent(event: CapturedChangeEvent): void {
    this.snapshots.set(this.getKey(event.uri), {
      text: event.newText,
      version: event.version
    });
  }

  private isSupportedDocument(document: vscode.TextDocument): boolean {
    return ["file", "untitled"].includes(document.uri.scheme);
  }

  private incrementMute(key: string): void {
    this.mutedDocuments.set(key, (this.mutedDocuments.get(key) ?? 0) + 1);
  }

  private decrementMute(key: string): void {
    const current = this.mutedDocuments.get(key);
    if (!current) {
      return;
    }

    if (current === 1) {
      this.mutedDocuments.delete(key);
      return;
    }

    this.mutedDocuments.set(key, current - 1);
  }

  private consumeMute(key: string): boolean {
    const current = this.mutedDocuments.get(key);
    if (!current) {
      return false;
    }

    this.decrementMute(key);
    return true;
  }

  private getKey(uri: vscode.Uri): string {
    return uri.toString();
  }

  private log(message: string): void {
    this.options.output.appendLine(`[edit] ${message}`);
  }
}
