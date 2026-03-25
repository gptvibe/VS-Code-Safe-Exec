import * as assert from "assert/strict";
import * as vscode from "vscode";
import { activateExtension, openFixtureDocument, resetTestState, waitFor, waitForAuditEvent } from "./helpers";

suite("edit interception", () => {
  teardown(async () => {
    const api = await activateExtension();
    await resetTestState(api);
  });

  test("rolls back a suspicious edit and reapplies it after approval", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("allow");

    const document = await openFixtureDocument("sample.ts");
    const originalText = document.getText();
    const updatedText = `${originalText}\nexport const safeExecApproved = true;\n`;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(originalText.length)), updatedText);
    const applied = await vscode.workspace.applyEdit(edit);
    assert.ok(applied);

    await waitForAuditEvent(api, "edit", "intercepted", (event) => event.summary.includes("sample.ts"));
    await waitForAuditEvent(api, "edit", "approved", (event) => event.summary.includes("sample.ts"));
    await waitFor(async () => (await vscode.workspace.openTextDocument(document.uri)).getText() === updatedText);
  });

  test("rolls back a suspicious edit and keeps the rollback after denial", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("deny");

    const document = await openFixtureDocument("sample.ts");
    const originalText = document.getText();
    const updatedText = `${originalText}\nexport const safeExecDenied = true;\n`;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(originalText.length)), updatedText);
    const applied = await vscode.workspace.applyEdit(edit);
    assert.ok(applied);

    await waitForAuditEvent(api, "edit", "intercepted", (event) => event.summary.includes("sample.ts"));
    await waitForAuditEvent(api, "edit", "denied", (event) => event.summary.includes("sample.ts"));
    await waitFor(async () => (await vscode.workspace.openTextDocument(document.uri)).getText() === originalText);
  });
});
