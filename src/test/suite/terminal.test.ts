import * as assert from "assert/strict";
import * as vscode from "vscode";
import { activateExtension, closeSafeExecTerminals, getFixtureUri, resetTestState, waitForAuditEvent } from "./helpers";

suite("terminal interception", () => {
  teardown(async () => {
    const api = await activateExtension();
    await resetTestState(api);
  });

  test("matches a risky terminal command and records the deny path", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("deny");

    const terminal = vscode.window.createTerminal({ name: "Safe Exec Test Terminal Deny" });
    await api.simulateTerminalCommand({
      terminal,
      commandLine: "echo SAFE_EXEC_TEST_RISKY",
      cwd: getFixtureUri(),
      isTrusted: true,
      confidence: vscode.TerminalShellExecutionCommandLineConfidence.High
    });

    await waitForAuditEvent(api, "terminal", "intercepted", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await waitForAuditEvent(api, "terminal", "denied", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    assert.equal(
      api.getAuditEvents(20).filter((event) => event.surface === "terminal" && event.action === "replayed").length,
      0
    );
    await closeSafeExecTerminals();
  });

  test("matches a risky terminal command and records the approve/replay path", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("allow");

    const terminal = vscode.window.createTerminal({ name: "Safe Exec Test Terminal Approve" });
    await api.simulateTerminalCommand({
      terminal,
      commandLine: "echo SAFE_EXEC_TEST_RISKY",
      cwd: getFixtureUri(),
      isTrusted: true,
      confidence: vscode.TerminalShellExecutionCommandLineConfidence.High
    });

    await waitForAuditEvent(api, "terminal", "approved", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await waitForAuditEvent(api, "terminal", "replayed", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    assert.ok(vscode.window.terminals.some((candidate) => candidate.name.includes("Safe Exec Replay")));
    await closeSafeExecTerminals();
  });
});
