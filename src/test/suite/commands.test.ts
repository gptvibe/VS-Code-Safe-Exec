import * as assert from "assert/strict";
import * as vscode from "vscode";
import { activateExtension, resetTestState, waitForAuditEvent, writeWorkspaceSettings } from "./helpers";

suite("protected commands", () => {
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
});
