import * as assert from "assert/strict";
import * as vscode from "vscode";
import { selectCriticalReplayDecision } from "../../terminalInterceptor";
import { activateExtension, closeSafeExecTerminals, getFixtureUri, resetTestState, waitForAuditEvent, writeWorkspaceSettings } from "./helpers";

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

  test("manual critical replay policy copies the command to the clipboard instead of auto-replaying", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    await writeWorkspaceSettings({
      "safeExec.terminal.criticalReplayPolicy": "manualReplay"
    });
    api.queueApproval("allow");

    const criticalCommand = "rm -rf SAFE_EXEC_TEST_TARGET";
    const terminal = vscode.window.createTerminal({ name: "Safe Exec Test Terminal Manual Replay" });
    await api.simulateTerminalCommand({
      terminal,
      commandLine: criticalCommand,
      cwd: getFixtureUri(),
      isTrusted: true,
      confidence: vscode.TerminalShellExecutionCommandLineConfidence.High
    });

    const approvedEvent = await waitForAuditEvent(api, "terminal", "approved", (event) => event.summary === criticalCommand);
    const clipboardEvent = await waitForAuditEvent(api, "terminal", "clipboard-copied", (event) => event.summary === criticalCommand);
    const manualReplayEvent = await waitForAuditEvent(api, "terminal", "manual-replay", (event) => event.summary === criticalCommand);

    assert.equal(approvedEvent.metadata?.outcome, "manual-replay");
    assert.equal(approvedEvent.metadata?.criticalReplayPolicy, "manualReplay");
    assert.equal(clipboardEvent.metadata?.criticalReplayPolicy, "manualReplay");
    assert.equal(await vscode.env.clipboard.readText(), criticalCommand);
    assert.match(manualReplayEvent.detail ?? "", /requires manual replay/i);
    assert.ok(vscode.window.terminals.some((candidate) => candidate.name.includes("Safe Exec Manual Replay")));
    assert.equal(
      api.getAuditEvents(20).filter((event) => event.surface === "terminal" && event.action === "replayed" && event.summary === criticalCommand)
        .length,
      0
    );
    await closeSafeExecTerminals();
  });

  test("critical replay decision matrix covers automatic, manual, and blocked outcomes", () => {
    assert.deepEqual(
      selectCriticalReplayDecision({
        policy: "bestEffort",
        stopConfirmed: false,
        shellIntegrationAvailable: false
      }),
      {
        kind: "automatic",
        shellIntegrationRequired: false
      }
    );

    assert.deepEqual(
      selectCriticalReplayDecision({
        policy: "shellIntegrationOnly",
        stopConfirmed: true,
        shellIntegrationAvailable: true
      }),
      {
        kind: "automatic",
        shellIntegrationRequired: true
      }
    );

    assert.deepEqual(
      selectCriticalReplayDecision({
        policy: "shellIntegrationOnly",
        stopConfirmed: false,
        shellIntegrationAvailable: true
      }),
      {
        kind: "manual",
        reason: "stopUnconfirmed"
      }
    );

    assert.deepEqual(
      selectCriticalReplayDecision({
        policy: "shellIntegrationOnly",
        stopConfirmed: true,
        shellIntegrationAvailable: false
      }),
      {
        kind: "manual",
        reason: "shellIntegrationUnavailable"
      }
    );

    assert.deepEqual(
      selectCriticalReplayDecision({
        policy: "manualReplay",
        stopConfirmed: true,
        shellIntegrationAvailable: true
      }),
      {
        kind: "manual",
        reason: "manualPolicy"
      }
    );

    assert.deepEqual(
      selectCriticalReplayDecision({
        policy: "denyIfStopUnconfirmed",
        stopConfirmed: false,
        shellIntegrationAvailable: true
      }),
      {
        kind: "deny",
        reason: "stopUnconfirmed"
      }
    );

    assert.deepEqual(
      selectCriticalReplayDecision({
        policy: "denyIfStopUnconfirmed",
        stopConfirmed: true,
        shellIntegrationAvailable: false
      }),
      {
        kind: "manual",
        reason: "shellIntegrationUnavailable"
      }
    );

    assert.deepEqual(
      selectCriticalReplayDecision({
        policy: "denyIfStopUnconfirmed",
        stopConfirmed: true,
        shellIntegrationAvailable: true
      }),
      {
        kind: "automatic",
        shellIntegrationRequired: true
      }
    );
  });
});
