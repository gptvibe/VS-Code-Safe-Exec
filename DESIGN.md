# Design

## Overview

VS Code Safe Exec is a best-effort safety layer for three high-risk surfaces inside VS Code:

- terminal command execution
- sensitive VS Code command execution
- large or suspicious text edits

The architecture is intentionally simple:

- `src/extension.ts` wires activation, rules loading, config, logging, and utility commands
- `src/terminalInterceptor.ts` handles risky shell execution detection
- `src/commandInterceptor.ts` handles guarded proxy and wrapper commands
- `src/editInterceptor.ts` handles snapshot, rollback, approval, and reapply for edits
- `src/permissionUI.ts` centralizes modal approval and preview UI
- `src/rules.ts` provides defaults, config loading, file loading, and merge logic

## Terminal Interception Layer

Primary path:

- runtime-detected `window.onDidStartTerminalShellExecution`

Supplemental path:

- runtime-detected `window.onDidWriteTerminalData`, used only heuristically

Why this design:

- shell integration gives the most useful practical command signal available in stable VS Code
- terminal data interception may be optional or proposed depending on the build, so it is feature-detected and never assumed

Flow:

1. extract a command string from shell integration, or fall back to buffered terminal text
2. normalize and compare against regex-based rules
3. ignore commands that match `allowedCommands`
4. flag commands that match `dangerousCommands` or `confirmationCommands`
5. attempt interruption and terminal disposal
6. show a modal approval dialog
7. replay the exact command in a fresh terminal only if approved

The replay path uses a one-shot allowance so the replayed command is not blocked again.

Limitation:

- the extension does not truly block pre-execution. It reacts after execution has started and tries to minimize damage with a kill-and-replay pattern.

## Command Proxy Layer

Safe Exec does not pretend arbitrary built-in commands can be overridden transparently. Instead it exposes explicit proxy commands and a generic wrapper:

- `safeExec.proxy.workbench.action.terminal.runSelectedText`
- `safeExec.proxy.workbench.action.tasks.runTask`
- `safeExec.proxy.github.copilot.generate`
- `safeExec.runProtectedCommand`

Flow:

1. receive the proxy or wrapper invocation
2. refuse any attempt to route back into `safeExec.*` commands
3. verify the target command exists
4. show a modal approval dialog with a preview
5. execute the original command only if approved

This design is honest, predictable, and compatible with stable VS Code APIs.

## Edit Interception Layer

Observed API:

- `workspace.onDidChangeTextDocument`

Constraint:

- the event is post-change, so true pre-approval editing is not possible with stable APIs

Fallback design:

1. keep a snapshot of each open file’s last accepted content
2. inspect each change event with heuristics
3. if suspicious, replace the whole document with the prior snapshot
4. ask for approval with a preview
5. if approved, replace the whole document with the captured changed text

The implementation uses recursion guards and muted document tracking to avoid infinite loops during rollback and reapply.

## Rule Engine

Rule sources:

- built-in defaults in `src/rules.ts`
- user or workspace JSON rules file, `.vscode/safe-exec.rules.json` by default
- selected VS Code settings for overrides

Supported sections:

- `dangerousCommands`
- `allowedCommands`
- `confirmationCommands`
- `protectedCommands`
- `editHeuristics`

Merge strategy:

- rule arrays append to defaults
- protected commands are merged by command ID
- edit heuristics are shallow-merged so workspace settings can override thresholds

## Permission UI

All approvals route through a single helper that provides:

- modal dialogs
- risk level
- source label
- summary and detail text
- optional preview document

This keeps terminal, command, and edit flows visually consistent.

## Failure Modes

- shell integration unavailable: terminal coverage is reduced
- command text unavailable: some risky commands may not be detected
- interrupt arrives too late: command side effects may already begin
- edit races: the file may change again while approval is pending
- replay context drift: fresh terminals may not preserve exact shell state
- non-text or out-of-process mutations: some changes happen outside observed editor events

These are documented instead of hidden.

## Future Improvements

- richer terminal context capture when stable APIs improve
- diff-based edit previews instead of before/after snapshots
- policy bundles for common stacks
- workspace trust integration
- per-workspace audit history and explicit approval records
- optional status bar indicators for current protection state
