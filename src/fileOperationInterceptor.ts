import type { Dirent } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { AuditLog } from "./auditLog";
import type {
  FileOperationKind,
  FileOperationRecord,
  FileOperationRecordInput,
  FileOperationRecoveryStore,
  FileOperationSnapshotInput,
  RestorePreviewResult
} from "./fileOperationRecoveryStore";
import { matchesAnyCompiledRegexPattern, matchesSensitivePath } from "./rules";
import type { CompiledRules, RiskLevel } from "./rules";

interface FileOperationInterceptorOptions {
  output: vscode.OutputChannel;
  auditLog: AuditLog;
  recoveryStore: FileOperationRecoveryStore;
  getRules: () => CompiledRules;
  isEnabled: () => boolean;
  showUserNotices: boolean;
}

interface PreparedFileOperation {
  record: FileOperationRecordInput;
  source: string;
}

interface OperationEntryEvaluation {
  snapshot: FileOperationSnapshotInput;
  protectedPath: boolean;
  sensitiveMatch: boolean;
  ignoredPath: boolean;
}

interface OperationEvaluationSummary {
  fileCount: number;
  protectedCount: number;
  bulk: boolean;
  subtree: boolean;
  renameAwayProtectedCount: number;
  reasons: string[];
  risk: RiskLevel;
}

interface DirectoryWalkResult {
  entries: OperationEntryEvaluation[];
  fileCount: number;
  truncated: boolean;
}

const COVERAGE_NOTE =
  "Best-effort preflight via VS Code file-operation events. This path does not cover external disk changes, and workspace.fs operations may bypass this hook.";

export class FileOperationInterceptor {
  private readonly pendingOperations = new Map<string, string[]>();

  public constructor(private readonly options: FileOperationInterceptorOptions) {}

  public register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.workspace.onWillCreateFiles((event) => {
        event.waitUntil(this.handleWillCreate(event));
      }),
      vscode.workspace.onWillDeleteFiles((event) => {
        event.waitUntil(this.handleWillDelete(event));
      }),
      vscode.workspace.onWillRenameFiles((event) => {
        event.waitUntil(this.handleWillRename(event));
      }),
      vscode.workspace.onDidCreateFiles((event) => {
        void this.handleDidCreate(event);
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        void this.handleDidDelete(event);
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        void this.handleDidRename(event);
      })
    );
  }

  public async renderRecentOperationsMarkdown(): Promise<string> {
    return this.options.recoveryStore.renderMarkdown();
  }

  public async restoreLastRecoverableOperation(): Promise<void> {
    const operation = await this.options.recoveryStore.getLastRecoverableOperation();
    if (!operation) {
      void vscode.window.showInformationMessage(
        "Safe Exec has no recoverable file operations in this workspace yet."
      );
      return;
    }

    await this.restoreOperation(operation);
  }

  public async browseRecoverableOperations(): Promise<void> {
    const operations = await this.options.recoveryStore.getRecoverableOperations(20);
    if (operations.length === 0) {
      void vscode.window.showInformationMessage(
        "Safe Exec has no recoverable file operations in this workspace yet."
      );
      return;
    }

    const previews = new Map<string, RestorePreviewResult>();
    await Promise.all(
      operations.map(async (operation) => {
        previews.set(operation.id, await this.options.recoveryStore.previewRestoreOperation(operation.id, 4));
      })
    );

    const selection = await vscode.window.showQuickPick(
      operations.map((operation) => ({
        label: `${operation.kind}: ${operation.summary}`,
        description: `${operation.risk.toUpperCase()} · ${operation.snapshotCount} snapshot(s)${
          previews.get(operation.id)?.partial ? " · partial restore" : ""
        }`,
        detail: [previews.get(operation.id)?.summary, operation.bestEffortNote ?? operation.detail].filter(Boolean).join(" · "),
        operation
      })),
      {
        title: "Recoverable File Operations",
        placeHolder: "Choose a file operation to restore",
        ignoreFocusOut: true
      }
    );

    if (!selection) {
      return;
    }

    await this.restoreOperation(selection.operation);
  }

  public async clearForTesting(): Promise<void> {
    this.pendingOperations.clear();
    await this.options.recoveryStore.clear();
  }

  private async handleWillCreate(event: vscode.FileWillCreateEvent): Promise<void> {
    if (!this.shouldHandleFileOps()) {
      return;
    }

    const prepared = this.prepareCreateOperation(event.files);
    const saved = await this.options.recoveryStore.saveOperation(prepared.record);
    this.recordPreflightEvents(saved, prepared.source, false);
    this.pushPendingOperation(this.getCreateDeleteKey("create", event.files), saved.id);
  }

  private async handleWillDelete(event: vscode.FileWillDeleteEvent): Promise<void> {
    if (!this.shouldHandleFileOps()) {
      return;
    }

    const prepared = await this.prepareDeleteOperation(event.files);
    const saved = await this.options.recoveryStore.saveOperation(prepared.record);
    this.recordPreflightEvents(saved, prepared.source, true);
    this.pushPendingOperation(this.getCreateDeleteKey("delete", event.files), saved.id);
  }

  private async handleWillRename(event: vscode.FileWillRenameEvent): Promise<void> {
    if (!this.shouldHandleFileOps()) {
      return;
    }

    const prepared = await this.prepareRenameOperation(event.files);
    const saved = await this.options.recoveryStore.saveOperation(prepared.record);
    this.recordPreflightEvents(saved, prepared.source, true);
    this.pushPendingOperation(this.getRenameKey(event.files), saved.id);
  }

  private async handleDidCreate(event: vscode.FileCreateEvent): Promise<void> {
    if (!this.shouldHandleFileOps()) {
      return;
    }

    await this.completeOperation("create", this.getCreateDeleteKey("create", event.files), `create:${this.describeCreateDelete(event.files, "create")}`);
  }

  private async handleDidDelete(event: vscode.FileDeleteEvent): Promise<void> {
    if (!this.shouldHandleFileOps()) {
      return;
    }

    await this.completeOperation("delete", this.getCreateDeleteKey("delete", event.files), `delete:${this.describeCreateDelete(event.files, "delete")}`);
  }

  private async handleDidRename(event: vscode.FileRenameEvent): Promise<void> {
    if (!this.shouldHandleFileOps()) {
      return;
    }

    await this.completeOperation("rename", this.getRenameKey(event.files), `rename:${this.describeRename(event.files)}`);
  }

  private async completeOperation(kind: FileOperationKind, key: string, fallbackSummary: string): Promise<void> {
    const operationId = this.consumePendingOperation(key);
    let operation = operationId
      ? await this.options.recoveryStore.updateOperation(operationId, {
          status: "completed",
          completedAt: new Date().toISOString()
        })
      : undefined;

    if (!operation) {
      operation = await this.options.recoveryStore.saveOperation({
        kind,
        risk: kind === "create" ? "low" : "medium",
        summary: fallbackSummary,
        detail: "Safe Exec observed the completed file operation, but no matching preflight record was available.",
        fileCount: 0,
        protectedCount: 0,
        bulk: false,
        subtree: false,
        status: "completed",
        bestEffortNote: COVERAGE_NOTE,
        files: []
      });
    }

    this.options.auditLog.record({
      action: kind,
      surface: "file",
      source: `file:onDid${capitalize(kind)}Files`,
      summary: operation.summary,
      risk: operation.risk,
      detail: operation.detail ?? operation.bestEffortNote,
      metadata: {
        operationId: operation.id,
        fileCount: operation.fileCount,
        snapshotCount: operation.snapshotCount,
        metadataOnlyCount: operation.metadataOnlyCount,
        recoverable: operation.recoverable
      }
    });

    await this.maybeShowOperationNotice(operation);
  }

  private async restoreOperation(operation: FileOperationRecord): Promise<void> {
    this.options.auditLog.record({
      action: "restore-started",
      surface: "file",
      source: `file:restore:${operation.kind}`,
      summary: operation.summary,
      risk: operation.risk,
      metadata: {
        operationId: operation.id
      }
    });

    const result = await this.options.recoveryStore.restoreOperation(operation.id);
    if (result.failedCount > 0 && result.restoredCount === 0) {
      this.options.auditLog.record({
        action: "restore-failed",
        surface: "file",
        source: `file:restore:${operation.kind}`,
        summary: operation.summary,
        risk: operation.risk,
        detail: result.failureDetails.join("; "),
        metadata: {
          operationId: operation.id,
          failedCount: result.failedCount,
          restoredCount: result.restoredCount
        }
      });
      void vscode.window.showWarningMessage(
        `Safe Exec could not restore "${operation.summary}". ${result.failureDetails.join(" ")}`
      );
      return;
    }

    this.options.auditLog.record({
      action: "restored",
      surface: "file",
      source: `file:restore:${operation.kind}`,
      summary: operation.summary,
      risk: operation.risk,
      detail: result.warnings.join("; ") || result.failureDetails.join("; ") || "Restore completed.",
      metadata: {
        operationId: operation.id,
        restoredCount: result.restoredCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount
      }
    });

    const detail = result.warnings[0] ?? (result.failedCount > 0 ? result.failureDetails[0] : undefined);
    void vscode.window.showInformationMessage(
      detail
        ? `Safe Exec restored "${operation.summary}". ${detail}`
        : `Safe Exec restored "${operation.summary}".`
    );
  }

  private recordPreflightEvents(operation: FileOperationRecord, source: string, intercepted: boolean): void {
    this.options.auditLog.record({
      action: intercepted ? "intercepted" : "evaluated",
      surface: "file",
      source,
      summary: operation.summary,
      risk: operation.risk,
      detail: operation.detail ?? operation.bestEffortNote,
      metadata: {
        operationId: operation.id,
        fileCount: operation.fileCount,
        protectedCount: operation.protectedCount,
        snapshotCount: operation.snapshotCount
      }
    });

    if (operation.snapshotCount > 0) {
      this.options.auditLog.record({
        action: "snapshot-created",
        surface: "file",
        source,
        summary: operation.summary,
        risk: operation.risk,
        detail: `Created ${operation.snapshotCount} recoverable snapshot(s) before the file operation.`,
        metadata: {
          operationId: operation.id,
          snapshotCount: operation.snapshotCount,
          bytesCaptured: operation.snapshotBytesCaptured
        }
      });
    }

    if (operation.metadataOnlyCount > 0) {
      this.options.auditLog.record({
        action: "metadata-only",
        surface: "file",
        source,
        summary: operation.summary,
        risk: operation.risk,
        detail: `Stored metadata only for ${operation.metadataOnlyCount} file(s).`,
        metadata: {
          operationId: operation.id,
          metadataOnlyCount: operation.metadataOnlyCount
        }
      });
    }

    if (!operation.recoverable && operation.kind !== "create") {
      this.options.auditLog.record({
        action: "unrecoverable",
        surface: "file",
        source,
        summary: operation.summary,
        risk: operation.risk,
        detail: "Safe Exec observed this file operation, but it did not capture a recoverable snapshot.",
        metadata: {
          operationId: operation.id
        }
      });
    }
  }

  private prepareCreateOperation(files: readonly vscode.Uri[]): PreparedFileOperation {
    const snapshots = files.map((uri) => {
      const pathEvaluation = this.evaluatePath(uri);
      return {
        snapshot: {
          label: this.describeUri(uri),
          originalUri: uri.toString(),
          isDirectory: false,
          snapshotKind: "metadata-only" as const,
          detail: "Safe Exec can evaluate this create request, but it does not automatically reverse newly created files."
        },
        protectedPath: pathEvaluation.protectedPath,
        sensitiveMatch: pathEvaluation.sensitiveMatch,
        ignoredPath: pathEvaluation.ignoredPath
      };
    });
    const evaluation = this.evaluateOperation("create", snapshots);
    return {
      source: "file:onWillCreateFiles",
      record: {
        kind: "create",
        risk: evaluation.risk,
        summary: this.describeCreateDelete(files, "create"),
        detail: this.buildOperationDetail(evaluation, "Create operations are observed and classified, but Safe Exec does not automatically reverse new file creation."),
        fileCount: Math.max(files.length, evaluation.fileCount),
        protectedCount: evaluation.protectedCount,
        bulk: evaluation.bulk,
        subtree: evaluation.subtree,
        bestEffortNote: COVERAGE_NOTE,
        files: snapshots.map((entry) => entry.snapshot)
      }
    };
  }

  private async prepareDeleteOperation(files: readonly vscode.Uri[]): Promise<PreparedFileOperation> {
    const rules = this.options.getRules().fileOps;
    const snapshots: OperationEntryEvaluation[] = [];
    const rootSnapshots: OperationEntryEvaluation[] = [];
    let operationFileCount = 0;
    let truncated = false;

    for (const uri of files) {
      const rootEntry = await this.collectExistingEntry(uri);
      if (!rootEntry) {
        const observedOnly = this.buildObservedOnlySnapshot(uri, "Path did not exist when Safe Exec evaluated the delete request.");
        snapshots.push(observedOnly);
        rootSnapshots.push(observedOnly);
        continue;
      }

      snapshots.push(rootEntry);
      rootSnapshots.push(rootEntry);
      if (rootEntry.snapshot.isDirectory) {
        const walk = await this.collectDirectoryEntries(uri, undefined, rules.maxFilesPerOperation, rules.minBulkOperationCount);
        rootEntry.snapshot.subtreeFileCount = walk.fileCount;
        if (walk.truncated) {
          rootEntry.snapshot.detail = this.appendSnapshotDetail(
            rootEntry.snapshot.detail,
            `Safe Exec observed at least ${walk.fileCount} file(s) in this subtree before the snapshot cap was reached.`
          );
        }
        snapshots.push(...walk.entries);
        operationFileCount += walk.fileCount;
        truncated = truncated || walk.truncated;
      } else {
        operationFileCount += 1;
      }
    }

    const evaluation = this.evaluateOperation("delete", snapshots);
    const summary = this.describeDeleteSummary(files, rootSnapshots, operationFileCount, truncated);
    const detail = this.buildOperationDetail(
      evaluation,
      truncated
        ? `Safe Exec capped preflight snapshotting at ${rules.maxFilesPerOperation} file(s) for this operation.`
        : "Recoverable snapshots were captured when the file size, file count, and type limits allowed it.",
      this.buildDeleteScopeDetail(files, rootSnapshots, operationFileCount, truncated)
    );

    return {
      source: "file:onWillDeleteFiles",
      record: {
        kind: "delete",
        risk: evaluation.risk,
        summary,
        detail,
        fileCount: Math.max(operationFileCount, evaluation.fileCount),
        protectedCount: evaluation.protectedCount,
        bulk: evaluation.bulk,
        subtree: evaluation.subtree,
        bestEffortNote: COVERAGE_NOTE,
        files: snapshots.map((entry) => entry.snapshot)
      }
    };
  }

  private async prepareRenameOperation(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<PreparedFileOperation> {
    const rules = this.options.getRules().fileOps;
    const snapshots: OperationEntryEvaluation[] = [];
    const rootSnapshots: OperationEntryEvaluation[] = [];
    let operationFileCount = 0;
    let truncated = false;

    for (const pair of files) {
      const rootEntry = await this.collectExistingEntry(pair.oldUri, pair.newUri);
      if (!rootEntry) {
        const observedOnly = this.buildObservedOnlySnapshot(
          pair.oldUri,
          "Path did not exist when Safe Exec evaluated the rename request.",
          pair.newUri
        );
        snapshots.push(observedOnly);
        rootSnapshots.push(observedOnly);
        continue;
      }

      snapshots.push(rootEntry);
      rootSnapshots.push(rootEntry);
      if (rootEntry.snapshot.isDirectory) {
        const walk = await this.collectDirectoryEntries(pair.oldUri, pair.newUri, rules.maxFilesPerOperation, rules.minBulkOperationCount);
        rootEntry.snapshot.subtreeFileCount = walk.fileCount;
        if (walk.truncated) {
          rootEntry.snapshot.detail = this.appendSnapshotDetail(
            rootEntry.snapshot.detail,
            `Safe Exec observed at least ${walk.fileCount} file(s) in this subtree before the snapshot cap was reached.`
          );
        }
        snapshots.push(...walk.entries);
        operationFileCount += walk.fileCount;
        truncated = truncated || walk.truncated;
      } else {
        operationFileCount += 1;
      }
    }

    const evaluation = this.evaluateOperation("rename", snapshots);
    const summary = this.describeRenameSummary(files, rootSnapshots, operationFileCount, truncated);
    const detail = this.buildOperationDetail(
      evaluation,
      truncated
        ? `Safe Exec capped preflight snapshotting at ${rules.maxFilesPerOperation} file(s) for this rename operation.`
        : "Recoverable snapshots were captured when the file size, file count, and type limits allowed it.",
      this.buildRenameScopeDetail(files, rootSnapshots, operationFileCount, truncated)
    );

    return {
      source: "file:onWillRenameFiles",
      record: {
        kind: "rename",
        risk: evaluation.risk,
        summary,
        detail,
        fileCount: Math.max(operationFileCount, evaluation.fileCount),
        protectedCount: evaluation.protectedCount,
        bulk: evaluation.bulk,
        subtree: evaluation.subtree,
        bestEffortNote: COVERAGE_NOTE,
        files: snapshots.map((entry) => entry.snapshot)
      }
    };
  }

  private async collectExistingEntry(originalUri: vscode.Uri, newUri?: vscode.Uri): Promise<OperationEntryEvaluation | undefined> {
    if (originalUri.scheme !== "file") {
      return this.buildObservedOnlySnapshot(originalUri, "Safe Exec only snapshots file:// resources before delete or rename.", newUri);
    }

    try {
      const stat = await fs.lstat(originalUri.fsPath);
      if (stat.isDirectory()) {
        return this.buildDirectorySnapshot(originalUri, newUri);
      }

      return this.buildFileSnapshot(originalUri, stat.size, newUri);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return undefined;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.log(`Failed to inspect ${originalUri.fsPath}: ${message}`);
      return this.buildObservedOnlySnapshot(originalUri, `Safe Exec could not inspect the file before the operation: ${message}`, newUri);
    }
  }

  private async collectDirectoryEntries(
    oldRootUri: vscode.Uri,
    newRootUri: vscode.Uri | undefined,
    maxSnapshotFiles: number,
    minBulkOperationCount: number
  ): Promise<DirectoryWalkResult> {
    const entries: OperationEntryEvaluation[] = [];
    const queue: Array<{ oldUri: vscode.Uri; newUri?: vscode.Uri }> = [{ oldUri: oldRootUri, newUri: newRootUri }];
    const inspectionBudget = Math.max(maxSnapshotFiles, minBulkOperationCount) + 1;
    let fileCount = 0;
    let snapshottedFiles = 0;
    let truncated = false;

    while (queue.length > 0 && fileCount < inspectionBudget) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      let directoryEntries: Array<Dirent>;
      try {
        directoryEntries = await fs.readdir(current.oldUri.fsPath, { withFileTypes: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entries.push(
          this.buildObservedOnlySnapshot(current.oldUri, `Safe Exec could not enumerate this directory before the file operation: ${message}`, current.newUri)
        );
        continue;
      }

      for (const entry of directoryEntries) {
        const childOldPath = path.join(current.oldUri.fsPath, entry.name);
        const childOldUri = vscode.Uri.file(childOldPath);
        const childNewUri = current.newUri ? vscode.Uri.file(path.join(current.newUri.fsPath, entry.name)) : undefined;

        if (entry.isDirectory()) {
          entries.push(this.buildDirectorySnapshot(childOldUri, childNewUri));
          queue.push({ oldUri: childOldUri, newUri: childNewUri });
          continue;
        }

        fileCount += 1;
        if (fileCount > inspectionBudget) {
          truncated = true;
          break;
        }

        if (snapshottedFiles >= maxSnapshotFiles) {
          truncated = true;
          entries.push(this.buildObservedOnlySnapshot(childOldUri, "Safe Exec skipped a deeper file because the snapshot file-count limit was reached.", childNewUri));
          continue;
        }

        try {
          const stat = await fs.lstat(childOldPath);
          entries.push(await this.buildFileSnapshot(childOldUri, stat.size, childNewUri));
          snapshottedFiles += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          entries.push(this.buildObservedOnlySnapshot(childOldUri, `Safe Exec could not snapshot this file before the operation: ${message}`, childNewUri));
        }
      }
    }

    if (queue.length > 0) {
      truncated = true;
    }

    return {
      entries,
      fileCount,
      truncated
    };
  }

  private async buildFileSnapshot(originalUri: vscode.Uri, size: number, newUri?: vscode.Uri): Promise<OperationEntryEvaluation> {
    const rules = this.options.getRules().fileOps;
    const label = this.describeUri(originalUri);
    const pathEvaluation = this.evaluatePath(originalUri, newUri);

    if (size > rules.maxSnapshotBytes) {
      return {
        snapshot: {
          label,
          originalUri: originalUri.toString(),
          newUri: newUri?.toString(),
          isDirectory: false,
          size,
          snapshotKind: "metadata-only",
          detail: `Safe Exec skipped the file content because it exceeded the ${rules.maxSnapshotBytes}-byte snapshot limit.`
        },
        protectedPath: pathEvaluation.protectedPath,
        sensitiveMatch: pathEvaluation.sensitiveMatch,
        ignoredPath: pathEvaluation.ignoredPath
      };
    }

    const buffer = await fs.readFile(originalUri.fsPath);
    if (this.isProbablyBinary(buffer)) {
      if (!rules.captureBinarySnapshots) {
        return {
          snapshot: {
            label,
            originalUri: originalUri.toString(),
            newUri: newUri?.toString(),
            isDirectory: false,
            size,
            snapshotKind: "metadata-only",
            detail: "Safe Exec skipped the binary file content because binary snapshots are disabled."
          },
          protectedPath: pathEvaluation.protectedPath,
          sensitiveMatch: pathEvaluation.sensitiveMatch,
          ignoredPath: pathEvaluation.ignoredPath
        };
      }

      return {
        snapshot: {
          label,
          originalUri: originalUri.toString(),
          newUri: newUri?.toString(),
          isDirectory: false,
          size,
          snapshotKind: "binary",
          snapshotContent: buffer
        },
        protectedPath: pathEvaluation.protectedPath,
        sensitiveMatch: pathEvaluation.sensitiveMatch,
        ignoredPath: pathEvaluation.ignoredPath
      };
    }

    return {
      snapshot: {
        label,
        originalUri: originalUri.toString(),
        newUri: newUri?.toString(),
        isDirectory: false,
        size,
        snapshotKind: "text",
        snapshotContent: buffer
      },
      protectedPath: pathEvaluation.protectedPath,
      sensitiveMatch: pathEvaluation.sensitiveMatch,
      ignoredPath: pathEvaluation.ignoredPath
    };
  }

  private buildDirectorySnapshot(originalUri: vscode.Uri, newUri?: vscode.Uri): OperationEntryEvaluation {
    const pathEvaluation = this.evaluatePath(originalUri, newUri);
    return {
      snapshot: {
        label: this.describeUri(originalUri),
        originalUri: originalUri.toString(),
        newUri: newUri?.toString(),
        isDirectory: true,
        snapshotKind: "none"
      },
      protectedPath: pathEvaluation.protectedPath,
      sensitiveMatch: pathEvaluation.sensitiveMatch,
      ignoredPath: pathEvaluation.ignoredPath
    };
  }

  private buildObservedOnlySnapshot(originalUri: vscode.Uri, detail?: string, newUri?: vscode.Uri): OperationEntryEvaluation {
    const pathEvaluation = this.evaluatePath(originalUri, newUri);
    return {
      snapshot: {
        label: this.describeUri(originalUri),
        originalUri: originalUri.toString(),
        newUri: newUri?.toString(),
        isDirectory: false,
        snapshotKind: "none",
        detail
      },
      protectedPath: pathEvaluation.protectedPath,
      sensitiveMatch: pathEvaluation.sensitiveMatch,
      ignoredPath: pathEvaluation.ignoredPath
    };
  }

  private evaluateOperation(kind: FileOperationKind, entries: readonly OperationEntryEvaluation[]): OperationEvaluationSummary {
    const rules = this.options.getRules().fileOps;
    const signalEntries = entries.filter((entry) => !(entry.ignoredPath && !entry.protectedPath && !entry.sensitiveMatch));
    const fileEntries = signalEntries.filter((entry) => !entry.snapshot.isDirectory);
    const protectedCount = signalEntries.filter((entry) => entry.protectedPath || entry.sensitiveMatch).length;
    const subtree = signalEntries.some((entry) => entry.snapshot.isDirectory);
    const fileCount = fileEntries.length;
    const bulk = fileCount >= rules.minBulkOperationCount;
    const renameAwayProtectedCount =
      kind === "rename"
        ? signalEntries.filter((entry) => entry.protectedPath && entry.snapshot.newUri && !this.isProtectedPath(vscode.Uri.parse(entry.snapshot.newUri))).length
        : 0;

    const reasons: string[] = [];
    if (protectedCount > 0) {
      reasons.push(`matched ${protectedCount} protected or high-value path(s)`);
    }

    if (bulk) {
      reasons.push(`affected ${fileCount} file(s), which crossed the bulk threshold`);
    }

    if (subtree) {
      reasons.push("included a folder or subtree path");
    }

    if (renameAwayProtectedCount > 0) {
      reasons.push(`renamed ${renameAwayProtectedCount} protected path(s) away from their original location`);
    }

    const risk = this.deriveRisk(kind, {
      fileCount,
      protectedCount,
      bulk,
      subtree,
      renameAwayProtectedCount,
      reasons
    });

    if (reasons.length === 0) {
      reasons.push(kind === "create" ? "metadata-only create preflight" : "metadata-only file-operation preflight");
    }

    return {
      fileCount,
      protectedCount,
      bulk,
      subtree,
      renameAwayProtectedCount,
      reasons,
      risk
    };
  }

  private deriveRisk(kind: FileOperationKind, evaluation: Omit<OperationEvaluationSummary, "risk">): RiskLevel {
    if (kind === "delete" && evaluation.protectedCount > 0) {
      return evaluation.bulk || evaluation.subtree ? "critical" : "high";
    }

    if (kind === "rename" && evaluation.renameAwayProtectedCount > 0) {
      return "critical";
    }

    if ((kind === "delete" || kind === "rename") && (evaluation.bulk || evaluation.subtree)) {
      return evaluation.protectedCount > 0 ? "critical" : "high";
    }

    if (evaluation.protectedCount > 0) {
      return kind === "create" ? "medium" : "high";
    }

    if (evaluation.bulk) {
      return kind === "create" ? "medium" : "high";
    }

    if (evaluation.subtree) {
      return kind === "create" ? "medium" : "high";
    }

    return kind === "create" ? "low" : "medium";
  }

  private buildOperationDetail(evaluation: OperationEvaluationSummary, limitation: string, scope?: string): string {
    return [
      `Reasons: ${evaluation.reasons.join("; ")}`,
      scope ? `Scope: ${scope}` : undefined,
      limitation,
      COVERAGE_NOTE
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private describeDeleteSummary(
    files: readonly vscode.Uri[],
    roots: readonly OperationEntryEvaluation[],
    fileCount: number,
    truncated: boolean
  ): string {
    if (files.length === 1) {
      const root = roots[0];
      if (root?.snapshot.isDirectory) {
        return `Delete ${this.describeUri(files[0])} subtree (${this.formatObservedFileCount(fileCount, truncated)})`;
      }

      return this.describeCreateDelete(files, "delete");
    }

    if (roots.some((root) => root.snapshot.isDirectory)) {
      return `Delete ${files.length} path(s) across ${this.summarizeRoots(files.map((uri) => this.describeUri(uri)))} (${this.formatObservedFileCount(
        fileCount,
        truncated
      )})`;
    }

    return this.describeCreateDelete(files, "delete");
  }

  private describeRenameSummary(
    files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
    roots: readonly OperationEntryEvaluation[],
    fileCount: number,
    truncated: boolean
  ): string {
    if (files.length === 1) {
      const root = roots[0];
      if (root?.snapshot.isDirectory) {
        return `Rename ${this.describeUri(files[0].oldUri)} -> ${this.describeUri(files[0].newUri)} (${this.formatObservedFileCount(
          fileCount,
          truncated
        )} in subtree)`;
      }

      return this.describeRename(files);
    }

    if (roots.some((root) => root.snapshot.isDirectory)) {
      return `Rename ${files.length} path(s) across ${this.summarizeRoots(
        files.map((entry) => `${this.describeUri(entry.oldUri)} -> ${this.describeUri(entry.newUri)}`)
      )} (${this.formatObservedFileCount(fileCount, truncated)})`;
    }

    return this.describeRename(files);
  }

  private buildDeleteScopeDetail(
    files: readonly vscode.Uri[],
    roots: readonly OperationEntryEvaluation[],
    fileCount: number,
    truncated: boolean
  ): string {
    if (roots.some((root) => root.snapshot.isDirectory)) {
      return `${this.summarizeRoots(files.map((uri) => this.describeUri(uri)))}; ${this.formatObservedFileCount(fileCount, truncated)} across the observed tree.`;
    }

    return `${this.summarizeRoots(files.map((uri) => this.describeUri(uri)))}.`;
  }

  private buildRenameScopeDetail(
    files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
    roots: readonly OperationEntryEvaluation[],
    fileCount: number,
    truncated: boolean
  ): string {
    if (roots.some((root) => root.snapshot.isDirectory)) {
      return `${this.summarizeRoots(files.map((entry) => `${this.describeUri(entry.oldUri)} -> ${this.describeUri(entry.newUri)}`))}; ${this.formatObservedFileCount(
        fileCount,
        truncated
      )} across the observed tree.`;
    }

    return `${this.summarizeRoots(files.map((entry) => `${this.describeUri(entry.oldUri)} -> ${this.describeUri(entry.newUri)}`))}.`;
  }

  private summarizeRoots(labels: readonly string[]): string {
    if (labels.length === 0) {
      return "no paths";
    }

    if (labels.length === 1) {
      return labels[0];
    }

    if (labels.length === 2) {
      return `${labels[0]} and ${labels[1]}`;
    }

    return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more root(s)`;
  }

  private formatObservedFileCount(fileCount: number, truncated: boolean): string {
    return truncated ? `at least ${fileCount} file(s)` : `${fileCount} file(s)`;
  }

  private appendSnapshotDetail(existing: string | undefined, detail: string): string {
    return existing ? `${existing} ${detail}` : detail;
  }

  private evaluatePath(
    originalUri: vscode.Uri,
    newUri?: vscode.Uri
  ): { protectedPath: boolean; sensitiveMatch: boolean; ignoredPath: boolean } {
    const protectedPath = this.isProtectedPath(originalUri) || (newUri ? this.isProtectedPath(newUri) : false);
    const sensitiveMatch = this.isSensitivePath(originalUri) || (newUri ? this.isSensitivePath(newUri) : false);
    const ignoredPath = this.isIgnoredPath(originalUri) && (!newUri || this.isIgnoredPath(newUri));
    return {
      protectedPath,
      sensitiveMatch,
      ignoredPath
    };
  }

  private isProtectedPath(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;
    }

    const rules = this.options.getRules().fileOps;
    return matchesAnyCompiledRegexPattern(rules.protectedPathMatchers, uri.fsPath);
  }

  private isIgnoredPath(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;
    }

    const rules = this.options.getRules().fileOps;
    return matchesAnyCompiledRegexPattern(rules.ignoredPathMatchers, uri.fsPath);
  }

  private isSensitivePath(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;
    }

    const rules = this.options.getRules().fileOps;
    return matchesSensitivePath(uri.fsPath, rules.sensitiveExtensions, rules.sensitiveFileNames);
  }

  private async maybeShowOperationNotice(operation: FileOperationRecord): Promise<void> {
    if (!this.options.showUserNotices) {
      return;
    }

    if (operation.kind === "create" && operation.risk === "low") {
      return;
    }

    if (operation.risk === "low" && operation.metadataOnlyCount === 0 && operation.unrecoverableCount === 0 && operation.snapshotCount === 0) {
      return;
    }

    const message =
      operation.metadataOnlyCount > 0 || operation.unrecoverableCount > 0
        ? `Safe Exec observed "${operation.summary}" but recovery is partial. ${operation.bestEffortNote ?? COVERAGE_NOTE}`
        : operation.snapshotCount > 0
        ? `Safe Exec created recoverable snapshots for "${operation.summary}". ${operation.bestEffortNote ?? COVERAGE_NOTE}`
        : `Safe Exec observed "${operation.summary}". ${operation.bestEffortNote ?? COVERAGE_NOTE}`;

    const selection = await vscode.window.showInformationMessage(message, "Show Recent File Operations");
    if (selection === "Show Recent File Operations") {
      await vscode.commands.executeCommand("safeExec.showRecentFileOperations");
    }
  }

  private shouldHandleFileOps(): boolean {
    return this.options.isEnabled() && this.options.getRules().fileOps.enabled;
  }

  private getCreateDeleteKey(kind: "create" | "delete", files: readonly vscode.Uri[]): string {
    return `${kind}|${files.map((uri) => uri.toString()).sort().join("|")}`;
  }

  private getRenameKey(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): string {
    return `rename|${files
      .map((entry) => `${entry.oldUri.toString()}=>${entry.newUri.toString()}`)
      .sort()
      .join("|")}`;
  }

  private pushPendingOperation(key: string, operationId: string): void {
    const pending = this.pendingOperations.get(key) ?? [];
    pending.push(operationId);
    this.pendingOperations.set(key, pending);
  }

  private consumePendingOperation(key: string): string | undefined {
    const pending = this.pendingOperations.get(key);
    const operationId = pending?.shift();
    if (!pending || pending.length === 0) {
      this.pendingOperations.delete(key);
    } else {
      this.pendingOperations.set(key, pending);
    }

    return operationId;
  }

  private describeCreateDelete(files: readonly vscode.Uri[], kind: "create" | "delete" = "delete"): string {
    if (files.length === 1) {
      return `${capitalize(kind)} ${this.describeUri(files[0])}`;
    }

    return `${capitalize(kind)} ${files.length} file(s)`;
  }

  private describeRename(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): string {
    if (files.length === 1) {
      return `Rename ${this.describeUri(files[0].oldUri)} -> ${this.describeUri(files[0].newUri)}`;
    }

    return `Rename ${files.length} file(s)`;
  }

  private describeUri(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false) || uri.fsPath || uri.toString();
  }

  private isProbablyBinary(buffer: Buffer): boolean {
    if (buffer.includes(0)) {
      return true;
    }

    const sampleLength = Math.min(buffer.length, 1024);
    let suspicious = 0;
    for (let index = 0; index < sampleLength; index += 1) {
      const value = buffer[index];
      if (value < 7 || (value > 14 && value < 32)) {
        suspicious += 1;
      }
    }

    return sampleLength > 0 && suspicious / sampleLength > 0.2;
  }

  private log(message: string): void {
    this.options.output.appendLine(`[file] ${message}`);
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
