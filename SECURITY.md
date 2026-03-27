# Security

## Security posture

Safe Exec is a best-effort approval, review, and recovery layer for risky activity inside VS Code. It is meant to reduce surprise and make harmful actions slower, more visible, and easier to inspect.

Safe Exec is not:

- a sandbox
- a security boundary
- a guarantee that a risky action never begins
- a guarantee that every VS Code command, edit, or file operation is intercepted
- a claim that all file operations can be blocked or restored

The extension is intentionally honest about these limits in code, docs, and UI.

See [COVERAGE_MATRIX.md](COVERAGE_MATRIX.md) for the current surface-by-surface coverage map.

## Covered surfaces

### Terminal commands

Safe Exec uses stable shell-integration APIs to inspect command text after VS Code reports a shell execution start event.
Terminals that never provide that event are outside this approval flow.

If a command matches:

- `allowedCommands`, it is ignored
- `confirmationCommands`, approval is required
- `dangerousCommands`, approval is required with a higher risk label

Safe Exec then tries to interrupt and dispose the original terminal and replays the command only after approval. Replay uses the best context VS Code exposes, but it still runs in a fresh terminal.

### Suspicious edits

Safe Exec watches text-document change events, which are post-change. It snapshots file contents, rolls back suspicious edits, offers `Review Diff`, `Reapply Edit`, and `Deny`, and reapplies the captured ranges by default when approval is granted. Whole-document replacement is fallback only.

### Explicit command wrappers

Safe Exec applies command approval only through explicit Safe Exec proxy and wrapper commands. It does not claim transparent protection for arbitrary raw built-in commands.

### File operations

Safe Exec watches these VS Code workspace events:

- `workspace.onWillCreateFiles`
- `workspace.onWillDeleteFiles`
- `workspace.onWillRenameFiles`
- `workspace.onDidCreateFiles`
- `workspace.onDidDeleteFiles`
- `workspace.onDidRenameFiles`

For supported event-backed paths:

- create operations are observed and classified
- delete and rename operations are evaluated before completion
- bounded snapshots are captured for supported delete and rename targets when feasible
- restore commands can recreate or rename back supported delete or rename targets from stored snapshots

Current implementation note:

- file operations do not show an approval prompt today
- `event.waitUntil(...)` is used for async preflight work, snapshot capture, and record creation, not for a user-facing allow or deny decision
- file-operation audit entries named `intercepted` mean Safe Exec preflighted the operation before completion; they do not mean the operation was blocked

Important boundary:

- this applies only where VS Code emits those file-operation events
- Safe Exec does not claim that all filesystem mutations pass through them

## Honest boundaries

### Terminal replay is best effort

Even when Safe Exec works as designed:

- the original command may already have started
- the original process may perform side effects before interruption lands
- the original terminal may fail to stop cleanly
- the replay terminal may not match the original shell state
- replay may fall back from shell integration to `sendText(...)`
- `cwd` may be unknown

Safe Exec surfaces degraded replay context in the approval dialog and records it in audit history.

### Edit review is rollback based

Because VS Code exposes text changes after they happen, Safe Exec cannot promise true pre-edit approval. The safety model is:

1. detect a suspicious edit
2. restore the previous snapshot
3. ask for approval
4. reapply the captured ranges if safe

If the document changes while approval is pending, Safe Exec keeps the rollback and warns instead of overwriting the newer content.

### Command-wrapper coverage is explicit

Coverage depends on using Safe Exec proxy commands or `safeExec.runProtectedCommand`.

Common bypasses include:

- a keybinding that still targets the raw built-in command
- another extension that invokes the raw built-in command directly
- commands that Safe Exec has not been wired to proxy

The onboarding flow and keybinding inspection are there to make this limitation visible, not to hide it.

### File-operation preflight is event scoped

File-operation handling is deliberately scoped to supported VS Code event paths.

What Safe Exec can honestly say:

- it can do a best-effort preflight for supported `onWill*Files` paths
- it can capture bounded snapshots before supported delete or rename operations complete
- it can restore supported delete or rename snapshots later
- it does not currently show a file-operation approval dialog or denial path

What Safe Exec does not claim:

- that every file operation in the workspace passes through these hooks
- that file-operation preflight blocks completion or creates a universal filesystem block
- that external disk changes are covered
- that `workspace.fs` mutation paths are covered

### File-operation recovery is bounded

File-operation recovery is intentionally limited:

- snapshots are capped by `fileOps.maxSnapshotBytes`
- snapshots are capped by `fileOps.maxFilesPerOperation`
- binary capture can be disabled with `fileOps.captureBinarySnapshots`
- oversized files fall back to metadata-only entries
- unsupported URIs can be observed without snapshot content
- create operations are recorded but not automatically reversed
- restore may skip paths that already exist to avoid overwriting newer content

This keeps the feature useful without turning it into a fake backup claim.

## Workspace Trust

Safe Exec integrates with Workspace Trust, but Workspace Trust is not treated as a security boundary.

In practice:

- Safe Exec can still show approval prompts and inspect supported flows in untrusted workspaces where VS Code allows it
- Safe Exec records trust state transitions in local audit history
- Safe Exec status UI explains whether the current workspace is trusted or untrusted

Workspace Trust can reduce some VS Code behavior. It does not isolate the shell, other extensions, or the host operating system.

## Audit history and storage

Safe Exec records local history for events such as:

- terminal outcomes like `matched`, `interrupted-attempted`, `dispose-attempted`, `approved`, `denied`, `replayed`, `replay-degraded`, and `replay-failed`
- edit outcomes like `intercepted`, `reviewed`, `approved`, `range-based`, `whole-document-fallback`, `conflict-cancelled`, and `failed`
- file-operation outcomes like `evaluated`, `intercepted`, `snapshot-created`, `metadata-only`, `unrecoverable`, `create`, `delete`, `rename`, `restore-started`, `restored`, and `restore-failed`
- status events like `status`

Important limits:

- audit history is stored locally
- it is not tamper-proof
- it is not a system audit log
- it should not be treated as a complete forensic record

File-operation recovery payloads are kept in extension-managed storage instead of `workspaceState`, but that does not make them immutable or security-sensitive data stores.

## Known bypasses

Safe Exec does not reliably cover:

- commands launched outside VS Code's integrated terminal
- terminals without usable shell integration
- extensions spawning child processes directly through Node APIs
- raw built-in VS Code commands that are not routed through Safe Exec proxies
- direct filesystem mutation that never appears as a normal text-document edit or supported file-operation event
- external disk changes made by another application
- `workspace.fs` create, delete, rename, or write paths that bypass the file-operation hooks
- non-text file changes that are too large or unsupported for snapshot capture
- malicious extensions that intentionally avoid Safe Exec flows

## Residual risk

Residual risk remains even when Safe Exec prompts correctly. Users should still rely on:

- least-privilege local accounts
- containers or VMs for risky automation
- repository protections and review gates
- backups and recovery plans
- careful extension selection and workspace trust decisions

## Security statement

Safe Exec improves approval, visibility, and bounded recovery around risky actions in VS Code. It does not create hard isolation and should never be described as sandboxing or guaranteed blocking.
