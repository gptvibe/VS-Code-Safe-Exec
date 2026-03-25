import * as vscode from "vscode";
import { AuditLog } from "./auditLog";
import { DiffContentProvider } from "./diffContentProvider";
import { PermissionUI } from "./permissionUI";
import { EditHeuristics, RiskLevel, SafeExecRules, matchesAnyRegexPattern } from "./rules";

interface EditInterceptorOptions {
  output: vscode.OutputChannel;
  permissionUI: PermissionUI;
  auditLog: AuditLog;
  diffContentProvider: DiffContentProvider;
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

interface HandledEditSignature {
  version: number;
  newText: string;
  recordedAt: number;
}

interface SuspiciousEditEvaluation {
  changedCharacters: number;
  affectedLines: number;
  reasons: string[];
  risk: RiskLevel;
}

export class EditInterceptor {
  private static readonly DUPLICATE_SUPPRESSION_WINDOW_MS = 2000;
  private readonly snapshots = new Map<string, DocumentSnapshot>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly mutedDocuments = new Map<string, number>();
  private readonly mutedTexts = new Map<string, string[]>();
  private readonly approvalsInFlight = new Set<string>();
  private readonly recentlyHandledEdits = new Map<string, HandledEditSignature[]>();

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
        this.mutedTexts.delete(key);
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
      this.discardMutedText(key, event.newText);
      this.captureSnapshotFromEvent(event);
      return;
    }

    if (this.consumeMutedText(key, event.newText)) {
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

    if (this.shouldIgnoreDuplicateEvent(key, event)) {
      this.log(`Ignoring duplicate suspicious edit event for ${document.uri.toString()} (version ${event.version}).`);
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
    const evaluation = this.evaluateChange(document, event, heuristics);
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
    this.rememberHandledEdit(key, event);

    try {
      await this.rollbackPromptAndMaybeReapply(document, previousSnapshot, event, evaluation);
    } finally {
      this.approvalsInFlight.delete(key);
    }
  }

  private evaluateChange(
    document: vscode.TextDocument,
    event: CapturedChangeEvent,
    heuristics: EditHeuristics
  ): SuspiciousEditEvaluation | undefined {
    if (event.changes.length === 0) {
      return undefined;
    }

    const targetPath = document.uri.scheme === "file" ? document.uri.fsPath : document.uri.toString();
    if (matchesAnyRegexPattern(heuristics.ignoredPathPatterns, targetPath)) {
      return undefined;
    }

    const reasons: string[] = [];
    const changedCharacters = this.calculateChangedCharacters(event.changes);
    const affectedLines = this.calculateAffectedLines(event.changes);
    const protectedPath = matchesAnyRegexPattern(heuristics.protectedPathPatterns, targetPath);

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
      risk: this.deriveRiskLevel(changedCharacters, affectedLines, heuristics, protectedPath, event.changes.length)
    };
  }

  private async rollbackPromptAndMaybeReapply(
    document: vscode.TextDocument,
    previousSnapshot: DocumentSnapshot,
    event: CapturedChangeEvent,
    evaluation: SuspiciousEditEvaluation
  ): Promise<void> {
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    this.log(`Intercepting suspicious edit in ${document.uri.toString()}: ${evaluation.reasons.join("; ")}`);
    this.options.auditLog.record({
      action: "intercepted",
      surface: "edit",
      source: `edit:${relativePath}`,
      summary: `Rolled back suspicious edit in ${relativePath}`,
      risk: evaluation.risk,
      detail: evaluation.reasons.join("; "),
      metadata: {
        changedCharacters: evaluation.changedCharacters,
        affectedLines: evaluation.affectedLines,
        rangeCount: event.changes.length
      }
    });

    const rolledBack = await this.replaceWholeDocument(document, previousSnapshot.text);
    if (!rolledBack) {
      this.log(`Rollback failed for ${document.uri.toString()}; leaving document as-is.`);
      this.options.auditLog.record({
        action: "failed",
        surface: "edit",
        source: `edit:${relativePath}`,
        summary: `Rollback failed in ${relativePath}`,
        risk: evaluation.risk
      });
      this.captureSnapshot(document);
      return;
    }

    const rolledBackDocument = await vscode.workspace.openTextDocument(document.uri);
    const rollbackSettled = await this.waitForDocumentText(document.uri, previousSnapshot.text);
    if (!rollbackSettled) {
      this.log(`Rollback did not settle for ${document.uri.toString()}; leaving document in the last observed state.`);
      this.options.auditLog.record({
        action: "failed",
        surface: "edit",
        source: `edit:${relativePath}`,
        summary: `Rollback could not be confirmed in ${relativePath}`,
        risk: evaluation.risk
      });
      this.captureSnapshot(rolledBackDocument);
      return;
    }

    const rollbackVersion = rolledBackDocument.version;
    this.captureSnapshot(rolledBackDocument);

    const diffSession = this.options.diffContentProvider.createSession({
      resource: document.uri,
      title: `Safe Exec Review: ${relativePath}`,
      before: previousSnapshot.text,
      after: event.newText
    });

    const approved = await (async () => {
      try {
        return await this.options.permissionUI.requestApproval({
          title: "Reapply suspicious edit?",
          source: `edit:${relativePath}`,
          risk: evaluation.risk,
          summary: `Safe Exec rolled back a large or sensitive edit in ${relativePath}.`,
          detail: [
            `Reasons: ${evaluation.reasons.join("; ")}`,
            `Changed characters: ${evaluation.changedCharacters}`,
            `Affected lines: ${evaluation.affectedLines}`,
            "This is a post-change rollback flow. VS Code applied the edit first, Safe Exec restored the previous snapshot, and approval reapplies the captured change."
          ].join("\n"),
          reviewAction: {
            label: "Open Diff",
            open: async () => {
              await this.options.diffContentProvider.openDiff(diffSession);
            }
          },
          allowLabel: "Reapply Edit",
          denyLabel: "Keep Rollback"
        });
      } finally {
        diffSession.dispose();
      }
    })();

    const currentDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === document.uri.toString());
    if (!currentDocument) {
      return;
    }

    if (!approved) {
      this.log(`Denied suspicious edit in ${document.uri.toString()}.`);
      this.options.auditLog.record({
        action: "denied",
        surface: "edit",
        source: `edit:${relativePath}`,
        summary: `Kept rollback in ${relativePath}`,
        risk: evaluation.risk
      });
      this.captureSnapshot(currentDocument);
      return;
    }

    this.options.auditLog.record({
      action: "approved",
      surface: "edit",
      source: `edit:${relativePath}`,
      summary: `Approved suspicious edit in ${relativePath}`,
      risk: evaluation.risk
    });

    if (currentDocument.version !== rollbackVersion) {
      const message = `Safe Exec kept the rollback for ${relativePath} because the document changed while approval was pending. Review the diff and reapply manually if you still want it.`;
      this.log(`Skipping reapply for ${document.uri.toString()} because the document changed during approval.`);
      this.options.auditLog.record({
        action: "conflict",
        surface: "edit",
        source: `edit:${relativePath}`,
        summary: `Skipped reapply in ${relativePath} after a conflicting edit`,
        risk: evaluation.risk
      });
      void vscode.window.showWarningMessage(message, { modal: true });
      this.captureSnapshot(currentDocument);
      return;
    }

    const reapplied = await this.reapplyCapturedChanges(currentDocument, event);
    if (!reapplied) {
      this.log(`Failed to reapply approved edit for ${document.uri.toString()}.`);
      this.options.auditLog.record({
        action: "failed",
        surface: "edit",
        source: `edit:${relativePath}`,
        summary: `Failed to reapply approved edit in ${relativePath}`,
        risk: evaluation.risk
      });
      this.captureSnapshot(currentDocument);
      return;
    }

    this.log(`Reapplied approved edit in ${document.uri.toString()}.`);
    const refreshedDocument = await vscode.workspace.openTextDocument(document.uri);
    this.captureSnapshot(refreshedDocument);
  }

  private async reapplyCapturedChanges(document: vscode.TextDocument, event: CapturedChangeEvent): Promise<boolean> {
    const key = this.getKey(document.uri);
    const edit = new vscode.WorkspaceEdit();
    for (const change of event.changes) {
      edit.replace(document.uri, change.range, change.text);
    }

    this.queueMutedText(key, event.newText);
    this.incrementMute(key);
    const appliedRanges = await vscode.workspace.applyEdit(edit);
    if (appliedRanges) {
      return this.waitForDocumentText(document.uri, event.newText);
    }

    this.decrementMute(key);
    this.discardMutedText(key, event.newText);
    return this.replaceWholeDocument(document, event.newText);
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

  private async replaceWholeDocument(document: vscode.TextDocument, text: string): Promise<boolean> {
    if (document.getText() === text) {
      return true;
    }

    const key = this.getKey(document.uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);

    this.queueMutedText(key, text);
    this.incrementMute(key);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.decrementMute(key);
      this.discardMutedText(key, text);
      return false;
    }

    return this.waitForDocumentText(document.uri, text);
  }

  private async waitForDocumentText(uri: vscode.Uri, expectedText: string, timeoutMs = 1000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const currentDocument = await vscode.workspace.openTextDocument(uri);
      if (currentDocument.getText() === expectedText) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return false;
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

  private queueMutedText(key: string, text: string): void {
    const queued = this.mutedTexts.get(key) ?? [];
    queued.push(text);
    this.mutedTexts.set(key, queued);
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

  private consumeMutedText(key: string, text: string): boolean {
    const queued = this.mutedTexts.get(key);
    if (!queued || queued.length === 0) {
      return false;
    }

    const index = queued.indexOf(text);
    if (index < 0) {
      return false;
    }

    queued.splice(index, 1);
    if (queued.length === 0) {
      this.mutedTexts.delete(key);
    } else {
      this.mutedTexts.set(key, queued);
    }

    return true;
  }

  private discardMutedText(key: string, text: string): void {
    void this.consumeMutedText(key, text);
  }

  private rememberHandledEdit(key: string, event: CapturedChangeEvent): void {
    const now = Date.now();
    const activeEntries = (this.recentlyHandledEdits.get(key) ?? []).filter(
      (entry) => now - entry.recordedAt < EditInterceptor.DUPLICATE_SUPPRESSION_WINDOW_MS
    );
    activeEntries.push({
      version: event.version,
      newText: event.newText,
      recordedAt: now
    });
    this.recentlyHandledEdits.set(key, activeEntries.slice(-6));
  }

  private shouldIgnoreDuplicateEvent(key: string, event: CapturedChangeEvent): boolean {
    const now = Date.now();
    const activeEntries = (this.recentlyHandledEdits.get(key) ?? []).filter(
      (entry) => now - entry.recordedAt < EditInterceptor.DUPLICATE_SUPPRESSION_WINDOW_MS
    );

    if (activeEntries.length === 0) {
      this.recentlyHandledEdits.delete(key);
      return false;
    }

    this.recentlyHandledEdits.set(key, activeEntries);
    return activeEntries.some(
      (entry) => entry.newText === event.newText && event.version >= entry.version && event.version <= entry.version + 3
    );
  }

  private getKey(uri: vscode.Uri): string {
    return uri.toString();
  }

  private log(message: string): void {
    this.options.output.appendLine(`[edit] ${message}`);
  }
}
