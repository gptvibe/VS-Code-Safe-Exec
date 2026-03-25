import * as assert from "assert/strict";
import * as vscode from "vscode";
import {
  activateExtension,
  openFixtureDocument,
  resetTestState,
  waitFor,
  waitForAuditEvent,
  waitForSafeExecDiffTab
} from "./helpers";

suite("edit interception", () => {
  test("opens a real diff when review is requested", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("review");
    api.queueApproval("deny");

    const document = await openFixtureDocument("sample.ts");
    const originalText = document.getText();
    const updatedText = `${originalText}\nexport const safeExecReviewed = true;\n`;
    await replaceDocumentText(document, updatedText);

    await waitForAuditEvent(api, "edit", "reviewed", (event) => event.summary.includes("sample.ts"));
    const diffTab = await waitForSafeExecDiffTab();
    assert.ok(diffTab.input instanceof vscode.TabInputTextDiff);
    assert.equal(diffTab.input.original.scheme, "safe-exec-review");
    assert.equal(diffTab.input.modified.scheme, "safe-exec-review");
    await waitForAuditEvent(api, "edit", "denied", (event) => event.summary.includes("sample.ts"));
    await waitFor(async () => (await vscode.workspace.openTextDocument(document.uri)).getText() === originalText);
  });

  test("rolls back a suspicious edit and reapplies it with captured ranges after approval", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("allow");

    const document = await openFixtureDocument("sample.ts");
    const originalText = document.getText();
    const updatedText = `${originalText}\nexport const safeExecRangeApproved = true;\n`;
    await replaceDocumentText(document, updatedText);

    await waitForAuditEvent(api, "edit", "intercepted", (event) => event.summary.includes("sample.ts"));
    await waitForAuditEvent(api, "edit", "approved", (event) => event.summary.includes("sample.ts"));
    await waitForAuditEvent(api, "edit", "range-based", (event) => event.summary.includes("sample.ts"));
    await waitFor(async () => (await vscode.workspace.openTextDocument(document.uri)).getText() === updatedText);
  });

  test("rolls back a suspicious edit and keeps the rollback after denial", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("deny");

    const document = await openFixtureDocument("sample.ts");
    const originalText = document.getText();
    const updatedText = `${originalText}\nexport const safeExecDenied = true;\n`;
    await replaceDocumentText(document, updatedText);

    await waitForAuditEvent(api, "edit", "intercepted", (event) => event.summary.includes("sample.ts"));
    await waitForAuditEvent(api, "edit", "denied", (event) => event.summary.includes("sample.ts"));
    await waitFor(async () => (await vscode.workspace.openTextDocument(document.uri)).getText() === originalText);
  });

  test("falls back to whole-document replacement when range reapply is unavailable", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.forceNextEditRangeReapplyFailure();
    api.queueApproval("allow");

    const document = await openFixtureDocument("sample.ts");
    const originalText = document.getText();
    const updatedText = `${originalText}\nexport const safeExecFallbackApproved = true;\n`;
    await replaceDocumentText(document, updatedText);

    await waitForAuditEvent(api, "edit", "approved", (event) => event.summary.includes("sample.ts"));
    await waitForAuditEvent(api, "edit", "whole-document-fallback", (event) => event.summary.includes("sample.ts"));
    await waitFor(async () => (await vscode.workspace.openTextDocument(document.uri)).getText() === updatedText);
  });

  test("keeps the rollback when the document changes during approval", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    const approval = api.createDeferredApproval();

    const document = await openFixtureDocument("sample.ts");
    const originalText = document.getText();
    const updatedText = `${originalText}\nexport const safeExecConflictApproved = true;\n`;
    await replaceDocumentText(document, updatedText);

    await waitForAuditEvent(api, "edit", "intercepted", (event) => event.summary.includes("sample.ts"));
    await waitFor(async () => (await vscode.workspace.openTextDocument(document.uri)).getText() === originalText);

    const conflictingText = `${originalText}\nexport const safeExecManualConflict = true;\n`;
    await replaceDocumentText(await vscode.workspace.openTextDocument(document.uri), conflictingText);
    await waitFor(async () => (await vscode.workspace.openTextDocument(document.uri)).getText().includes("safeExecManualConflict"));
    approval.allow();

    await waitForAuditEvent(api, "edit", "approved", (event) => event.summary.includes("sample.ts"));
    await waitForAuditEvent(api, "edit", "conflict-cancelled", (event) => event.summary.includes("sample.ts"));
    const editEvents = api.getAuditEvents(20).filter((event) => event.surface === "edit" && event.summary.includes("sample.ts"));
    assert.equal(
      editEvents.some((event) => event.action === "range-based" || event.action === "whole-document-fallback"),
      false
    );
  });
});

async function replaceDocumentText(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  const applied = await vscode.workspace.applyEdit(edit);
  assert.ok(applied);
}
