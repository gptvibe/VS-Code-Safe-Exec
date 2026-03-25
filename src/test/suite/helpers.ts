import * as assert from "assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { AuditEvent } from "../../auditLog";
import { SafeExecExtensionApi } from "../../extension";

const DEFAULT_WORKSPACE_SETTINGS = {
  "safeExec.enabled": true,
  "safeExec.rulesPath": ".vscode/safe-exec.rules.json",
  "safeExec.policyBundles": [],
  "safeExec.protectedCommands": [],
  "safeExec.editHeuristics.minChangedCharacters": 5,
  "safeExec.editHeuristics.minAffectedLines": 1,
  "safeExec.editHeuristics.maxPreviewCharacters": 200
} as const;

type WorkspaceSettings = Record<string, unknown>;
interface WriteWorkspaceSettingsOptions {
  mergeWithDefaults?: boolean;
}

export async function activateExtension(): Promise<SafeExecExtensionApi> {
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON.name === "vscode-safe-exec");
  assert.ok(extension, "Safe Exec extension was not found in the extension host.");
  return (await extension.activate()) as SafeExecExtensionApi;
}

export async function resetTestState(api: SafeExecExtensionApi): Promise<void> {
  await api.resetTestState();
  await revertDirtyDocuments();
  await restoreFixtureFiles();
  await writeWorkspaceSettings();
  await vscode.commands.executeCommand("safeExec.reloadRules");
  await closeSafeExecTerminals();
}

export function getFixturePath(...segments: string[]): string {
  return path.resolve(__dirname, "../../../src/test/fixtures/workspace", ...segments);
}

export function getFixtureUri(...segments: string[]): vscode.Uri {
  return vscode.Uri.file(getFixturePath(...segments));
}

export async function openFixtureDocument(...segments: string[]): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(getFixtureUri(...segments));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

export async function updateFixtureFile(relativePath: string, content: string): Promise<void> {
  const uri = getFixtureUri(relativePath);
  const edit = new vscode.WorkspaceEdit();
  const existing = await vscode.workspace.openTextDocument(uri);
  edit.replace(uri, new vscode.Range(existing.positionAt(0), existing.positionAt(existing.getText().length)), content);
  const applied = await vscode.workspace.applyEdit(edit);
  assert.ok(applied, `Expected to update fixture file ${relativePath}.`);
  await existing.save();
}

export async function writeWorkspaceSettings(
  overrides: WorkspaceSettings = {},
  options: WriteWorkspaceSettingsOptions = {}
): Promise<void> {
  const settings = options.mergeWithDefaults === false ? overrides : { ...DEFAULT_WORKSPACE_SETTINGS, ...overrides };

  await fs.mkdir(getFixturePath(".vscode"), { recursive: true });
  await fs.writeFile(getFixturePath(".vscode", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await waitForSafeExecSettings(settings);
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

export function findEvents(events: readonly AuditEvent[], surface: AuditEvent["surface"], action: AuditEvent["action"]): AuditEvent[] {
  return events.filter((event) => event.surface === surface && event.action === action);
}

export async function waitForAuditEvent(
  api: SafeExecExtensionApi,
  surface: AuditEvent["surface"],
  action: AuditEvent["action"],
  predicate?: (event: AuditEvent) => boolean,
  timeoutMs = 10000
): Promise<AuditEvent> {
  let matchedEvent: AuditEvent | undefined;

  await waitFor(() => {
    matchedEvent = api
      .getAuditEvents(50)
      .find((event) => event.surface === surface && event.action === action && (predicate ? predicate(event) : true));
    return Boolean(matchedEvent);
  }, timeoutMs);

  assert.ok(matchedEvent, `Expected ${surface}/${action} audit event.`);
  return matchedEvent;
}

export async function closeSafeExecTerminals(): Promise<void> {
  for (const terminal of vscode.window.terminals) {
    if (terminal.name.includes("Safe Exec")) {
      terminal.dispose();
    }
  }

  await delay(100);
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function restoreFixtureFiles(): Promise<void> {
  await fs.writeFile(getFixturePath("sample.ts"), 'export const originalValue = "safe-exec";\n', "utf8");
  await fs.writeFile(getFixturePath("test-protected.txt"), "safe exec fixture\n", "utf8");
  await fs.writeFile(
    getFixturePath(".vscode", "safe-exec.rules.json"),
    JSON.stringify(
      {
        dangerousCommands: [
          {
            pattern: "\\becho SAFE_EXEC_TEST_RISKY\\b",
            description: "Fixture risky terminal command",
            risk: "high"
          }
        ],
        protectedCommands: [
          {
            command: "safeExec.testProtectedFromFile",
            description: "Fixture protected command",
            risk: "medium"
          }
        ],
        editHeuristics: {
          minChangedCharacters: 5,
          minAffectedLines: 1,
          protectedPathPatterns: ["(^|[\\\\/])test-protected\\.txt$"]
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function waitForSafeExecSettings(expected: WorkspaceSettings): Promise<void> {
  await waitFor(() => {
    return Object.entries(expected).every(([key, value]) => {
      const safeExecKey = key.startsWith("safeExec.") ? key.slice("safeExec.".length) : key;
      const actual = vscode.workspace.getConfiguration("safeExec").get(safeExecKey);
      return JSON.stringify(actual) === JSON.stringify(value);
    });
  });
}

async function revertDirtyDocuments(): Promise<void> {
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || document.isUntitled) {
      continue;
    }

    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}
