# VS Code Safe Exec

VS Code Safe Exec is a best-effort VS Code extension that adds approval prompts around actions that AI agents and automation can execute too quickly:

- risky terminal commands
- sensitive VS Code commands
- large or suspicious code edits

It is designed to reduce surprise, not to pretend perfect isolation. When VS Code only exposes a post-start or post-change signal, Safe Exec uses the safest practical fallback and says so clearly.

## What It Does

### 1. Protects terminal commands

Safe Exec watches terminal shell execution and compares command text against regex rules.

If a command looks risky, it tries to:

1. interrupt and dispose the original terminal as quickly as possible
2. show a modal approval dialog
3. replay the exact command in a fresh terminal only if you approve it

Default risky examples include:

- `rm -rf`
- `Remove-Item -Recurse -Force`
- `del /f /s /q`
- `rmdir /s /q`
- `git reset --hard`
- `git clean -fdx`
- `docker system prune -f`
- `terraform destroy`
- `kubectl delete`
- `mkfs`
- `dd ... of=/dev/...`
- `diskutil eraseDisk`
- `Format-Volume`
- `diskpart`

Important: this is a kill-and-replay model, not guaranteed true pre-execution blocking.

### 2. Protects sensitive VS Code commands

VS Code does not provide a reliable way to transparently override arbitrary built-in commands and still preserve their original behavior exactly. Safe Exec therefore uses guarded proxy and wrapper commands instead.

Included proxies:

- `safeExec.proxy.workbench.action.terminal.runSelectedText`
- `safeExec.proxy.workbench.action.tasks.runTask`
- `safeExec.proxy.github.copilot.generate`

Generic wrapper:

- `safeExec.runProtectedCommand`

These commands ask for approval first, then run the real target command only if you allow it.

### 3. Protects large or suspicious edits

Safe Exec keeps snapshots of open documents. When an edit crosses configured thresholds, uses many edit ranges, or touches protected files, it:

1. rolls the document back to the previous snapshot
2. shows a modal preview
3. reapplies the exact edit only if you approve it

Important: this is a rollback-and-reapply model, not true pre-approval editing.

## Why It Exists

AI coding tools can inspect files, generate code, run commands, execute tasks, and refactor large parts of a workspace in seconds. That speed is useful until an agent:

- runs a destructive command
- executes a task with side effects
- rewrites a protected config file
- applies a large edit you have not reviewed yet

Safe Exec adds friction exactly where that speed becomes risky.

## Platform Support

The extension is intended to be useful on all three major desktop platforms:

- macOS
- Linux
- Windows

The built-in rules include Unix-style shell commands, Windows PowerShell commands, Windows `cmd.exe` commands, and macOS disk utility examples.

That said, platform support is still best effort:

- terminal protection depends on VS Code shell integration
- command matching is regex-based, so it cannot cover every alias or every admin tool by default
- teams should still customize `.vscode/safe-exec.rules.json` for their own shells, package managers, and infrastructure tools

## How To Use

### Quick start

1. Install the extension.
2. Open your workspace.
3. Run `Safe Exec: Open Rules File` if you want to create or edit `.vscode/safe-exec.rules.json`.
4. Keep protection enabled with `Safe Exec: Toggle Protection`.

### Terminal protection

Once enabled, Safe Exec automatically screens terminal commands when shell integration provides command text.

If a command matches:

- `allowedCommands`, it runs without prompting
- `confirmationCommands`, it asks first
- `dangerousCommands`, it asks first with a higher risk label

### Protected VS Code commands

To use command protection, call the Safe Exec proxy commands instead of the raw built-in commands.

Example keybinding:

```json
[
  {
    "key": "ctrl+enter",
    "command": "safeExec.proxy.workbench.action.terminal.runSelectedText",
    "when": "editorTextFocus"
  }
]
```

Example wrapper usage:

```ts
await vscode.commands.executeCommand(
  "safeExec.runProtectedCommand",
  "workbench.action.tasks.runTask"
);
```

### Edit protection

Edit protection works automatically for open text documents. If an edit looks suspicious based on your thresholds, Safe Exec rolls it back and asks whether to reapply it.

This is especially useful for:

- AI-generated multi-file refactors
- large pasted changes
- edits to `.vscode`, CI, package manifests, and lockfiles

## Configuration

Extension settings:

- `safeExec.enabled`
- `safeExec.rulesPath`
- `safeExec.protectedCommands`
- `safeExec.terminal.killStrategy`
- `safeExec.editHeuristics.minChangedCharacters`
- `safeExec.editHeuristics.minAffectedLines`
- `safeExec.editHeuristics.maxPreviewCharacters`

Workspace rules file:

- default path: `.vscode/safe-exec.rules.json`
- merged with built-in defaults at runtime

Supported rule sections:

- `dangerousCommands`
- `allowedCommands`
- `confirmationCommands`
- `protectedCommands`
- `editHeuristics`

See [RULES.md](RULES.md) for the full format and examples.

## Commands Included

- `Safe Exec: Toggle Protection`
- `Safe Exec: Open Rules File`
- `Safe Exec: Show Effective Rules`
- `Safe Exec: Reload Rules`

## Output And Review Flow

Safe Exec uses:

- modal approval dialogs
- optional preview documents
- an output channel named `Safe Exec`

This makes it easier to understand why something was blocked, what matched, and what would run or be reapplied if approved.

## Development

Build locally:

```bash
npm install
npm run compile
```

Run in VS Code:

1. Open this repo in VS Code.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` to launch an Extension Development Host.

## Known Limitations

- Terminal interception depends heavily on shell integration. Without it, protection is reduced.
- `onDidWriteTerminalData` is treated as optional and heuristic only.
- A terminal command may already have started by the time Safe Exec interrupts or disposes the terminal.
- Replayed terminal commands run in a fresh terminal and may not preserve the exact prior shell state or working directory.
- Built-in commands are not secretly overridden; only proxy or wrapped commands are guarded.
- Edit interception happens after the change event, so rollback and reapply can race with later edits.
- Platform coverage is broad by default, but still not exhaustive for every shell, alias, or admin tool.
- Extensions that mutate files or run processes outside the observed VS Code flows can bypass some protections.

See [DESIGN.md](DESIGN.md), [SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md) for deeper detail.

## Contributing

Contributions should keep the project honest:

- prefer real guardrails over fake guarantees
- document fallbacks when an API is missing or only post-event
- avoid sandbox claims
- keep behavior readable, defensive, and explicit
