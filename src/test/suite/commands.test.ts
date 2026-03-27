import * as assert from "assert/strict";
import * as vscode from "vscode";
import {
  EXPLICIT_PROXY_COMMAND_DEFINITIONS,
  VERIFIED_EXPLICIT_PROXY_COMMAND_DEFINITIONS
} from "../../protectedCommandCatalog";
import { activateExtension, delay, resetTestState, waitForAuditEvent, writeWorkspaceSettings } from "./helpers";

suite("protected commands", () => {
  test("current VS Code host exposes the documented automation-heavy command IDs", async () => {
    await activateExtension();

    const availableCommands = await vscode.commands.getCommands(true);
    const missingCommands = VERIFIED_EXPLICIT_PROXY_COMMAND_DEFINITIONS.flatMap((definition) =>
      availableCommands.includes(definition.targetCommand) ? [] : [definition.targetCommand]
    );

    assert.deepEqual(missingCommands, []);
  });

  test("package manifest contributes the explicit proxy runtime registry", async () => {
    const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === "vscode-safe-exec");
    assert.ok(extension, "Safe Exec extension was not found in the extension host.");

    const contributedCommands: string[] = extension.packageJSON.contributes.commands.map(
      (entry: { command: string }) => entry.command
    );
    const activationEvents: string[] = extension.packageJSON.activationEvents;

    for (const definition of EXPLICIT_PROXY_COMMAND_DEFINITIONS) {
      assert.equal(contributedCommands.includes(definition.proxyCommand), true, `Expected ${definition.proxyCommand} in package.json.`);
      assert.equal(
        activationEvents.includes(`onCommand:${definition.proxyCommand}`),
        true,
        `Expected onCommand:${definition.proxyCommand} activation in package.json.`
      );
    }
  });

  test("runs an approved protected command through the wrapper", async () => {
    const api = await activateExtension();
    await resetTestState(api);
    api.queueApproval("allow");

    let invocationCount = 0;
    const disposable = vscode.commands.registerCommand("test.safeExecTarget", (...args: unknown[]) => {
      invocationCount += 1;
      return args;
    });

    try {
      await writeWorkspaceSettings({
        "safeExec.protectedCommands": ["test.safeExecTarget"]
      });
      await vscode.commands.executeCommand("safeExec.reloadRules");
      const result = await vscode.commands.executeCommand<unknown[]>("safeExec.runProtectedCommand", "test.safeExecTarget", [
        "payload"
      ]);
      assert.equal(invocationCount, 1);
      assert.deepEqual(result, ["payload"]);
      await waitForAuditEvent(
        api,
        "command",
        "approved",
        (event) => event.summary === 'Approved "test.safeExecTarget"'
      );
    } finally {
      disposable.dispose();
    }
  });

  test("raw protected command invocations remain out of scope unless wrapped", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    let invocationCount = 0;
    const disposable = vscode.commands.registerCommand("test.safeExecRawTarget", (...args: unknown[]) => {
      invocationCount += 1;
      return args;
    });

    try {
      await writeWorkspaceSettings({
        "safeExec.protectedCommands": ["test.safeExecRawTarget"]
      });
      await vscode.commands.executeCommand("safeExec.reloadRules");

      const result = await vscode.commands.executeCommand<unknown[]>("test.safeExecRawTarget", "payload");

      assert.equal(invocationCount, 1);
      assert.deepEqual(result, ["payload"]);
      await delay(150);
      assert.equal(api.getAuditEvents(50).filter((event) => event.surface === "command").length, 0);
    } finally {
      disposable.dispose();
    }
  });

  test("explicit proxy commands stay approval-gated while raw commands remain separate", async () => {
    const api = await activateExtension();
    await resetTestState(api);

    const availableCommands = await vscode.commands.getCommands(true);

    for (const definition of VERIFIED_EXPLICIT_PROXY_COMMAND_DEFINITIONS) {
      assert.equal(
        availableCommands.includes(definition.proxyCommand),
        true,
        `Expected proxy command ${definition.proxyCommand} to be registered.`
      );
      assert.equal(
        availableCommands.includes(definition.targetCommand),
        true,
        `Expected target command ${definition.targetCommand} to be available in the current VS Code host.`
      );

      api.queueApproval("deny");
      await vscode.commands.executeCommand(definition.proxyCommand);
      await waitForAuditEvent(
        api,
        "command",
        "denied",
        (event) => event.source === definition.proxyCommand && event.summary === `Denied "${definition.targetCommand}"`
      );
    }
  });
});
