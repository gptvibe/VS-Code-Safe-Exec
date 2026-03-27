import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { gunzip, gzip } from "zlib";
import type { RiskLevel } from "./rules";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type FileOperationKind = "create" | "delete" | "rename";
export type FileOperationStatus = "pending" | "completed" | "denied" | "restored" | "restore-failed";
export type FileSnapshotKind = "text" | "binary" | "metadata-only" | "none";
export type SnapshotCompression = "none" | "gzip";
export type RestorePreviewAction = "restore" | "move" | "conflict-copy" | "skip" | "unavailable";

export interface FileOperationSnapshotInput {
  entryId?: string;
  label: string;
  originalUri: string;
  newUri?: string;
  isDirectory: boolean;
  size?: number;
  subtreeFileCount?: number;
  snapshotKind: FileSnapshotKind;
  snapshotContent?: string | Uint8Array;
  detail?: string;
}

export interface FileOperationRecordInput {
  id?: string;
  kind: FileOperationKind;
  risk: RiskLevel;
  summary: string;
  detail?: string;
  fileCount: number;
  protectedCount: number;
  bulk: boolean;
  subtree: boolean;
  status?: FileOperationStatus;
  bestEffortNote?: string;
  files: FileOperationSnapshotInput[];
}

export interface FileOperationSnapshotRecord {
  entryId: string;
  label: string;
  originalUri: string;
  newUri?: string;
  isDirectory: boolean;
  size?: number;
  subtreeFileCount?: number;
  snapshotKind: FileSnapshotKind;
  snapshotStoragePath?: string;
  snapshotContentHash?: string;
  snapshotCompression?: SnapshotCompression;
  snapshotStoredBytes?: number;
  detail?: string;
}

export interface FileOperationRecord {
  id: string;
  kind: FileOperationKind;
  risk: RiskLevel;
  summary: string;
  detail?: string;
  recordedAt: string;
  completedAt?: string;
  restoredAt?: string;
  status: FileOperationStatus;
  fileCount: number;
  protectedCount: number;
  bulk: boolean;
  subtree: boolean;
  recoverable: boolean;
  snapshotCount: number;
  metadataOnlyCount: number;
  unrecoverableCount: number;
  snapshotBytesCaptured: number;
  bestEffortNote?: string;
  files: FileOperationSnapshotRecord[];
}

export interface FileOperationUpdateInput {
  status?: FileOperationStatus;
  summary?: string;
  detail?: string;
  completedAt?: string;
  restoredAt?: string;
  bestEffortNote?: string;
}

export interface RestoreFileOperationResult {
  operation?: FileOperationRecord;
  restoredCount: number;
  failedCount: number;
  skippedCount: number;
  warnings: string[];
  failureDetails: string[];
}

export interface RestorePreviewItem {
  label: string;
  action: RestorePreviewAction;
  detail: string;
}

export interface RestorePreviewResult {
  operation?: FileOperationRecord;
  totalEntries: number;
  directRestoreCount: number;
  moveCount: number;
  conflictCopyCount: number;
  skippedCount: number;
  unavailableCount: number;
  partial: boolean;
  summary: string;
  items: RestorePreviewItem[];
}

interface FileOperationIndex {
  version: 2;
  operations: FileOperationRecord[];
}

interface StoredSnapshotContent {
  contentHash: string;
  compression: SnapshotCompression;
  storagePath: string;
  storedBytes: number;
}

interface ExistingPathState {
  exists: boolean;
  isDirectory: boolean;
  content?: Buffer;
}

interface RestorePlan {
  action: "mkdir" | "write" | "move" | "write-conflict-copy" | "skip" | "fail";
  targetPath?: string;
  sourcePath?: string;
  content?: Buffer;
  warning?: string;
  failure?: string;
  previewAction: RestorePreviewAction;
  previewDetail: string;
}

const INDEX_FILE_NAME = "index.json";
const SNAPSHOT_DIRECTORY_NAME = "snapshots";
const BLOB_DIRECTORY_NAME = "blobs";
const MAX_STORED_OPERATIONS = 60;
const MAX_TOTAL_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const TEXT_COMPRESSION_MIN_BYTES = 1024;
const TEXT_COMPRESSION_MIN_SAVINGS_BYTES = 96;
const RESTORE_CONFLICT_SUFFIX = ".safe-exec-restore";

export class FileOperationRecoveryStore {
  private readonly indexPath: string;
  private readonly snapshotRootPath: string;
  private readonly blobRootPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private indexCache: FileOperationIndex | undefined;

  public constructor(private readonly rootUri: vscode.Uri, private readonly output: vscode.OutputChannel) {
    this.indexPath = path.join(this.rootUri.fsPath, INDEX_FILE_NAME);
    this.snapshotRootPath = path.join(this.rootUri.fsPath, SNAPSHOT_DIRECTORY_NAME);
    this.blobRootPath = path.join(this.snapshotRootPath, BLOB_DIRECTORY_NAME);
  }

  public async initialize(): Promise<void> {
    await this.enqueue(async () => {
      await fs.mkdir(this.blobRootPath, { recursive: true });
      await this.loadIndex();
    });
  }

  public async clear(): Promise<void> {
    await this.enqueue(async () => {
      await fs.rm(this.rootUri.fsPath, { recursive: true, force: true });
      this.indexCache = undefined;
      await fs.mkdir(this.blobRootPath, { recursive: true });
      await this.persistIndex({
        version: 2,
        operations: []
      });
    });
  }

  public async saveOperation(input: FileOperationRecordInput): Promise<FileOperationRecord> {
    return this.enqueue(async () => {
      await this.ensureInitialized();

      const operationId = input.id ?? createOperationId();
      let snapshotBytesCaptured = 0;
      let snapshotCount = 0;
      let metadataOnlyCount = 0;
      let unrecoverableCount = 0;

      const files: FileOperationSnapshotRecord[] = [];
      for (const [index, file] of input.files.entries()) {
        const entryId = file.entryId ?? `${index + 1}`;
        let snapshotStoragePath: string | undefined;
        let snapshotContentHash: string | undefined;
        let snapshotCompression: SnapshotCompression | undefined;
        let snapshotStoredBytes: number | undefined;

        if (file.snapshotContent !== undefined) {
          const content =
            typeof file.snapshotContent === "string"
              ? Buffer.from(file.snapshotContent, "utf8")
              : Buffer.from(file.snapshotContent);
          const stored = await this.storeSnapshotContent(file.snapshotKind, content);
          snapshotStoragePath = stored.storagePath;
          snapshotContentHash = stored.contentHash;
          snapshotCompression = stored.compression;
          snapshotStoredBytes = stored.storedBytes;
          snapshotBytesCaptured += stored.storedBytes;
          snapshotCount += 1;
        } else if (file.snapshotKind === "metadata-only" && !file.isDirectory) {
          metadataOnlyCount += 1;
        } else if (file.snapshotKind === "none" && !file.isDirectory) {
          unrecoverableCount += 1;
        }

        files.push({
          entryId,
          label: file.label,
          originalUri: file.originalUri,
          newUri: file.newUri,
          isDirectory: file.isDirectory,
          size: file.size,
          subtreeFileCount: file.subtreeFileCount,
          snapshotKind: file.snapshotKind,
          snapshotStoragePath,
          snapshotContentHash,
          snapshotCompression,
          snapshotStoredBytes,
          detail: file.detail
        });
      }

      const nextRecord: FileOperationRecord = {
        id: operationId,
        kind: input.kind,
        risk: input.risk,
        summary: input.summary,
        detail: input.detail,
        recordedAt: new Date().toISOString(),
        status: input.status ?? "pending",
        fileCount: input.fileCount,
        protectedCount: input.protectedCount,
        bulk: input.bulk,
        subtree: input.subtree,
        recoverable: files.some((file) => isRecoverableSnapshot(file)),
        snapshotCount,
        metadataOnlyCount,
        unrecoverableCount,
        snapshotBytesCaptured,
        bestEffortNote: input.bestEffortNote,
        files
      };

      const indexData = await this.loadIndex();
      indexData.operations = indexData.operations.filter((operation) => operation.id !== operationId);
      indexData.operations.push(nextRecord);
      await this.pruneIndex(indexData);
      await this.persistIndex(indexData);
      return nextRecord;
    });
  }

  public async updateOperation(operationId: string, update: FileOperationUpdateInput): Promise<FileOperationRecord | undefined> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const indexData = await this.loadIndex();
      const existing = indexData.operations.find((operation) => operation.id === operationId);
      if (!existing) {
        return undefined;
      }

      if (update.status) {
        existing.status = update.status;
      }

      if (update.summary) {
        existing.summary = update.summary;
      }

      if (typeof update.detail === "string") {
        existing.detail = update.detail;
      }

      if (update.completedAt) {
        existing.completedAt = update.completedAt;
      }

      if (update.restoredAt) {
        existing.restoredAt = update.restoredAt;
      }

      if (typeof update.bestEffortNote === "string") {
        existing.bestEffortNote = update.bestEffortNote;
      }

      await this.persistIndex(indexData);
      return existing;
    });
  }

  public async getRecentOperations(limit = 20): Promise<FileOperationRecord[]> {
    return this.enqueue(async () => {
      const indexData = await this.loadIndex();
      return [...indexData.operations]
        .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
        .slice(0, limit);
    });
  }

  public async getRecoverableOperations(limit = 20): Promise<FileOperationRecord[]> {
    return this.enqueue(async () => {
      const indexData = await this.loadIndex();
      return [...indexData.operations]
        .filter((operation) => operation.recoverable)
        .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
        .slice(0, limit);
    });
  }

  public async getLastRecoverableOperation(): Promise<FileOperationRecord | undefined> {
    const [latest] = await this.getRecoverableOperations(1);
    return latest;
  }

  public async getOperation(operationId: string): Promise<FileOperationRecord | undefined> {
    return this.enqueue(async () => {
      const indexData = await this.loadIndex();
      return indexData.operations.find((operation) => operation.id === operationId);
    });
  }

  public async previewRestoreOperation(operationId: string, limit = 8): Promise<RestorePreviewResult> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const indexData = await this.loadIndex();
      const operation = indexData.operations.find((candidate) => candidate.id === operationId);
      if (!operation) {
        return {
          operation: undefined,
          totalEntries: 0,
          directRestoreCount: 0,
          moveCount: 0,
          conflictCopyCount: 0,
          skippedCount: 0,
          unavailableCount: 0,
          partial: true,
          summary: "Operation was not found in recovery storage.",
          items: []
        };
      }

      return this.buildRestorePreview(operation, limit);
    });
  }

  public async renderMarkdown(limit = 20): Promise<string> {
    const operations = await this.getRecentOperations(limit);
    const previews = new Map<string, RestorePreviewResult>();
    await Promise.all(
      operations
        .filter((operation) => operation.recoverable)
        .map(async (operation) => {
          previews.set(operation.id, await this.previewRestoreOperation(operation.id, 5));
        })
    );

    const lines = [
      "# Safe Exec Recent File Operations",
      "",
      "This view is best effort. It covers VS Code file gestures and `workspace.applyEdit(...)` file operations when the editor fires file-operation events. It does not claim coverage for external disk changes or `workspace.fs` calls.",
      ""
    ];

    if (operations.length === 0) {
      lines.push("No recent Safe Exec file operations were recorded in this workspace.");
      return lines.join("\n");
    }

    for (const operation of operations) {
      lines.push(`## ${operation.kind} · ${operation.risk.toUpperCase()} · ${operation.status}`);
      lines.push("");
      lines.push(`- Time: ${operation.recordedAt}`);
      lines.push(`- Summary: ${operation.summary}`);
      lines.push(`- Files: ${operation.fileCount}`);
      lines.push(`- Recoverable snapshots: ${operation.snapshotCount}`);
      lines.push(`- Metadata-only entries: ${operation.metadataOnlyCount}`);
      lines.push(`- Unrecoverable entries: ${operation.unrecoverableCount}`);
      lines.push(`- Snapshot bytes: ${operation.snapshotBytesCaptured}`);
      lines.push(`- Protected-path matches: ${operation.protectedCount}`);
      lines.push(`- Bulk operation: ${operation.bulk ? "yes" : "no"}`);
      lines.push(`- Subtree operation: ${operation.subtree ? "yes" : "no"}`);
      if (operation.bestEffortNote) {
        lines.push(`- Note: ${operation.bestEffortNote}`);
      }

      if (operation.detail) {
        lines.push(`- Detail: ${operation.detail}`);
      }

      const preview = previews.get(operation.id);
      if (preview) {
        lines.push(`- Restore preview: ${preview.summary}`);
        if (preview.items.length > 0) {
          lines.push(`- Preview entries: ${preview.items.map((item) => `${item.label} (${item.action})`).join(", ")}`);
        }
      }

      const previewFiles = operation.files.slice(0, 8).map((file) => formatSnapshotListEntry(file));
      if (previewFiles.length > 0) {
        lines.push(`- Entries: ${previewFiles.join(", ")}`);
      }

      if (operation.files.length > previewFiles.length) {
        lines.push(`- More entries: ${operation.files.length - previewFiles.length}`);
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  public async restoreOperation(operationId: string): Promise<RestoreFileOperationResult> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const indexData = await this.loadIndex();
      const operation = indexData.operations.find((candidate) => candidate.id === operationId);
      const result: RestoreFileOperationResult = {
        operation,
        restoredCount: 0,
        failedCount: 0,
        skippedCount: 0,
        warnings: [],
        failureDetails: []
      };

      if (!operation) {
        result.failedCount = 1;
        result.failureDetails.push("Operation was not found in recovery storage.");
        return result;
      }

      if (!operation.recoverable) {
        result.failedCount = 1;
        result.failureDetails.push("Operation has no recoverable snapshots.");
        return result;
      }

      if (operation.kind === "create") {
        result.failedCount = 1;
        result.failureDetails.push("Create operations are recorded for review but are not automatically reversed.");
        return result;
      }

      const orderedFiles = [...operation.files].sort(compareSnapshotRecords);
      for (const file of orderedFiles) {
        const plan =
          operation.kind === "delete"
            ? await this.planDeletedEntryRestore(file)
            : await this.planRenamedEntryRestore(file);
        const restoreOutcome = await this.executeRestorePlan(file, plan);
        result.restoredCount += restoreOutcome.restoredCount;
        result.failedCount += restoreOutcome.failedCount;
        result.skippedCount += restoreOutcome.skippedCount;
        result.warnings.push(...restoreOutcome.warnings);
        result.failureDetails.push(...restoreOutcome.failureDetails);
      }

      operation.status = result.failedCount > 0 && result.restoredCount === 0 ? "restore-failed" : "restored";
      operation.restoredAt = new Date().toISOString();
      await this.persistIndex(indexData);
      return result;
    });
  }

  private async buildRestorePreview(operation: FileOperationRecord, limit: number): Promise<RestorePreviewResult> {
    if (!operation.recoverable) {
      return {
        operation,
        totalEntries: operation.files.length,
        directRestoreCount: 0,
        moveCount: 0,
        conflictCopyCount: 0,
        skippedCount: 0,
        unavailableCount: operation.files.length,
        partial: true,
        summary: "No recoverable snapshots are available for this operation.",
        items: []
      };
    }

    const orderedFiles = [...operation.files].sort(compareSnapshotRecords);
    const items: RestorePreviewItem[] = [];
    let directRestoreCount = 0;
    let moveCount = 0;
    let conflictCopyCount = 0;
    let skippedCount = 0;
    let unavailableCount = 0;

    for (const file of orderedFiles) {
      const plan =
        operation.kind === "delete"
          ? await this.planDeletedEntryRestore(file)
          : await this.planRenamedEntryRestore(file);

      switch (plan.previewAction) {
        case "restore":
          directRestoreCount += 1;
          break;
        case "move":
          moveCount += 1;
          break;
        case "conflict-copy":
          conflictCopyCount += 1;
          break;
        case "skip":
          skippedCount += 1;
          break;
        case "unavailable":
          unavailableCount += 1;
          break;
      }

      if (items.length < limit) {
        items.push({
          label: file.label,
          action: plan.previewAction,
          detail: plan.previewDetail
        });
      }
    }

    const partial = conflictCopyCount > 0 || skippedCount > 0 || unavailableCount > 0;
    const summaryParts = [`${formatCount(directRestoreCount + moveCount, "entry")} ready to restore`];
    if (conflictCopyCount > 0) {
      summaryParts.push(`${formatCount(conflictCopyCount, "conflict copy")} will be created`);
    }

    if (skippedCount > 0) {
      summaryParts.push(`${formatCount(skippedCount, "entry")} already occupy the original path`);
    }

    if (unavailableCount > 0) {
      summaryParts.push(`${formatCount(unavailableCount, "entry")} only have metadata`);
    }

    return {
      operation,
      totalEntries: operation.files.length,
      directRestoreCount,
      moveCount,
      conflictCopyCount,
      skippedCount,
      unavailableCount,
      partial,
      summary: summaryParts.join("; "),
      items
    };
  }

  private async planDeletedEntryRestore(file: FileOperationSnapshotRecord): Promise<RestorePlan> {
    const targetUri = vscode.Uri.parse(file.originalUri);
    const targetPath = targetUri.fsPath;

    if (file.isDirectory) {
      const existing = await this.getExistingPathState(targetPath);
      if (existing.exists) {
        return {
          action: "skip",
          warning: `${file.label} already exists at the original path.`,
          previewAction: "skip",
          previewDetail: `Keep the existing directory at ${this.displayPath(targetPath)}.`
        };
      }

      return {
        action: "mkdir",
        targetPath,
        previewAction: "restore",
        previewDetail: `Recreate the directory at ${this.displayPath(targetPath)}.`
      };
    }

    const snapshotContent = await this.loadRecoverableSnapshot(file);
    if (!snapshotContent.content) {
      return {
        action: "fail",
        failure: snapshotContent.failure,
        previewAction: "unavailable",
        previewDetail: snapshotContent.failure ?? `Safe Exec cannot restore ${file.label}.`
      };
    }

    const existing = await this.getExistingPathState(targetPath);
    if (!existing.exists) {
      return {
        action: "write",
        targetPath,
        content: snapshotContent.content,
        previewAction: "restore",
        previewDetail: `Restore the snapshot to ${this.displayPath(targetPath)}.`
      };
    }

    if (existing.content && buffersEqual(existing.content, snapshotContent.content)) {
      return {
        action: "skip",
        warning: `${file.label} already matches the stored snapshot at the original path.`,
        previewAction: "skip",
        previewDetail: `${this.displayPath(targetPath)} already matches the stored snapshot.`
      };
    }

    const conflictPath = await this.nextConflictPath(targetPath, file.isDirectory);
    return {
      action: "write-conflict-copy",
      targetPath: conflictPath,
      content: snapshotContent.content,
      warning: `Restored ${file.label} to ${this.displayPath(conflictPath)} because the original path already exists.`,
      previewAction: "conflict-copy",
      previewDetail: `Restore a conflict copy to ${this.displayPath(conflictPath)} because ${this.displayPath(targetPath)} already exists.`
    };
  }

  private async planRenamedEntryRestore(file: FileOperationSnapshotRecord): Promise<RestorePlan> {
    const oldUri = vscode.Uri.parse(file.originalUri);
    const newUri = file.newUri ? vscode.Uri.parse(file.newUri) : undefined;
    const oldPath = oldUri.fsPath;
    const newPath = newUri?.fsPath;

    if (!newPath) {
      return {
        action: "fail",
        failure: `Safe Exec does not know where ${file.label} was renamed to.`,
        previewAction: "unavailable",
        previewDetail: `Safe Exec does not know where ${file.label} was renamed to.`
      };
    }

    const oldState = await this.getExistingPathState(oldPath);
    const newState = await this.getExistingPathState(newPath);

    if (file.isDirectory) {
      if (oldState.exists) {
        return {
          action: "skip",
          warning: `${file.label} already exists at the original path.`,
          previewAction: "skip",
          previewDetail: `Keep the existing directory at ${this.displayPath(oldPath)}.`
        };
      }

      if (newState.exists) {
        return {
          action: "move",
          sourcePath: newPath,
          targetPath: oldPath,
          previewAction: "move",
          previewDetail: `Move the renamed directory from ${this.displayPath(newPath)} back to ${this.displayPath(oldPath)}.`
        };
      }

      return {
        action: "mkdir",
        targetPath: oldPath,
        previewAction: "restore",
        previewDetail: `Recreate the original directory at ${this.displayPath(oldPath)}.`
      };
    }

    const snapshotContent = await this.loadRecoverableSnapshot(file);
    if (!snapshotContent.content) {
      return {
        action: "fail",
        failure: snapshotContent.failure,
        previewAction: "unavailable",
        previewDetail: snapshotContent.failure ?? `Safe Exec cannot restore ${file.label}.`
      };
    }

    if (oldState.content && buffersEqual(oldState.content, snapshotContent.content)) {
      return {
        action: "skip",
        warning: `${file.label} already matches the stored snapshot at the original path.`,
        previewAction: "skip",
        previewDetail: `${this.displayPath(oldPath)} already matches the stored snapshot.`
      };
    }

    if (oldState.exists) {
      const conflictPath = await this.nextConflictPath(oldPath, file.isDirectory);
      return {
        action: "write-conflict-copy",
        targetPath: conflictPath,
        content: snapshotContent.content,
        warning: `Restored ${file.label} to ${this.displayPath(conflictPath)} because the original path already exists.`,
        previewAction: "conflict-copy",
        previewDetail: `Restore a conflict copy to ${this.displayPath(conflictPath)} because ${this.displayPath(oldPath)} already exists.`
      };
    }

    if (newState.content && buffersEqual(newState.content, snapshotContent.content)) {
      return {
        action: "move",
        sourcePath: newPath,
        targetPath: oldPath,
        previewAction: "move",
        previewDetail: `Move the renamed file from ${this.displayPath(newPath)} back to ${this.displayPath(oldPath)}.`
      };
    }

    const warning = newState.exists
      ? `Restored ${file.label} from the snapshot and kept ${this.displayPath(newPath)} because its current contents differ.`
      : undefined;
    const previewDetail = newState.exists
      ? `Restore the snapshot to ${this.displayPath(oldPath)} and keep ${this.displayPath(newPath)} because its current contents differ.`
      : `Restore the snapshot to ${this.displayPath(oldPath)}.`;

    return {
      action: "write",
      targetPath: oldPath,
      content: snapshotContent.content,
      warning,
      previewAction: "restore",
      previewDetail
    };
  }

  private async executeRestorePlan(file: FileOperationSnapshotRecord, plan: RestorePlan): Promise<RestoreFileOperationResult> {
    const result = emptyRestoreResult();

    if (plan.warning) {
      result.warnings.push(plan.warning);
    }

    if (plan.action === "skip") {
      result.skippedCount += 1;
      return result;
    }

    if (plan.action === "fail") {
      result.failedCount += 1;
      result.failureDetails.push(plan.failure ?? `Safe Exec could not restore ${file.label}.`);
      return result;
    }

    try {
      switch (plan.action) {
        case "mkdir":
          if (!plan.targetPath) {
            throw new Error("Missing target path for directory restore.");
          }
          await fs.mkdir(plan.targetPath, { recursive: true });
          result.restoredCount += 1;
          return result;
        case "write":
        case "write-conflict-copy":
          if (!plan.targetPath || !plan.content) {
            throw new Error("Missing target path or content for file restore.");
          }
          await fs.mkdir(path.dirname(plan.targetPath), { recursive: true });
          await fs.writeFile(plan.targetPath, plan.content);
          result.restoredCount += 1;
          return result;
        case "move":
          if (!plan.sourcePath || !plan.targetPath) {
            throw new Error("Missing source or target path for rename restore.");
          }
          await fs.mkdir(path.dirname(plan.targetPath), { recursive: true });
          await fs.rename(plan.sourcePath, plan.targetPath);
          result.restoredCount += 1;
          return result;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failedCount += 1;
      result.failureDetails.push(`Safe Exec could not restore ${file.label}: ${message}`);
      return result;
    }
  }

  private async loadRecoverableSnapshot(
    file: FileOperationSnapshotRecord
  ): Promise<{ content?: Buffer; failure?: string }> {
    if (!(await this.isRecoverableFileEntry(file))) {
      return {
        failure: `Safe Exec only stored metadata for ${file.label}.`
      };
    }

    const content = await this.readSnapshotContent(file);
    if (!content) {
      return {
        failure: `Safe Exec could not load the snapshot for ${file.label}.`
      };
    }

    return { content };
  }

  private async isRecoverableFileEntry(file: FileOperationSnapshotRecord): Promise<boolean> {
    return !file.isDirectory && ["text", "binary"].includes(file.snapshotKind) && Boolean(file.snapshotStoragePath);
  }

  private async readSnapshotContent(file: FileOperationSnapshotRecord): Promise<Buffer | undefined> {
    if (!file.snapshotStoragePath) {
      return undefined;
    }

    try {
      const snapshotPath = path.join(this.rootUri.fsPath, file.snapshotStoragePath);
      const storedContent = await fs.readFile(snapshotPath);
      if ((file.snapshotCompression ?? "none") === "gzip") {
        return Buffer.from(await gunzipAsync(storedContent));
      }

      return storedContent;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[file-store] Failed to read snapshot for ${file.label}: ${message}`);
      return undefined;
    }
  }

  private async storeSnapshotContent(snapshotKind: FileSnapshotKind, content: Buffer): Promise<StoredSnapshotContent> {
    const contentHash = hashBuffer(content);
    let storedContent = content;
    let compression: SnapshotCompression = "none";

    if (snapshotKind === "text" && content.byteLength >= TEXT_COMPRESSION_MIN_BYTES) {
      const compressed = Buffer.from(await gzipAsync(content));
      if (compressed.byteLength + TEXT_COMPRESSION_MIN_SAVINGS_BYTES < content.byteLength) {
        storedContent = compressed;
        compression = "gzip";
      }
    }

    const storagePath = this.buildBlobStoragePath(contentHash, snapshotKind, compression);
    const absoluteStoragePath = path.join(this.rootUri.fsPath, storagePath);
    await fs.mkdir(path.dirname(absoluteStoragePath), { recursive: true });
    if (!(await pathExists(absoluteStoragePath))) {
      await fs.writeFile(absoluteStoragePath, storedContent);
    }

    return {
      contentHash,
      compression,
      storagePath,
      storedBytes: storedContent.byteLength
    };
  }

  private buildBlobStoragePath(contentHash: string, snapshotKind: FileSnapshotKind, compression: SnapshotCompression): string {
    const directory = path.join("snapshots", BLOB_DIRECTORY_NAME, contentHash.slice(0, 2));
    const suffix =
      compression === "gzip" ? ".txt.gz" : snapshotKind === "binary" ? ".bin" : snapshotKind === "text" ? ".txt" : ".blob";
    return path.join(directory, `${contentHash}${suffix}`);
  }

  private async pruneIndex(indexData: FileOperationIndex): Promise<void> {
    const sorted = [...indexData.operations].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));

    while (sorted.length > MAX_STORED_OPERATIONS || (await this.computeReferencedSnapshotBytes(sorted)) > MAX_TOTAL_SNAPSHOT_BYTES) {
      const oldest = sorted.shift();
      if (!oldest) {
        break;
      }
    }

    indexData.operations = sorted;
    await this.cleanupUnreferencedSnapshotFiles(sorted);
  }

  private async computeReferencedSnapshotBytes(operations: readonly FileOperationRecord[]): Promise<number> {
    const referencedPaths = collectReferencedSnapshotPaths(operations);
    let totalBytes = 0;

    for (const relativePath of referencedPaths) {
      const file = operations
        .flatMap((operation) => operation.files)
        .find((entry) => entry.snapshotStoragePath === relativePath);
      if (file?.snapshotStoredBytes !== undefined) {
        totalBytes += file.snapshotStoredBytes;
        continue;
      }

      try {
        const stat = await fs.stat(path.join(this.rootUri.fsPath, relativePath));
        totalBytes += stat.size;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "ENOENT") {
          throw error;
        }
      }
    }

    return totalBytes;
  }

  private async cleanupUnreferencedSnapshotFiles(operations: readonly FileOperationRecord[]): Promise<void> {
    const referencedPaths = collectReferencedSnapshotPaths(operations);
    await fs.mkdir(this.snapshotRootPath, { recursive: true });
    await fs.mkdir(this.blobRootPath, { recursive: true });
    await this.removeUnreferencedEntries(this.snapshotRootPath, referencedPaths);
  }

  private async removeUnreferencedEntries(currentPath: string, referencedPaths: ReadonlySet<string>): Promise<boolean> {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return false;
      }

      throw error;
    }

    let hasReferencedChildren = false;
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(this.rootUri.fsPath, absolutePath);

      if (entry.isDirectory()) {
        const keepDirectory = await this.removeUnreferencedEntries(absolutePath, referencedPaths);
        hasReferencedChildren = hasReferencedChildren || keepDirectory;
        if (!keepDirectory) {
          await fs.rm(absolutePath, { recursive: true, force: true });
        }
        continue;
      }

      if (referencedPaths.has(relativePath)) {
        hasReferencedChildren = true;
        continue;
      }

      await fs.rm(absolutePath, { force: true });
    }

    if (currentPath === this.snapshotRootPath || currentPath === this.blobRootPath) {
      return true;
    }

    return hasReferencedChildren;
  }

  private async getExistingPathState(targetPath: string): Promise<ExistingPathState> {
    try {
      const stat = await fs.lstat(targetPath);
      if (stat.isDirectory()) {
        return {
          exists: true,
          isDirectory: true
        };
      }

      return {
        exists: true,
        isDirectory: false,
        content: await fs.readFile(targetPath)
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return {
          exists: false,
          isDirectory: false
        };
      }

      if (nodeError.code === "EISDIR") {
        return {
          exists: true,
          isDirectory: true
        };
      }

      throw error;
    }
  }

  private async nextConflictPath(targetPath: string, isDirectory: boolean): Promise<string> {
    const parsed = path.parse(targetPath);
    const baseName = isDirectory ? `${parsed.base}${RESTORE_CONFLICT_SUFFIX}` : `${parsed.name}${RESTORE_CONFLICT_SUFFIX}${parsed.ext}`;
    let candidatePath = path.join(parsed.dir, baseName);
    let counter = 2;

    while (await pathExists(candidatePath)) {
      const counterName = isDirectory
        ? `${parsed.base}${RESTORE_CONFLICT_SUFFIX}-${counter}`
        : `${parsed.name}${RESTORE_CONFLICT_SUFFIX}-${counter}${parsed.ext}`;
      candidatePath = path.join(parsed.dir, counterName);
      counter += 1;
    }

    return candidatePath;
  }

  private displayPath(targetPath: string): string {
    const uri = vscode.Uri.file(targetPath);
    return vscode.workspace.asRelativePath(uri, false) || targetPath;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.indexCache) {
      return;
    }

    await fs.mkdir(this.blobRootPath, { recursive: true });
    await this.loadIndex();
  }

  private async loadIndex(): Promise<FileOperationIndex> {
    if (this.indexCache) {
      return this.indexCache;
    }

    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      this.indexCache = normalizeIndex(JSON.parse(raw));
      return this.indexCache;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[file-store] Rebuilding file operation index after read failure: ${message}`);
      }

      this.indexCache = {
        version: 2,
        operations: []
      };
      await this.persistIndex(this.indexCache);
      return this.indexCache;
    }
  }

  private async persistIndex(indexData: FileOperationIndex): Promise<void> {
    this.indexCache = indexData;
    await fs.mkdir(this.rootUri.fsPath, { recursive: true });
    await fs.writeFile(this.indexPath, `${JSON.stringify(indexData, null, 2)}\n`, "utf8");
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function normalizeIndex(raw: unknown): FileOperationIndex {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { operations?: unknown[] }).operations)) {
    throw new Error("Malformed file operation index.");
  }

  const index = raw as { operations: unknown[] };
  return {
    version: 2,
    operations: index.operations.map((operation) => normalizeOperationRecord(operation))
  };
}

function normalizeOperationRecord(operation: unknown): FileOperationRecord {
  if (!operation || typeof operation !== "object") {
    throw new Error("Malformed file operation record.");
  }

  const record = operation as Partial<FileOperationRecord>;
  const files = Array.isArray(record.files) ? record.files.map((file) => normalizeSnapshotRecord(file)) : [];

  return {
    id: typeof record.id === "string" ? record.id : createOperationId(),
    kind: isFileOperationKind(record.kind) ? record.kind : "delete",
    risk: isRiskLevel(record.risk) ? record.risk : "medium",
    summary: typeof record.summary === "string" ? record.summary : "File operation",
    detail: typeof record.detail === "string" ? record.detail : undefined,
    recordedAt: typeof record.recordedAt === "string" ? record.recordedAt : new Date().toISOString(),
    completedAt: typeof record.completedAt === "string" ? record.completedAt : undefined,
    restoredAt: typeof record.restoredAt === "string" ? record.restoredAt : undefined,
    status: isFileOperationStatus(record.status) ? record.status : "pending",
    fileCount: typeof record.fileCount === "number" ? record.fileCount : files.filter((file) => !file.isDirectory).length,
    protectedCount: typeof record.protectedCount === "number" ? record.protectedCount : 0,
    bulk: Boolean(record.bulk),
    subtree: Boolean(record.subtree),
    recoverable: typeof record.recoverable === "boolean" ? record.recoverable : files.some((file) => isRecoverableSnapshot(file)),
    snapshotCount:
      typeof record.snapshotCount === "number"
        ? record.snapshotCount
        : files.filter((file) => file.snapshotStoragePath).length,
    metadataOnlyCount:
      typeof record.metadataOnlyCount === "number"
        ? record.metadataOnlyCount
        : files.filter((file) => file.snapshotKind === "metadata-only" && !file.isDirectory).length,
    unrecoverableCount:
      typeof record.unrecoverableCount === "number"
        ? record.unrecoverableCount
        : files.filter((file) => file.snapshotKind === "none" && !file.isDirectory).length,
    snapshotBytesCaptured:
      typeof record.snapshotBytesCaptured === "number"
        ? record.snapshotBytesCaptured
        : files.reduce((total, file) => total + (file.snapshotStoredBytes ?? 0), 0),
    bestEffortNote: typeof record.bestEffortNote === "string" ? record.bestEffortNote : undefined,
    files
  };
}

function normalizeSnapshotRecord(file: unknown): FileOperationSnapshotRecord {
  if (!file || typeof file !== "object") {
    throw new Error("Malformed file operation snapshot record.");
  }

  const record = file as Partial<FileOperationSnapshotRecord>;
  return {
    entryId: typeof record.entryId === "string" ? record.entryId : "1",
    label: typeof record.label === "string" ? record.label : "entry",
    originalUri: typeof record.originalUri === "string" ? record.originalUri : "",
    newUri: typeof record.newUri === "string" ? record.newUri : undefined,
    isDirectory: Boolean(record.isDirectory),
    size: typeof record.size === "number" ? record.size : undefined,
    subtreeFileCount: typeof record.subtreeFileCount === "number" ? record.subtreeFileCount : undefined,
    snapshotKind: isFileSnapshotKind(record.snapshotKind) ? record.snapshotKind : "none",
    snapshotStoragePath: typeof record.snapshotStoragePath === "string" ? record.snapshotStoragePath : undefined,
    snapshotContentHash: typeof record.snapshotContentHash === "string" ? record.snapshotContentHash : undefined,
    snapshotCompression: record.snapshotCompression === "gzip" ? "gzip" : "none",
    snapshotStoredBytes: typeof record.snapshotStoredBytes === "number" ? record.snapshotStoredBytes : undefined,
    detail: typeof record.detail === "string" ? record.detail : undefined
  };
}

function createOperationId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function emptyRestoreResult(): RestoreFileOperationResult {
  return {
    restoredCount: 0,
    failedCount: 0,
    skippedCount: 0,
    warnings: [],
    failureDetails: []
  };
}

function compareSnapshotRecords(left: FileOperationSnapshotRecord, right: FileOperationSnapshotRecord): number {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }

  return depth(left.label) - depth(right.label);
}

function depth(value: string): number {
  return value.split(/[\\/]/).length;
}

function isRecoverableSnapshot(file: FileOperationSnapshotRecord): boolean {
  return file.isDirectory || file.snapshotKind === "text" || file.snapshotKind === "binary";
}

function collectReferencedSnapshotPaths(operations: readonly FileOperationRecord[]): ReadonlySet<string> {
  const referencedPaths = new Set<string>();
  for (const operation of operations) {
    for (const file of operation.files) {
      if (file.snapshotStoragePath) {
        referencedPaths.add(file.snapshotStoragePath);
      }
    }
  }

  return referencedPaths;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buffersEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function hashBuffer(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function formatSnapshotListEntry(file: FileOperationSnapshotRecord): string {
  if (file.isDirectory) {
    const subtreeSuffix =
      typeof file.subtreeFileCount === "number" ? `, ${formatCount(file.subtreeFileCount, "file")} in subtree` : "";
    return `${file.label} (directory${subtreeSuffix})`;
  }

  const snapshotLabel =
    file.snapshotKind === "none"
      ? "observed only"
      : file.snapshotKind === "metadata-only"
      ? "metadata only"
      : file.snapshotCompression === "gzip"
      ? `${file.snapshotKind}, compressed`
      : file.snapshotKind;
  return `${file.label} (${snapshotLabel})`;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isFileOperationKind(value: unknown): value is FileOperationKind {
  return value === "create" || value === "delete" || value === "rename";
}

function isFileOperationStatus(value: unknown): value is FileOperationStatus {
  return value === "pending" || value === "completed" || value === "denied" || value === "restored" || value === "restore-failed";
}

function isFileSnapshotKind(value: unknown): value is FileSnapshotKind {
  return value === "text" || value === "binary" || value === "metadata-only" || value === "none";
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}
