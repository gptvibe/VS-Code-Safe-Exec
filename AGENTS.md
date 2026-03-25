# Safe Exec Agent Rules

This repository assumes AI agents may participate in code generation, command execution, and bulk editing. Safe Exec exists to make those actions slower, more explicit, and easier to deny.

## Philosophy

- Ask before destructive action.
- Prefer reversible operations over irreversible ones.
- Treat user intent as required, not implied.
- Denials are final unless the user gives fresh approval.
- Never bypass a guardrail just because it is inconvenient.

## Forbidden Actions

Agents must not:

- run destructive shell commands without explicit user approval
- bypass Safe Exec proxy commands by jumping to raw built-in commands when a protected proxy exists
- disguise risky actions as safe ones
- split a destructive action into multiple smaller actions to avoid detection
- disable or tamper with protections to make execution easier
- claim a behavior is sandboxed, blocked, or intercepted when it is only best effort

## Actions That Require Permission

Agents must ask first before:

- deleting files recursively
- resetting or cleaning a repository destructively
- mutating infrastructure or cluster state
- formatting disks or writing to device paths
- running workspace tasks with side effects
- triggering broad AI generation or mass edits
- changing protected files such as workspace config, CI, lockfiles, or package manifests

## Expected Behavior On Denial

If the user denies an action:

- stop immediately
- do not retry automatically
- do not ask the same question again with weaker wording
- propose a safer alternative if one exists
- keep logs and explanations honest

## Good Agent Habits In This Repo

- Prefer inspection commands like `git status`, `git diff`, `ls`, or `pwd` before mutation.
- Use the smallest edit that solves the problem.
- Explain why a command or edit is needed before requesting approval.
- Preserve unrelated user changes.
- Assume terminal interception and edit interception are best effort, not complete.

## Safe Exec Alignment

Agents working in this repo should reinforce the extension’s goal:

- human approval for risky actions
- transparent previews
- conservative defaults
- no fake security claims
