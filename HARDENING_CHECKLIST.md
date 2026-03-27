# Safe Exec Hardening Checklist

Safe Exec is a guardrail, review, and bounded recovery layer for risky activity inside VS Code. It helps slow down and inspect risky flows, but it does not replace sandboxing, hard isolation, or least-privilege system design.

Use Safe Exec together with:

- Workspace Trust for reducing some automatic workspace behavior in VS Code
- agent hooks for pre-run policy checks and explicit routing
- dev containers, Docker workspaces, VMs, remote hosts, or similar isolation layers
- low-privilege accounts, repository protections, and backups

## Roles In A Layered Setup

| Layer | Primary job | What it does not replace |
| --- | --- | --- |
| Safe Exec | Approval prompts, edit review, activity history, and bounded recovery inside VS Code | Sandboxing, OS isolation, or full interception |
| Workspace Trust | Reduce some automatic workspace behavior in VS Code | Shell, extension, or OS isolation |
| Agent hooks | Reject or reshape risky automation before execution | In-editor review, audit visibility, or recovery |
| Containers, Docker workspaces, VMs, and remote hosts | Constrain tooling, dependencies, and blast radius | Human approval and review inside VS Code |

## Checklist

### 1. Start inside an isolated workspace when risk is high

- Prefer a dev container, Docker-based workspace, VM, or remote host for untrusted repositories, high-volume automation, or agent-led refactors.
- Run as a non-root or low-privilege user when possible.
- Keep host secrets, SSH agents, cloud credentials, and production kube contexts out of the workspace by default.

### 2. Keep Workspace Trust deliberate

- Open unfamiliar repositories in Restricted Mode first.
- Review workspace tasks, recommended extensions, debug configs, and scripts before trusting the workspace.
- Treat Workspace Trust as one layer only. It is not sandboxing and it does not replace Safe Exec approval.

### 3. Keep Safe Exec explicit

- Route common automation-heavy commands through `safeExec.proxy.*` commands or `safeExec.runProtectedCommand`.
- Review `Safe Exec: Open Recommended Proxy And Wrapper Keybindings` and bind only the shortcuts your team actually uses.
- Enable policy bundles that match your stack so protected commands and high-value paths stay aligned with your workflow.
- Use `Safe Exec: Show Recent Activity` and `Safe Exec: Show Recent File Operations` as review surfaces, not as a claim of perfect coverage.

### 4. Add agent-side hooks before execution

- Deny raw destructive commands before they run.
- Require a second review step for package manifests, lockfiles, CI config, infra code, and secret-bearing paths.
- Prefer hook rules that route risky VS Code command execution back through explicit Safe Exec wrapper commands instead of raw built-ins.
- Keep hook logging honest: a denied hook is still not a sandbox, and a passed hook is not a guarantee.

The starter hook scripts in [`starter-templates/hooks/`](starter-templates/hooks/) accept the proposed command text as the first argument. Adapt that contract to your agent runner or automation harness.

### 5. Separate credentials and release paths

- Keep release credentials outside the workspace mount when possible.
- Use separate low-privilege identities for development, staging, and production.
- Protect deployment scripts, release manifests, `.env*`, CI config, and IaC paths with Safe Exec rules and agent-side policy.

### 6. Make recovery explicit

- Confirm where Safe Exec can recover deletes and renames, and where it only records metadata.
- Keep normal backups and repository restore paths ready. Safe Exec is not a backup system.
- Test your restore path before you need it in an incident.

### 7. Preserve honest boundaries in docs and prompts

- Do not describe Safe Exec as replacing sandboxing.
- Do not describe Workspace Trust as a sandbox.
- Do not describe agent hooks as a complete enforcement boundary if they only cover one execution path.
- Tell users where coverage stops, especially for raw commands, external disk changes, and non-event-backed file operations.

## Optional Starter Templates And Snippets

These files are optional starting points, not turnkey security guarantees:

- Dev container starter:
  [`starter-templates/devcontainer/devcontainer.json`](starter-templates/devcontainer/devcontainer.json)
  and [`starter-templates/devcontainer/Dockerfile`](starter-templates/devcontainer/Dockerfile)
- Docker-based workspace starter:
  [`starter-templates/docker-workspace/compose.yaml`](starter-templates/docker-workspace/compose.yaml)
  and [`starter-templates/docker-workspace/Dockerfile`](starter-templates/docker-workspace/Dockerfile)
- Generic hook guidance and starter scripts:
  [`starter-templates/hooks/README.md`](starter-templates/hooks/README.md),
  [`starter-templates/hooks/pre-command-check.sh`](starter-templates/hooks/pre-command-check.sh),
  and [`starter-templates/hooks/pre-command-check.ps1`](starter-templates/hooks/pre-command-check.ps1)

Review and adapt each template to your stack, dependency model, secrets flow, and platform constraints before using it.

## Suggested Adoption Order

1. Start with Workspace Trust plus explicit Safe Exec proxy and wrapper coverage.
2. Add agent hooks that deny or reroute the highest-risk actions.
3. Move risky repositories or agents into a dev container, Docker workspace, VM, or remote host.
4. Add least-privilege credentials, repository protections, and backup or recovery drills.

That order keeps the layered story clear:

- Safe Exec helps with approval, review, and bounded recovery inside VS Code.
- Workspace Trust can reduce some automatic behavior.
- Hooks can shape automation before it runs.
- Sandboxing and isolation limit blast radius when something still gets through.
