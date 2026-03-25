import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { RiskLevel } from "./rules";

export type FileOperationKind = "create" | "delete" | "rename";
export type FileOperationStatus = "pending" | "completed" | "denied" | "restored" | "restore-failed";
export type FileSnapshotKind = "text" | "binary" | "metadata-only" | "none";

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

interface FileOperationIndex {
  version: 1;
  operations: FileOperationRecord[];
}

const INDEX_FILE_NAME = "index.json";
const SNAPSHOT_DIRECTORY_NAME = "snapshots";
const MAX_STORED_OPERATIONS = 60;
const MAX_TOTAL_SNAPSHOT_BYTES = 20 * 1024 * 1024;

export class FileOperationRecoveryStore {
  private readonly indexPath: string;
  private readonly snapshotRootPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private indexCache: FileOperationIndex | undefined;

  public constructor(private readonly rootUri: vscode.Uri, private readonly output: vscode.OutputChannel) {
    this.indexPath = path.join(this.rootUri.fsPath, INDEX_FILE_NAME);
    this.snapshotRootPath = path.join(this.rootUri.fsPath, SNAPSHOT_DIRECTORY_NAME);
  }

  public async initialize(): Promise<void> {
    await this.enqueue(async () => {
      await fs.mkdir(this.snapshotRootPath, { recursive: true });
      await this.loadIndex();
    });
  }

  public async clear(): Promise<void> {
    await this.enqueue(async () => {
      await fs.rm(this.rootUri.fsPath, { recursive: true, force: true });
      this.indexCache = undefined;
      await fs.mkdir(this.snapshotRootPath, { recursive: true });
      await this.persistIndex({
        version: 1,
        operations: []
      });
    });
  }

  public async saveOperation(input: FileOperationRecordInput): Promise<FileOperationRecord> {
    return this.enqueue(async () => {
      await this.ensureInitialized();

      const operationId = input.id ?? createOperationId();
      const operationSnapshotPath = path.join(this.snapshotRootPath, operationId);
      await fs.mkdir(operationSnapshotPath, { recursive: true });

      let snapshotBytesCaptured = 0;
      let snapshotCount = 0;
      let metadataOnlyCount = 0;
      let unrecoverableCount = 0;

      const files: FileOperationSnapshotRecord[] = [];
      for (const [index, file] of input.files.entries()) {
        const entryId = file.entryId ?? `${index + 1}`;
        let snapshotStoragePath: string | undefined;

        if (file.snapshotContent !== undefined) {
          const extension = file.snapshotKind === "text" ? ".txt" : ".bin";
          snapshotStoragePath = path.join("snapshots", operationId, `${entryId}${extension}`);
          const absoluteSnapshotPath = path.join(this.rootUri.fsPath, snapshotStoragePath);
          const content = typeof file.snapshotContent === "string" ? Buffer.from(file.snapshotContent, "utf8") : Buffer.from(file.snapshotContent);
          await fs.writeFile(absoluteSnapshotPath, content);
          snapshotBytesCaptured += content.byteLength;
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

  public async renderMarkdown(limit = 20): Promise<string> {
    const operations = await this.getRecentOperations(limit);
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

      const previewFiles = operation.files.slice(0, 8).map((file) => {
        const snapshotLabel = file.snapshotKind === "none" ? "observed only" : file.snapshotKind;
        return `${file.label} (${snapshotLabel})`;
      });

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
        const restoreOutcome =
          operation.kind === "delete"
            ? await this.restoreDeletedEntry(file)
            : await this.restoreRenamedEntry(file);

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

  private async restoreDeletedEntry(file: FileOperationSnapshotRecord): Promise<RestoreFileOperationResult> {
    const result = emptyRestoreResult();
    const targetUri = vscode.Uri.parse(file.originalUri);

    if (file.isDirectory) {
      await fs.mkdir(targetUri.fsPath, { recursive: true });
      result.restoredCount += 1;
      return result;
    }

    if (!(await this.isRecoverableFileEntry(file))) {
      result.failedCount += 1;
      result.failureDetails.push(`Safe Exec only stored metadata for ${file.label}.`);
      return result;
    }

    if (await pathExists(targetUri.fsPath)) {
      result.skippedCount += 1;
      result.warnings.push(`Skipped ${file.label} because the original path already exists.`);
      return result;
    }

    const content = await this.readSnapshotContent(file);
    if (!content) {
      result.failedCount += 1;
      result.failureDetails.push(`Safe Exec could not load the snapshot for ${file.label}.`);
      return result;
    }

    await fs.mkdir(path.dirname(targetUri.fsPath), { recursive: true });
    await fs.writeFile(targetUri.fsPath, content);
    result.restoredCount += 1;
    return result;
  }

  private async restoreRenamedEntry(file: FileOperationSnapshotRecord): Promise<RestoreFileOperationResult> {
    const result = emptyRestoreResult();
    const oldUri = vscode.Uri.parse(file.originalUri);
    const newUri = file.newUri ? vscode.Uri.parse(file.newUri) : undefined;

    if (await pathExists(oldUri.fsPath)) {
      result.skippedCount += 1;
      result.warnings.push(`Skipped ${file.label} because the original path already exists.`);
      return result;
    }

    if (file.isDirectory && newUri && (await pathExists(newUri.fsPath))) {
      await fs.mkdir(path.dirname(oldUri.fsPath), { recursive: true });
      await fs.rename(newUri.fsPath, oldUri.fsPath);
      result.restoredCount += 1;
      return result;
    }

    if (!newUri) {
      result.failedCount += 1;
      result.failureDetails.push(`Safe Exec does not know where ${file.label} was renamed to.`);
      return result;
    }

    if (!(await this.isRecoverableFileEntry(file))) {
      result.failedCount += 1;
      result.failureDetails.push(`Safe Exec only stored metadata for ${file.label}.`);
      return result;
    }

    const content = await this.readSnapshotContent(file);
    if (!content) {
      result.failedCount += 1;
      result.failureDetails.push(`Safe Exec could not load the snapshot for ${file.label}.`);
      return result;
    }

    if (await pathExists(newUri.fsPath)) {
      const currentNewContent = await readFileIfExists(newUri.fsPath);
      if (currentNewContent && buffersEqual(currentNewContent, content)) {
        await fs.mkdir(path.dirname(oldUri.fsPath), { recursive: true });
        await fs.rename(newUri.fsPath, oldUri.fsPath);
        result.restoredCount += 1;
        return result;
      }
    }

    await fs.mkdir(path.dirname(oldUri.fsPath), { recursive: true });
    await fs.writeFile(oldUri.fsPath, content);
    result.restoredCount += 1;

    if (await pathExists(newUri.fsPath)) {
      result.warnings.push(`Restored ${file.label} from the snapshot and kept the renamed path because its current contents differ.`);
    }

    return result;
  }

  private async isRecoverableFileEntry(file: FileOperationSnapshotRecord): Promise<boolean> {
    return !file.isDirectory && ["text", "binary"].includes(file.snapshotKind) && Boolean(file.snapshotStoragePath);
  }

  private async readSnapshotContent(file: FileOperationSnapshotRecord): Promise<Buffer | undefined> {
    if (!file.snapshotStoragePath) {
      return undefined;
    }

    try {
      return await fs.readFile(path.join(this.rootUri.fsPath, file.snapshotStoragePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[file-store] Failed to read snapshot for ${file.label}: ${message}`);
      return undefined;
    }
  }

  private async pruneIndex(indexData: FileOperationIndex): Promise<void> {
    const sorted = [...indexData.operations].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));

    let totalSnapshotBytes = sorted.reduce((total, operation) => total + operation.snapshotBytesCaptured, 0);
    while (sorted.length > MAX_STORED_OPERATIONS || totalSnapshotBytes > MAX_TOTAL_SNAPSHOT_BYTES) {
      const oldest = sorted.shift();
      if (!oldest) {
        break;
      }

      totalSnapshotBytes -= oldest.snapshotBytesCaptured;
      await fs.rm(path.join(this.snapshotRootPath, oldest.id), { recursive: true, force: true });
    }

    indexData.operations = sorted;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.indexCache) {
      return;
    }

    await fs.mkdir(this.snapshotRootPath, { recursive: true });
    await this.loadIndex();
  }

  private async loadIndex(): Promise<FileOperationIndex> {
    if (this.indexCache) {
      return this.indexCache;
    }

    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      this.indexCache = JSON.parse(raw) as FileOperationIndex;
      if (!this.indexCache || !Array.isArray(this.indexCache.operations)) {
        throw new Error("Malformed file operation index.");
      }
      return this.indexCache;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[file-store] Rebuilding file operation index after read failure: ${message}`);
      }

      this.indexCache = {
        version: 1,
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(targetPath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(targetPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }

    throw error;
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
