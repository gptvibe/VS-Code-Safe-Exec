# Design

## Overview

VS Code Safe Exec is a best-effort safety layer for four high-risk surfaces inside VS Code:

- terminal command execution
- explicit protected-command execution
- large or sensitive text edits
- supported file create, delete, and rename flows

The design goal is to use stable VS Code APIs, keep behavior explainable, and avoid fake security claims.

## Core components

- `src/extension.ts`
  Activates the extension, wires commands, status bar state, onboarding, keybinding diagnostics, rules reloading, workspace-trust messaging, and file-operation recovery commands.
- `src/terminalInterceptor.ts`
  Matches risky shell commands, attempts interruption, and replays approved commands with the best terminal context stable APIs expose.
- `src/commandInterceptor.ts`
  Hosts the explicit Safe Exec proxy and wrapper commands.
- `src/editInterceptor.ts`
  Keeps snapshots, rolls back suspicious edits, opens a real diff review, and reapplies captured changes after approval.
- `src/fileOperationInterceptor.ts`
  Evaluates supported file create, delete, and rename events, captures bounded delete and rename snapshots, and records file-operation outcomes.
- `src/fileOperationRecoveryStore.ts`
  Stores bounded file-operation history and snapshot payloads in extension-managed storage and restores supported delete or rename operations.
- `src/diffContentProvider.ts`
  Supplies virtual documents so VS Code can render a native diff review.
- `src/permissionUI.ts`
  Centralizes the approval dialog and optional review action flow.
- `src/rules.ts`
  Defines built-in defaults, policy bundles, settings, rules-file loading, and merge behavior for terminal, edit, and file-operation protection.
- `src/keybindingInspector.ts`
  Inspects user keybindings for common raw guarded-command bindings without equivalent Safe Exec proxies and flags missing proxy coverage that still makes raw entry points likely.
- `src/onboarding.ts`
  Builds the onboarding content shown by the first-run flow and the walkthrough command.
- `src/auditLog.ts`
  Records local structured history for approvals, denials, conflicts, degraded replays, failures, file-operation events, restore outcomes, and status changes.

## Terminal command flow

Primary API:

- `window.onDidStartTerminalShellExecution`

Replay preference:

- `terminal.shellIntegration.executeCommand(...)`

Fallback:

- `terminal.sendText(...)`

Flow:

1. VS Code reports a shell execution start event.
2. Safe Exec normalizes the command line and compares it against `allowedCommands`, `dangerousCommands`, and `confirmationCommands`.
3. If the command matches a risky rule, Safe Exec records a `matched` audit event.
4. Safe Exec attempts to interrupt and dispose the original terminal, logging `interrupted-attempted` and `dispose-attempted`.
5. The approval dialog includes:
   - matched rule details
   - command trust and confidence
   - captured `cwd`
   - explicit degraded replay warnings such as `cwd unknown`
6. If approved, Safe Exec creates a fresh terminal and tries shell-integration-backed replay first.
7. If replay shell integration is unavailable or fails, Safe Exec falls back to `sendText(...)` and records `replay-degraded`.

Important tradeoff:

- this is a kill-and-replay model, not true pre-execution enforcement

## Edit review flow

Observed API:

- `workspace.onDidChangeTextDocument`

Because the event is post-change, Safe Exec uses rollback and reapply instead of pretending it can block edits before they land.

Flow:

1. Safe Exec keeps a snapshot of the last accepted document state.
2. Each change is evaluated against edit heuristics:
   - changed characters
   - affected lines
   - number of edit ranges
   - protected-path patterns
3. If the edit looks suspicious, Safe Exec records `intercepted` and restores the previous snapshot.
4. A virtual before or after diff session is created with `src/diffContentProvider.ts`.
5. The approval dialog offers `Review Diff`, `Reapply Edit`, and `Deny`.
6. On approval, Safe Exec reapplies only the captured edit ranges when possible and records `range-based`.
7. If range-based reapply is not possible, Safe Exec falls back to whole-document replacement and records `whole-document-fallback`.
8. If the document changes while approval is pending, Safe Exec keeps the rollback, records `conflict-cancelled`, and warns instead of overwriting newer content.

This keeps the flow readable and conservative without claiming stronger guarantees than the API allows.

## File-operation flow

Observed APIs:

- `workspace.onWillCreateFiles`
- `workspace.onWillDeleteFiles`
- `workspace.onWillRenameFiles`
- `workspace.onDidCreateFiles`
- `workspace.onDidDeleteFiles`
- `workspace.onDidRenameFiles`

Coverage boundary:

- These hooks cover supported VS Code file-operation event paths such as user gestures and `workspace.applyEdit(...)`.
- They do not cover external disk changes.
- They do not reliably cover `workspace.fs` mutation paths.

That boundary is part of the design, not a hidden footnote.

### Preflight model

Safe Exec uses the will-events as a best-effort preflight layer:

1. classify the requested create, delete, or rename by:
   - protected-path matches
   - sensitive names or extensions
   - bulk file count
   - folder or subtree involvement
   - protected rename-away behavior
2. for delete and rename, inspect existing filesystem targets when possible
3. capture snapshots for supported files before the operation completes
4. record preflight audit events such as `evaluated`, `intercepted`, `snapshot-created`, `metadata-only`, or `unrecoverable`

Important design constraint:

- this is still not a hard prevention boundary
- the implementation stays explicit that external disk changes and `workspace.fs` mutations may bypass it
- the preflight and snapshot flow improves visibility and recovery, not universal blocking

### Snapshot model

Snapshots are bounded and extension-managed:

- storage lives under the extension storage area, not in `workspaceState`
- per-file snapshot capture is capped by `fileOps.maxSnapshotBytes`
- per-operation file snapshot count is capped by `fileOps.maxFilesPerOperation`
- small text files are stored as full content
- small binary files are stored byte-for-byte when `fileOps.captureBinarySnapshots` is enabled
- oversized files fall back to metadata-only entries
- unsupported or unreadable paths are recorded as observed-only entries
- older snapshot history is pruned when the bounded store grows beyond the current caps of 60 operations or roughly 20 MiB of stored snapshot payloads

This lets Safe Exec offer practical recovery without pretending to be a backup system.

### Restore model

Restore commands are built on the stored snapshots rather than on VS Code undo state:

- `Safe Exec: Restore Last Recoverable File Operation`
- `Safe Exec: Browse Recoverable File Operations`

Current behavior:

- delete restore recreates missing directories and rewrites captured file contents
- rename restore moves the renamed path back if it still matches the snapshot
- if the renamed path diverged, Safe Exec recreates the original path from the snapshot and keeps the renamed path in place
- create operations are recorded for review but are not automatically reversed

This is intentionally conservative. Safe Exec avoids deleting or overwriting newer content just to make restore feel more magical.

## Protected-command flow

Safe Exec intentionally uses explicit proxy and wrapper commands:

- `safeExec.proxy.workbench.action.terminal.runSelectedText`
- `safeExec.proxy.workbench.action.tasks.runTask`
- `safeExec.proxy.github.copilot.generate`
- `safeExec.runProtectedCommand`

Flow:

1. A Safe Exec proxy or wrapper command is invoked.
2. Safe Exec refuses recursive `safeExec.*` routing.
3. Safe Exec verifies the target command exists.
4. The user sees an approval dialog that explains why the command is considered risky.
5. Only approved commands are executed.

Why this design:

- stable VS Code APIs do not provide a transparent, reliable way to override arbitrary built-in commands while preserving their original semantics
- explicit proxies are easier to document honestly

## Onboarding and adoption UX

Safe Exec includes:

- first-run onboarding
- a main command opened by the status bar item
- a walkthrough contribution
- recommended proxy keybinding snippets
- warnings when common raw guarded keybindings are found without matching Safe Exec proxy bindings
- advisories when common guarded commands still have no Safe Exec proxy keybinding
- a status bar indicator that surfaces disabled, untrusted, and partial-coverage states
- file-operation history and restore commands in the main menu

The onboarding, keybinding, and restore flows are intentionally manual. Safe Exec can recommend or expose safer paths, but it does not silently rewrite user keybindings or silently reverse file operations.

## Rule engine and policy bundles

Rule sources:

- built-in defaults
- `.vscode/safe-exec.rules.json` or another configured rules file
- selected VS Code settings
- opt-in policy bundles from either the rules file or settings

Built-in policy bundles:

- `node-web`
- `python`
- `docker`
- `terraform-kubernetes`
- `git-ci`

Merge behavior:

- pattern-rule arrays append to defaults
- policy-bundle selections from settings and the rules file are unioned
- protected commands are merged by command key
- scalar edit thresholds are overridden in the order defaults -> rules file -> settings
- scalar file-op settings are overridden in the order defaults -> rules file -> settings
- edit and file-op protected or ignored path patterns are unioned
- file-op protected and ignored paths also inherit the matching edit path patterns so the high-value path model stays aligned
- file-op sensitive extensions and file names are unioned

Current implementation note:

- `fileOps.ignoredPathPatterns` lowers the signal from matching file-operation paths unless they are also protected or sensitive, but Safe Exec still records the observed operation when VS Code emits the event

The result is intentionally additive. Safe Exec avoids hidden rule-removal behavior.

## Workspace Trust

Safe Exec supports untrusted workspaces in a limited and explicit way:

- it can still show approvals and inspect text edits where VS Code allows it
- it can still evaluate supported file-operation events where VS Code emits them
- it records trust-related status changes
- it surfaces trust state in the status bar and onboarding UI

Workspace Trust is treated as a VS Code capability signal, not as a sandbox or security boundary.

## Audit and observability

Safe Exec writes:

- human-readable operational lines to the `Safe Exec` output channel
- structured JSON audit records for review and debugging
- local per-workspace recent history shown through `Safe Exec: Show Recent Activity`
- file-operation recovery history shown through `Safe Exec: Show Recent File Operations`

Tracked actions include:

- terminal outcomes such as `matched`, `interrupted-attempted`, `dispose-attempted`, `approved`, `denied`, `replayed`, and `replay-degraded`
- edit outcomes such as `intercepted`, `reviewed`, `range-based`, `whole-document-fallback`, and `conflict-cancelled`
- file-operation outcomes such as `evaluated`, `intercepted`, `snapshot-created`, `metadata-only`, `unrecoverable`, `create`, `delete`, `rename`, `restore-started`, `restored`, and `restore-failed`
- workspace status events such as `status`

The audit trail is useful for operator visibility, but it is not tamper-proof.

## Known tradeoffs

- terminal safety depends heavily on shell integration quality
- replay terminals cannot restore full prior shell state
- raw built-in commands remain outside command protection unless a Safe Exec proxy is used
- edit review is post-change and can race with subsequent edits
- file-operation coverage depends on VS Code file-operation events
- external disk changes are outside file-operation coverage
- `workspace.fs` mutations may bypass the file-operation hooks
- file-operation recovery is intentionally bounded and can fall back to metadata-only entries
- create operations are tracked, not automatically reversed

These tradeoffs are documented rather than hidden because honesty is part of the design.

## Future improvements

Reasonable next steps that still fit the project's posture:

- better tests around more complex folder rename and delete recovery cases
- clearer UI around partial metadata-only recovery for large subtree operations
- more stack-specific file-operation-sensitive defaults where the risk is obvious and conservative
- export or diff views for recent file-operation history without turning the local store into a forensic system
