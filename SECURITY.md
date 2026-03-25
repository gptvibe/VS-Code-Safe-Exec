# Security

## Threat Model

Safe Exec is designed to reduce accidental or low-friction harmful actions initiated from inside VS Code, especially by:

- AI coding agents
- extension automation
- tasks and command wrappers
- users moving quickly through risky prompts

It is most useful against:

- destructive terminal commands
- sensitive command execution routed through Safe Exec wrappers
- large or suspicious editor changes

## What Safe Exec Does

- detects risky terminal commands with regex-based matching
- attempts to interrupt and dispose a terminal before asking to replay
- requires approval for selected proxy and wrapped VS Code commands
- rolls back suspicious edits and only reapplies them on approval
- logs decisions and failures to an output channel

## What Safe Exec Cannot Guarantee

Safe Exec is not:

- a sandbox
- a hypervisor
- an OS security boundary
- a complete extension isolation layer
- a guarantee that no risky command ever begins running

Important limitations:

- terminal interception often happens after execution has already started
- `onDidWriteTerminalData` may not exist and is heuristic when present
- VS Code built-in commands are not transparently replaced
- edit interception is post-change and therefore rollback-based
- fresh replay terminals may not match original shell state, environment, or cwd exactly

## Likely Attack Vectors

- commands launched outside VS Code’s integrated terminal
- extensions spawning child processes directly through Node APIs
- terminals without working shell integration
- scripts that perform damage before interruption lands
- direct filesystem mutation that never surfaces as a normal text-document edit
- malicious or compromised extensions that intentionally bypass Safe Exec flows

## Residual Risk

Even when Safe Exec detects a risky action, damage may already have started. The extension is a friction layer, not a hard block. It should be paired with:

- least-privilege system accounts
- container or VM isolation for risky automation
- source control protections
- backups and recovery plans
- careful extension trust decisions

## Security Posture Statement

Safe Exec is a best-effort guardrail extension. It improves visibility and approval around dangerous operations, but it does not create complete isolation and should never be treated as a substitute for real sandboxing or host-level controls.
