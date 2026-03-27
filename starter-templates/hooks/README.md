# Starter Hook Guidance

These examples are generic starter hooks. Adapt them to your agent runner, task harness, or editor integration.

The goal is to put a simple pre-run policy check in front of risky automation, while keeping Safe Exec responsible for in-editor approval, review, and bounded recovery. A hook can narrow the entry points that automation uses. It does not replace sandboxing.

## Good starter hook jobs

- reject raw destructive shell commands before they run
- block or escalate edits to protected files such as `.github/`, `.vscode/`, `package.json`, lockfiles, and deployment config
- route risky VS Code command execution through `safeExec.proxy.*` commands or `safeExec.runProtectedCommand`
- log denials clearly without pretending the hook is complete coverage

## Adapting These Scripts

- Pass the proposed command text as the first argument.
- Optionally pass the intended working directory as the second argument.
- Exit `0` to allow the action.
- Exit non-zero to deny the action and send the user or agent back to a reviewed workflow.

If your agent tool exposes hook data through environment variables instead of positional arguments, add a small wrapper that maps those values into the same contract.

## Included Files

- [`pre-command-check.sh`](pre-command-check.sh)
- [`pre-command-check.ps1`](pre-command-check.ps1)

## Suggested Follow-Through

When a hook denies a risky action:

- point the user or agent at the reviewed path
- keep the denial reason specific
- avoid retry loops that wear down approval
- avoid saying the hook made the action safe
