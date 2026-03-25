import * as assert from "assert/strict";
import * as vscode from "vscode";
import { activateExtension, closeSafeExecTerminals, getFixtureUri, resetTestState, waitForAuditEvent } from "./helpers";

suite("terminal interception", () => {
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

    await waitForAuditEvent(api, "terminal", "matched", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await waitForAuditEvent(api, "terminal", "interrupted-attempted", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await waitForAuditEvent(api, "terminal", "dispose-attempted", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
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

    await waitForAuditEvent(api, "terminal", "matched", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await waitForAuditEvent(api, "terminal", "interrupted-attempted", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await waitForAuditEvent(api, "terminal", "dispose-attempted", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await waitForAuditEvent(api, "terminal", "approved", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await waitForAuditEvent(api, "terminal", "replayed", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    assert.ok(vscode.window.terminals.some((candidate) => candidate.name.includes("Safe Exec Replay")));
    await closeSafeExecTerminals();
  });

  test("records degraded replay context when replay fidelity is reduced", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("allow");

    const terminal = vscode.window.createTerminal({ name: "Safe Exec Test Terminal Degraded" });
    await api.simulateTerminalCommand({
      terminal,
      commandLine: "echo SAFE_EXEC_TEST_RISKY",
      isTrusted: false,
      confidence: vscode.TerminalShellExecutionCommandLineConfidence.Low
    });

    const degradedEvent = await waitForAuditEvent(
      api,
      "terminal",
      "replay-degraded",
      (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY"
    );
    assert.match(degradedEvent.detail ?? "", /cwd unknown|command line was not reported as trusted|replay may not match original shell state/i);
    await waitForAuditEvent(api, "terminal", "replayed", (event) => event.summary === "echo SAFE_EXEC_TEST_RISKY");
    await closeSafeExecTerminals();
  });
});
