import * as assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { FileOperationRecoveryStore } from "../../fileOperationRecoveryStore";

suite("file operation recovery store", () => {
  test("deduplicates identical text snapshots and compresses large text content", async () => {
    const harness = await createStoreHarness();
    try {
      const content = "safe-exec repeated line\n".repeat(4000);
      const first = await harness.store.saveOperation({
        kind: "delete",
        risk: "medium",
        summary: "Delete first.txt",
        fileCount: 1,
        protectedCount: 0,
        bulk: false,
        subtree: false,
        files: [
          {
            label: "first.txt",
            originalUri: vscode.Uri.file(path.join(harness.workspacePath, "first.txt")).toString(),
            isDirectory: false,
            snapshotKind: "text",
            snapshotContent: content
          }
        ]
      });
      const second = await harness.store.saveOperation({
        kind: "delete",
        risk: "medium",
        summary: "Delete second.txt",
        fileCount: 1,
        protectedCount: 0,
        bulk: false,
        subtree: false,
        files: [
          {
            label: "second.txt",
            originalUri: vscode.Uri.file(path.join(harness.workspacePath, "second.txt")).toString(),
            isDirectory: false,
            snapshotKind: "text",
            snapshotContent: content
          }
        ]
      });

      const firstSnapshot = first.files[0];
      const secondSnapshot = second.files[0];
      assert.equal(firstSnapshot.snapshotContentHash, secondSnapshot.snapshotContentHash);
      assert.equal(firstSnapshot.snapshotStoragePath, secondSnapshot.snapshotStoragePath);
      assert.equal(firstSnapshot.snapshotCompression, "gzip");

      const storedPath = path.join(harness.storeRootPath, firstSnapshot.snapshotStoragePath ?? "");
      const storedStat = await fs.stat(storedPath);
      assert.ok(storedStat.size < Buffer.byteLength(content));
    } finally {
      await harness.dispose();
    }
  });

  test("binary snapshots restore exact bytes", async () => {
    const harness = await createStoreHarness();
    try {
      const binaryPath = path.join(harness.workspacePath, "binary.dat");
      const binaryContent = Buffer.from([0, 255, 127, 10, 13, 64, 32]);
      const operation = await harness.store.saveOperation({
        kind: "delete",
        risk: "medium",
        summary: "Delete binary.dat",
        fileCount: 1,
        protectedCount: 0,
        bulk: false,
        subtree: false,
        files: [
          {
            label: "binary.dat",
            originalUri: vscode.Uri.file(binaryPath).toString(),
            isDirectory: false,
            snapshotKind: "binary",
            snapshotContent: binaryContent
          }
        ]
      });

      const preview = await harness.store.previewRestoreOperation(operation.id);
      assert.equal(preview.directRestoreCount, 1);
      assert.equal(preview.unavailableCount, 0);

      const result = await harness.store.restoreOperation(operation.id);
      assert.equal(result.restoredCount, 1);
      assert.equal(result.failedCount, 0);

      const restoredBytes = await fs.readFile(binaryPath);
      assert.deepEqual(restoredBytes, binaryContent);
    } finally {
      await harness.dispose();
    }
  });

  test("preview and restore stay partial when metadata-only entries are mixed with recoverable ones", async () => {
    const harness = await createStoreHarness();
    try {
      const recoverablePath = path.join(harness.workspacePath, "recoverable.txt");
      const metadataOnlyPath = path.join(harness.workspacePath, "large.txt");
      const operation = await harness.store.saveOperation({
        kind: "delete",
        risk: "high",
        summary: "Delete mixed subtree",
        fileCount: 2,
        protectedCount: 0,
        bulk: false,
        subtree: true,
        files: [
          {
            label: "recoverable.txt",
            originalUri: vscode.Uri.file(recoverablePath).toString(),
            isDirectory: false,
            snapshotKind: "text",
            snapshotContent: "restorable\n"
          },
          {
            label: "large.txt",
            originalUri: vscode.Uri.file(metadataOnlyPath).toString(),
            isDirectory: false,
            snapshotKind: "metadata-only",
            detail: "Oversize snapshot skipped."
          }
        ]
      });

      const preview = await harness.store.previewRestoreOperation(operation.id);
      assert.equal(preview.directRestoreCount, 1);
      assert.equal(preview.unavailableCount, 1);
      assert.equal(preview.partial, true);

      const result = await harness.store.restoreOperation(operation.id);
      assert.equal(result.restoredCount, 1);
      assert.equal(result.failedCount, 1);
      assert.equal(await fs.readFile(recoverablePath, "utf8"), "restorable\n");
      assert.equal(await pathExists(metadataOnlyPath), false);
    } finally {
      await harness.dispose();
    }
  });

  test("restore conflicts create sibling copies instead of overwriting existing files", async () => {
    const harness = await createStoreHarness();
    try {
      const conflictedPath = path.join(harness.workspacePath, "sample.txt");
      const operation = await harness.store.saveOperation({
        kind: "delete",
        risk: "medium",
        summary: "Delete sample.txt",
        fileCount: 1,
        protectedCount: 0,
        bulk: false,
        subtree: false,
        files: [
          {
            label: "sample.txt",
            originalUri: vscode.Uri.file(conflictedPath).toString(),
            isDirectory: false,
            snapshotKind: "text",
            snapshotContent: "original\n"
          }
        ]
      });

      await fs.mkdir(path.dirname(conflictedPath), { recursive: true });
      await fs.writeFile(conflictedPath, "current\n", "utf8");

      const preview = await harness.store.previewRestoreOperation(operation.id);
      assert.equal(preview.conflictCopyCount, 1);
      assert.equal(preview.partial, true);

      const result = await harness.store.restoreOperation(operation.id);
      assert.equal(result.restoredCount, 1);
      assert.equal(result.failedCount, 0);
      assert.match(result.warnings.join(" "), /safe-exec-restore/);

      assert.equal(await fs.readFile(conflictedPath, "utf8"), "current\n");
      const conflictPath = path.join(harness.workspacePath, "sample.safe-exec-restore.txt");
      assert.equal(await fs.readFile(conflictPath, "utf8"), "original\n");
    } finally {
      await harness.dispose();
    }
  });
});

async function createStoreHarness(): Promise<{
  store: FileOperationRecoveryStore;
  storeRootPath: string;
  workspacePath: string;
  dispose: () => Promise<void>;
}> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "safe-exec-file-store-"));
  const workspacePath = path.join(rootPath, "workspace");
  const storeRootPath = path.join(rootPath, "store");
  await fs.mkdir(workspacePath, { recursive: true });
  const output = vscode.window.createOutputChannel("Safe Exec File Store Test");
  const store = new FileOperationRecoveryStore(vscode.Uri.file(storeRootPath), output);
  await store.initialize();

  return {
    store,
    storeRootPath,
    workspacePath,
    dispose: async () => {
      output.dispose();
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
