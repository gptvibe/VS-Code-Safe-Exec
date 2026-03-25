import * as assert from "assert/strict";
import * as vscode from "vscode";
import {
  activateExtension,
  fixtureExists,
  getFixtureUri,
  readFixtureFile,
  resetTestState,
  waitFor,
  waitForAuditEvent,
  writeFixtureFile
} from "./helpers";

suite("file operation interception", () => {
  test("protected file delete creates a recoverable snapshot and audit event", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    const protectedUri = getFixtureUri("test-protected.txt");
    await deleteFiles([protectedUri]);

    await waitFor(async () => !(await fixtureExists("test-protected.txt")));
    const evaluated = await waitForAuditEvent(api, "file", "intercepted", (event) => event.summary.includes("test-protected.txt"));
    const snapshot = await waitForAuditEvent(api, "file", "snapshot-created", (event) => event.summary.includes("test-protected.txt"));
    const deleted = await waitForAuditEvent(api, "file", "delete", (event) => event.summary.includes("test-protected.txt"));

    assert.equal(evaluated.risk, "high");
    assert.equal(snapshot.metadata?.snapshotCount, 1);
    assert.equal(deleted.metadata?.recoverable, true);
  });

  test("protected file rename creates a recoverable snapshot and audit event", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    const originalUri = getFixtureUri("test-protected.txt");
    const renamedUri = getFixtureUri("renamed-protected.txt");
    await renameFile(originalUri, renamedUri);

    await waitFor(async () => (await fixtureExists("renamed-protected.txt")) && !(await fixtureExists("test-protected.txt")));
    const evaluated = await waitForAuditEvent(api, "file", "intercepted", (event) => event.summary.includes("test-protected.txt"));
    const snapshot = await waitForAuditEvent(api, "file", "snapshot-created", (event) => event.summary.includes("test-protected.txt"));
    const renamed = await waitForAuditEvent(api, "file", "rename", (event) => event.summary.includes("test-protected.txt"));

    assert.equal(evaluated.risk, "critical");
    assert.equal(snapshot.metadata?.snapshotCount, 1);
    assert.equal(renamed.metadata?.recoverable, true);
  });

  test("restoring a deleted text file works", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    const originalText = await readFixtureFile("sample.ts");
    const sampleUri = getFixtureUri("sample.ts");
    await deleteFiles([sampleUri]);

    await waitFor(async () => !(await fixtureExists("sample.ts")));
    await waitForAuditEvent(api, "file", "delete", (event) => event.summary.includes("sample.ts"));

    await vscode.commands.executeCommand("safeExec.restoreLastRecoverableFileOperation");
    await waitFor(async () => await fixtureExists("sample.ts"));
    await waitForAuditEvent(api, "file", "restored", (event) => event.summary.includes("sample.ts"));

    assert.equal(await readFixtureFile("sample.ts"), originalText);
  });

  test("restoring a renamed text file works", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    const originalText = await readFixtureFile("sample.ts");
    const originalUri = getFixtureUri("sample.ts");
    const renamedUri = getFixtureUri("sample-renamed.ts");
    await renameFile(originalUri, renamedUri);

    await waitFor(async () => (await fixtureExists("sample-renamed.ts")) && !(await fixtureExists("sample.ts")));
    await waitForAuditEvent(api, "file", "rename", (event) => event.summary.includes("sample.ts"));

    await vscode.commands.executeCommand("safeExec.restoreLastRecoverableFileOperation");
    await waitFor(async () => (await fixtureExists("sample.ts")) && !(await fixtureExists("sample-renamed.ts")));
    await waitForAuditEvent(api, "file", "restored", (event) => event.summary.includes("sample.ts"));

    assert.equal(await readFixtureFile("sample.ts"), originalText);
  });

  test("oversized file falls back to metadata-only behavior", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    await writeFixtureFile("oversized.txt", "x".repeat(300000));
    const oversizedUri = getFixtureUri("oversized.txt");
    await deleteFiles([oversizedUri]);

    await waitFor(async () => !(await fixtureExists("oversized.txt")));
    const metadataOnly = await waitForAuditEvent(api, "file", "metadata-only", (event) => event.summary.includes("oversized.txt"));
    const unrecoverable = await waitForAuditEvent(api, "file", "unrecoverable", (event) => event.summary.includes("oversized.txt"));

    assert.equal(metadataOnly.metadata?.metadataOnlyCount, 1);
    assert.equal(unrecoverable.metadata?.operationId !== undefined, true);
  });

  test("bulk delete is classified at higher risk", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    const bulkUris: vscode.Uri[] = [];
    for (let index = 0; index < 12; index += 1) {
      const relativePath = `bulk-${index}.txt`;
      await writeFixtureFile(relativePath, `bulk fixture ${index}\n`);
      bulkUris.push(getFixtureUri(relativePath));
    }

    await deleteFiles(bulkUris);
    const deleted = await waitForAuditEvent(api, "file", "delete", (event) => event.summary.includes("12 file(s)"));
    assert.equal(deleted.risk, "high");
    assert.equal(deleted.metadata?.fileCount, 12);
  });
});

async function deleteFiles(uris: readonly vscode.Uri[]): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  for (const uri of uris) {
    edit.deleteFile(uri, { recursive: true, ignoreIfNotExists: false });
  }

  const applied = await vscode.workspace.applyEdit(edit);
  assert.ok(applied, "Expected the delete file edit to apply.");
}

async function renameFile(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(oldUri, newUri, { overwrite: false, ignoreIfExists: false });
  const applied = await vscode.workspace.applyEdit(edit);
  assert.ok(applied, "Expected the rename file edit to apply.");
}
