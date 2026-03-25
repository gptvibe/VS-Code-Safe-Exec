import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "../..");
  const launchRoot = await createLaunchRoot(repoRoot);
  const extensionDevelopmentPath = launchRoot;
  const extensionTestsPath = path.resolve(launchRoot, "out/test/suite/index");
  const workspacePath = path.resolve(launchRoot, "src/test/fixtures/workspace");
  const userDataDir = path.join(os.tmpdir(), "safe-exec-vscode-user-data");
  const extensionsDir = path.join(os.tmpdir(), "safe-exec-vscode-extensions");
  await fs.rm(userDataDir, { recursive: true, force: true });
  await fs.rm(extensionsDir, { recursive: true, force: true });

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      "--disable-extensions",
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir
    ]
  });
}

void main().catch((error) => {
  console.error("Failed to run VS Code extension tests.");
  console.error(error);
  process.exit(1);
});

async function createLaunchRoot(repoRoot: string): Promise<string> {
  const launchRoot = path.join(os.tmpdir(), "safe-exec-vscode-test-root");
  await fs.rm(launchRoot, { recursive: true, force: true });

  if (process.platform === "win32") {
    await fs.symlink(repoRoot, launchRoot, "junction");
    return launchRoot;
  }

  await fs.symlink(repoRoot, launchRoot);
  return launchRoot;
}
