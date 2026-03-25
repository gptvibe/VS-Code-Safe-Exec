# Rules Format

Safe Exec combines built-in defaults with workspace rules, selected settings, and optional policy bundles. By default the workspace rules file is `.vscode/safe-exec.rules.json`.

## Top-level keys

- `policyBundles`
- `dangerousCommands`
- `allowedCommands`
- `confirmationCommands`
- `protectedCommands`
- `editHeuristics`

`policyBundles` is new and lets a workspace opt into additional stack-specific presets without copying large rule lists by hand.

## Example rules file

```json
{
  "policyBundles": ["node-web", "git-ci"],
  "dangerousCommands": [
    {
      "pattern": "\\bterraform\\s+state\\s+rm\\b",
      "description": "Remove Terraform state entries",
      "risk": "high"
    }
  ],
  "confirmationCommands": [
    {
      "pattern": "\\bgh\\s+release\\s+create\\b",
      "description": "Create a GitHub release",
      "risk": "high"
    }
  ],
  "protectedCommands": [
    {
      "command": "workbench.action.tasks.runTask",
      "description": "Always confirm before running tasks in this workspace",
      "risk": "high"
    },
    {
      "command": "/^git\\./i",
      "description": "Require approval for Git extension commands routed through Safe Exec",
      "risk": "medium"
    }
  ],
  "editHeuristics": {
    "minChangedCharacters": 90,
    "minAffectedLines": 6,
    "multipleChangeCount": 2,
    "protectedPathPatterns": [
      "(^|[\\\\/])infra[\\\\/]",
      "(^|[\\\\/])scripts[\\\\/]release\\.[^\\\\/]+$"
    ],
    "ignoredPathPatterns": [
      "(^|[\\\\/])coverage[\\\\/]"
    ]
  }
}
```

## Rule object shapes

### Terminal command rules

`dangerousCommands`, `allowedCommands`, and `confirmationCommands` use regex pattern rules:

```json
{
  "pattern": "\\bgit\\s+push\\b",
  "description": "Push to a remote",
  "risk": "medium"
}
```

Fields:

- `pattern`
  Regex string. Safe Exec applies it case-insensitively.
- `description`
  Optional human-readable explanation shown in approval details and logs.
- `risk`
  Optional risk label: `low`, `medium`, `high`, or `critical`.

### Protected command rules

`protectedCommands` accepts either exact VS Code command IDs or `/regex/flags` syntax:

```json
{
  "command": "workbench.action.tasks.runTask",
  "description": "Run a workspace task",
  "risk": "medium"
}
```

```json
{
  "command": "/^github\\./i",
  "description": "GitHub extension commands routed through Safe Exec",
  "risk": "medium"
}
```

Important:

- protected-command rules only apply when the command is invoked through a Safe Exec proxy or `safeExec.runProtectedCommand`
- they do not transparently intercept raw built-in commands

### Edit heuristics

`editHeuristics` controls when rollback-and-review should trigger:

```json
{
  "minChangedCharacters": 120,
  "minAffectedLines": 8,
  "maxPreviewCharacters": 1500,
  "multipleChangeCount": 3,
  "protectedPathPatterns": [
    "(^|[\\\\/])\\.github[\\\\/]",
    "(^|[\\\\/])\\.env(?:\\.[^\\\\/]+)?$"
  ],
  "ignoredPathPatterns": [
    "(^|[\\\\/])node_modules[\\\\/]"
  ]
}
```

Notes:

- `multipleChangeCount` helps catch broad multi-range edits
- `protectedPathPatterns` increases sensitivity on high-value files
- `ignoredPathPatterns` suppresses review for noisy generated paths
- `maxPreviewCharacters` is now a legacy compatibility field; Safe Exec uses a real diff review flow for suspicious edits
- suspicious edit approval is still post-change and uses a rollback-and-reapply flow with `Review Diff`, `Reapply Edit`, and `Deny`

## Policy bundles

Built-in bundle IDs:

- `node-web`
  Protect package publishing, deploy-style scripts, env files, and major JS toolchain config.
- `python`
  Protect packaging, lockfiles, Python env config, and dependency sync commands.
- `docker`
  Protect container lifecycle commands, compose changes, and Docker config.
- `terraform-kubernetes`
  Protect Terraform apply, Helm changes, Kubernetes mutations, and related manifests.
- `git-ci`
  Protect force-pushes, workflow triggers, and common CI pipeline files.

Bundle coverage is intentionally incomplete. Bundles are starter presets, not a claim of full stack security.

## Built-in protected-path defaults

The built-in defaults already include many high-value paths such as:

- `.github/` and common CI files
- `.vscode/`
- `.env*`
- `package.json`
- `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`
- `pyproject.toml`, `poetry.lock`, `uv.lock`, `Pipfile`, `Pipfile.lock`
- `Dockerfile` and compose files
- `.tf`, `.tfvars`, `.terraform.lock.hcl`
- `Chart.yaml`, `values*.yaml`, `kustomization.yaml`
- `Jenkinsfile`

You can add or narrow patterns in the rules file. Safe Exec merges your additional patterns with the defaults.

## Merge behavior

Safe Exec loads rules in this model:

1. built-in defaults
2. policy bundles selected in the rules file
3. policy bundles selected in settings
4. rule arrays from the rules file
5. selected settings overrides

Important merge details:

- `dangerousCommands`, `allowedCommands`, and `confirmationCommands` are appended to the default and bundled lists
- `protectedCommands` are merged by command key, then extra command IDs from `safeExec.protectedCommands` are added
- `policyBundles` from the rules file and settings are unioned
- numeric edit thresholds are overridden in the order defaults -> rules file -> settings
- `protectedPathPatterns` and `ignoredPathPatterns` are unioned

This means settings and workspace rules add to coverage more often than they remove from it.

## Settings that affect rules

Relevant settings:

- `safeExec.rulesPath`
- `safeExec.policyBundles`
- `safeExec.protectedCommands`
- `safeExec.editHeuristics.minChangedCharacters`
- `safeExec.editHeuristics.minAffectedLines`
- `safeExec.editHeuristics.maxPreviewCharacters`

Example settings snippet:

```json
{
  "safeExec.policyBundles": ["python", "docker"],
  "safeExec.protectedCommands": [
    "workbench.action.tasks.runTask"
  ]
}
```

## Validation notes

- invalid regex patterns are ignored and logged
- empty or malformed entries are skipped
- command matching is case-sensitive for exact command IDs and regex-controlled when `/regex/flags` syntax is used
- terminal regex rules are matched case-insensitively

## Practical guidance

- use `allowedCommands` sparingly because it short-circuits prompting
- put stack-wide defaults in `policyBundles`, then add workspace-specific patterns in the rules file
- use protected-path patterns for files where rollback review is more useful than raw character thresholds
- do not assume regex coverage is complete for aliases, wrapper scripts, or custom internal tooling
