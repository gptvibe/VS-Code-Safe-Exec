# Security

## Security posture

Safe Exec is a best-effort approval and review layer for risky activity inside VS Code. It is meant to reduce surprise and make harmful actions slower and more visible.

Safe Exec is not:

- a sandbox
- a security boundary
- a pre-execution enforcement layer
- a guarantee that a risky action never begins
- a guarantee that all VS Code commands or edits are intercepted

The extension is intentionally honest about these limits in code, docs, and UI.

## Protected surfaces

### Terminal commands

Safe Exec uses stable shell-integration APIs to inspect command text after VS Code reports a shell execution start event.

If a command matches:

- `allowedCommands`, it is ignored
- `confirmationCommands`, approval is required
- `dangerousCommands`, approval is required with a higher risk label

Safe Exec then tries to interrupt and dispose the original terminal and replays the command only after approval. Replay uses the best context VS Code exposes, but it still runs in a fresh terminal.

### Suspicious edits

Safe Exec watches text-document change events, which are post-change. It snapshots file contents, rolls back suspicious edits, shows a real diff review, and reapplies only the captured change if approved.

### Protected commands

Safe Exec protects command execution only through explicit Safe Exec proxy and wrapper commands. It does not claim transparent protection for arbitrary raw built-in commands.

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

### Protected-command coverage is explicit

Coverage depends on using Safe Exec proxy commands or `safeExec.runProtectedCommand`.

Common bypasses include:

- a keybinding that still targets the raw built-in command
- another extension that invokes the raw built-in command directly
- commands that Safe Exec has not been wired to proxy

The onboarding flow and keybinding inspection are there to make this limitation visible, not to hide it.

## Workspace Trust

Safe Exec integrates with Workspace Trust, but Workspace Trust is not treated as a security boundary.

In practice:

- Safe Exec can still show approval prompts and inspect edits in untrusted workspaces where VS Code allows it
- Safe Exec records trust state transitions in local audit history
- Safe Exec status UI explains whether the current workspace is trusted or untrusted

Workspace Trust can reduce some VS Code behavior. It does not isolate the shell, other extensions, or the host operating system.

## Audit history and logging

Safe Exec records local per-workspace history for events such as:

- `intercepted`
- `interrupted`
- `approved`
- `replayed`
- `replay-degraded`
- `denied`
- `failed-to-stop`
- `failed`
- `conflict`
- `status`

Important limits:

- audit history is stored in local extension state
- it is not tamper-proof
- it is not a system audit log
- it should not be treated as a complete forensic record

The output channel also emits structured JSON log lines for debugging and review.

## Known bypasses

Safe Exec does not reliably cover:

- commands launched outside VS Code's integrated terminal
- terminals without usable shell integration
- extensions spawning child processes directly through Node APIs
- raw built-in VS Code commands that are not routed through Safe Exec proxies
- direct filesystem mutation that never appears as a normal text-document edit
- non-text file changes
- malicious extensions that intentionally avoid Safe Exec flows

## Residual risk

Residual risk remains even when Safe Exec prompts correctly. Users should still rely on:

- least-privilege local accounts
- containers or VMs for risky automation
- repository protections and review gates
- backups and recovery plans
- careful extension selection and workspace trust decisions

## Security statement

Safe Exec improves approval, visibility, and review around risky actions in VS Code. It does not create hard isolation and should never be described as sandboxing.
