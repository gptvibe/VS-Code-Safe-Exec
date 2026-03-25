# VS Code Safe Exec

VS Code Safe Exec is a best-effort approval layer for risky actions that happen inside VS Code, especially when AI agents or automation can move faster than a human can comfortably review.

Safe Exec is deliberately not a sandbox. It does not claim hard isolation, guaranteed prevention, or transparent interception of every risky action. It slows down risky flows where stable VS Code APIs make that practical, and it says when protection is degraded.

## At a glance

- Risky terminal commands are matched after VS Code shell integration reports them.
- Sensitive VS Code commands are protected only through explicit Safe Exec proxy and wrapper commands.
- Large or sensitive edits are handled with rollback, diff review, and reapply.
- Workspace Trust is surfaced honestly, but it is not treated as a security boundary.
- Recent approvals, denials, degraded terminal replays, conflicts, and failures are recorded per workspace in local audit history.

## Illustrative UX

![Illustrative Safe Exec onboarding guide](media/onboarding.svg)

_Illustrative SVG, not a captured VS Code screenshot._

![Illustrative Safe Exec diff review](media/diff-review.svg)

_Illustrative SVG, not a captured VS Code screenshot._

![Illustrative Safe Exec status bar and keybinding guidance](media/status-keybindings.svg)

_Illustrative SVG, not a captured VS Code screenshot._

## What Safe Exec protects

### 1. Risky terminal commands

Safe Exec watches terminal shell execution through stable VS Code shell-integration APIs. When a command matches `dangerousCommands` or `confirmationCommands`, it tries to:

1. interrupt and dispose the original terminal
2. show a modal approval dialog
3. replay the command in a fresh terminal only if you approve it

Replay fidelity is best effort:

- Safe Exec preserves captured `cwd` when VS Code exposes it.
- Safe Exec preserves replayable launch options such as shell path, shell args, and environment when available.
- Safe Exec prefers shell-integration-backed replay with `executeCommand(...)`.
- If replay shell integration is unavailable or fails, Safe Exec falls back to `sendText(...)`.
- The approval dialog calls out degraded context such as `cwd unknown`, `shell integration unavailable in the replay terminal`, or `replay may not match original shell state`.

Important: terminal handling is post-start, not pre-execution blocking. A risky command may already have started before Safe Exec interrupts or disposes the terminal.

### 2. Suspicious edits

Safe Exec snapshots open text documents. When an edit crosses configured thresholds, uses many edit ranges, or touches a protected path, it:

1. restores the previous snapshot
2. offers `Review Diff`, `Reapply Edit`, and `Deny`
3. opens a real VS Code diff review on demand
4. reapplies only the captured edit ranges when you approve
5. falls back to whole-document replacement only if range-based reapply is not possible

If the document changes while approval is pending, Safe Exec does not overwrite the newer content. It keeps the rollback, shows a clear conflict message, and asks the user to reapply manually if they still want the change.

Important: edit protection is rollback-and-reapply. VS Code has already applied the edit by the time Safe Exec sees the change event.

### 3. Protected VS Code commands

Safe Exec does not pretend built-in commands can be transparently overridden. Command protection works only through explicit Safe Exec commands:

- `safeExec.proxy.workbench.action.terminal.runSelectedText`
- `safeExec.proxy.workbench.action.tasks.runTask`
- `safeExec.proxy.github.copilot.generate`
- `safeExec.runProtectedCommand`

If a user or agent invokes the raw built-in command instead of the proxy, Safe Exec does not claim protection it does not have.

## First-run and onboarding

Safe Exec now includes a first-run onboarding flow, a main command, and a native walkthrough:

- `Safe Exec: Open Safe Exec`
- `Safe Exec: Open Onboarding`
- `Get Started with Safe Exec`
- `Safe Exec: Open Recommended Proxy Keybindings`

The onboarding guide explains:

- what Safe Exec protects
- what it does not protect
- how Workspace Trust fits in
- which proxy keybindings are recommended
- which policy bundles are available

Safe Exec can inspect the user `keybindings.json` file, warn when common raw guarded commands are bound directly without an equivalent Safe Exec proxy binding, and call out when common guarded commands still have no proxy shortcut at all. It opens a recommended JSON snippet beside the user keybindings file, but it does not edit keybindings automatically.

## Status bar and recent activity

Safe Exec shows a status bar item that surfaces whether protection is:

- enabled
- disabled
- running in an untrusted workspace
- missing recommended proxy keybinding coverage

The status bar opens the Safe Exec main command, and `Safe Exec: Show Recent Activity` opens a local per-workspace audit history. That history is useful for review and debugging, but it is not tamper-proof and should not be treated as a forensic record.

Structured audit events include:

- terminal outcomes such as `matched`, `interrupted-attempted`, `dispose-attempted`, `approved`, `denied`, `replayed`, `replay-degraded`, and `replay-failed`
- edit outcomes such as `intercepted`, `reviewed`, `approved`, `range-based`, `whole-document-fallback`, `conflict-cancelled`, and `failed`
- workspace and command status events such as `status`

## Workspace Trust

Safe Exec integrates with VS Code Workspace Trust in an honest way:

- it still works in untrusted workspaces where stable APIs allow it
- it records workspace trust state changes in local audit history
- it surfaces trust state in the status bar and onboarding flow
- it does not claim Workspace Trust is a sandbox or a replacement for approval prompts

Workspace Trust can reduce some automatic workspace behavior in VS Code. It does not isolate shell commands, extensions, or the operating system.

## Policy bundles

Safe Exec includes opt-in policy bundles for common stacks:

- `node-web`
- `python`
- `docker`
- `terraform-kubernetes`
- `git-ci`

Bundles add stack-specific command rules and protected-path patterns. They are intentionally conservative presets, not complete coverage for every tool in a stack.

Examples:

- `node-web` adds package publishing, deploy-style scripts, and web toolchain config patterns.
- `python` adds Python packaging, lock, and environment patterns.
- `docker` adds container lifecycle and Docker config patterns.
- `terraform-kubernetes` adds Terraform apply, Helm, and Kubernetes mutation patterns.
- `git-ci` adds force-push and CI workflow patterns.

You can enable bundles in either VS Code settings or `.vscode/safe-exec.rules.json`. Safe Exec unions the bundle selections from both places.

## Quick start

1. Install the extension.
2. Open `Safe Exec: Open Safe Exec` or click the Safe Exec status bar item.
3. Review `Safe Exec: Open Recommended Proxy Keybindings` and wire proxy commands for the shortcuts you actually use.
4. Open `Safe Exec: Open Rules File` and enable any policy bundles that match your stack.
5. Keep an eye on the status bar state and `Safe Exec: Show Recent Activity`.

Example workspace rules file:

```json
{
  "policyBundles": ["node-web", "git-ci"],
  "confirmationCommands": [
    {
      "pattern": "\\bwrangler\\s+secret\\s+put\\b",
      "description": "Update Cloudflare secrets",
      "risk": "high"
    }
  ],
  "protectedCommands": [
    {
      "command": "workbench.action.tasks.runTask",
      "description": "Always require approval for tasks",
      "risk": "high"
    }
  ]
}
```

## Configuration

Important settings:

- `safeExec.enabled`
- `safeExec.rulesPath`
- `safeExec.policyBundles`
- `safeExec.protectedCommands`
- `safeExec.terminal.killStrategy`
- `safeExec.editHeuristics.minChangedCharacters`
- `safeExec.editHeuristics.minAffectedLines`
- `safeExec.editHeuristics.maxPreviewCharacters`

`safeExec.editHeuristics.maxPreviewCharacters` is now a legacy compatibility setting. Safe Exec uses a real diff review flow for suspicious edits; this setting no longer controls the primary review experience.

See [RULES.md](RULES.md) for merge behavior, examples, and bundle details.

## Protected-path defaults

The built-in protected-path defaults now include common high-value files such as:

- `.github/` and common CI config
- `.vscode/`
- `.env*`
- `package.json` and major lockfiles
- Python packaging files
- `Dockerfile` and compose files
- Terraform and Helm files
- `Jenkinsfile`

These defaults are configurable. They are meant to catch sensitive edits more often, not to freeze those files permanently.

## Platform support

Safe Exec aims for useful best-effort behavior on:

- macOS
- Linux
- Windows

Built-in terminal rules include Unix-style commands, PowerShell commands, `cmd.exe` commands, and macOS disk utility examples. Coverage is still incomplete by design; teams should add their own rules for local shells, aliases, scripts, and infrastructure tools.

## Limits and bypasses

Safe Exec is intentionally explicit about residual risk:

- terminal interception depends on shell integration and is post-start
- terminal replay happens in a fresh terminal and cannot restore exact shell state
- built-in commands are not secretly wrapped; only Safe Exec proxies and wrappers are protected
- keybindings that call raw built-in commands bypass proxy approval
- edit interception is post-change, so rollback can race with later edits
- extensions or tasks that mutate files or run processes outside the observed VS Code flows can bypass some protections
- audit history is local workspace state, best effort, and not tamper-proof

If you need hard isolation, use OS-level permissions, containers, VMs, CI isolation, and least-privilege accounts. Safe Exec is a friction layer, not a sandbox.

## More detail

- [DESIGN.md](DESIGN.md) explains the architecture and tradeoffs.
- [RULES.md](RULES.md) explains rules, bundles, and merge behavior.
- [SECURITY.md](SECURITY.md) explains the security posture, bypasses, and residual risk.
- [AGENTS.md](AGENTS.md) explains the agent behavior expected in this repository.
