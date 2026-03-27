# Rules Format

Safe Exec combines built-in defaults with workspace rules, selected settings, and optional policy bundles. By default the workspace rules file is `.vscode/safe-exec.rules.json`.

## Top-level keys

- `policyBundles`
- `dangerousCommands`
- `allowedCommands`
- `confirmationCommands`
- `protectedCommands`
- `editHeuristics`
- `fileOps`

`policyBundles` lets a workspace opt into stack- and workflow-specific presets without copying large rule lists by hand.

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
    }
  ],
  "editHeuristics": {
    "minChangedCharacters": 90,
    "minAffectedLines": 6,
    "multipleChangeCount": 2,
    "protectedPathPatterns": [
      "(^|[\\\\/])infra[\\\\/]"
    ]
  },
  "fileOps": {
    "maxSnapshotBytes": 131072,
    "maxFilesPerOperation": 12,
    "minBulkOperationCount": 6,
    "protectedPathPatterns": [
      "(^|[\\\\/])release[\\\\/]"
    ],
    "sensitiveExtensions": [
      ".pem"
    ],
    "captureBinarySnapshots": false
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

Important:

- protected-command rules only apply when the command is invoked through a Safe Exec proxy or `safeExec.runProtectedCommand`
- they do not transparently intercept raw built-in commands
- the built-in defaults now cover verified automation-heavy built-ins such as `workbench.action.terminal.runSelectedText`, `workbench.action.tasks.runTask`, `notebook.execute`, `notebook.cell.execute`, `interactive.execute`, `workbench.extensions.installExtension`, `workbench.extensions.uninstallExtension`, `vscode.openFolder`, and `vscode.newWindow`
- those stable command IDs were checked against the VS Code Built-in Commands reference updated on March 25, 2026 and against the current VS Code 1.113.0 host used in this repository's tests

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

### File-operation rules

`fileOps` controls best-effort file-operation evaluation and bounded recovery:

```json
{
  "enabled": true,
  "maxSnapshotBytes": 262144,
  "maxFilesPerOperation": 25,
  "minBulkOperationCount": 10,
  "protectedPathPatterns": [
    "(^|[\\\\/])\\.github[\\\\/]"
  ],
  "ignoredPathPatterns": [
    "(^|[\\\\/])dist[\\\\/]"
  ],
  "sensitiveExtensions": [
    ".pem",
    ".tfstate"
  ],
  "sensitiveFileNames": [
    "package.json",
    "Dockerfile"
  ],
  "captureBinarySnapshots": true
}
```

Fields:

- `enabled`
  Turn best-effort file-operation evaluation and recovery on or off.
- `maxSnapshotBytes`
  Per-file byte cap for delete and rename snapshots. Larger files fall back to metadata-only entries.
- `maxFilesPerOperation`
  Maximum number of files Safe Exec will snapshot for a single delete or rename operation.
- `minBulkOperationCount`
  Minimum affected-file count before Safe Exec classifies the operation as bulk.
- `protectedPathPatterns`
  Regex path patterns that raise file-operation risk and snapshot priority.
- `ignoredPathPatterns`
  Regex path patterns that lower the signal from matching file-operation paths unless those paths are also protected or sensitive. Safe Exec still records the observed operation when VS Code emits the event.
- `sensitiveExtensions`
  Extensions that raise file-operation risk and recovery priority.
- `sensitiveFileNames`
  File names that raise file-operation risk and recovery priority.
- `captureBinarySnapshots`
  When `true`, small binary files are stored byte-for-byte. When `false`, binary files fall back to metadata-only entries.

Operational notes:

- Safe Exec evaluates file operations only when VS Code emits supported create, delete, or rename events.
- External disk changes are not covered.
- `workspace.fs` mutations may bypass these hooks.
- Delete and rename flows use best-effort preflight plus bounded recovery snapshots, but this is still not a security boundary.
- Create flows are observed and classified, but Safe Exec does not automatically reverse them.

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
- `system-admin`
  Protect destructive disk and volume tooling, partition rewrites, and storage administration surfaces across Linux, macOS, and Windows.
- `persistence`
  Protect service and scheduled-task persistence, autorun registration, and shell profile mutation across Unix shells, PowerShell, launchd, systemd, cron, and Windows Task Scheduler.
- `secrets-identity`
  Protect credential and identity stores such as `.ssh`, cloud CLI config, Docker auth, kubeconfig, and common upload-style commands that can move local files over the network.
- `cloud-release`
  Protect package and chart publishing, container registry pushes, release publication, and common deploy commands for AWS, Azure, Google Cloud, serverless frameworks, and hosting CLIs.

Bundle coverage is intentionally incomplete. Bundles are starter presets, not a claim of full stack security.

For file operations, bundles reuse the same stack-specific protected-path additions already used by edit heuristics. This keeps edit protection and file-operation protection aligned on the same high-value paths.

Some bundles also add file-operation-sensitive extensions and file names when path matching alone is not enough. `secrets-identity`, for example, raises recovery priority for common encrypted secret stores and SSH private-key file names in addition to protecting their directory paths.

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

File operations also ship with conservative built-in sensitive names and extensions for certificate material, keystores, Terraform state, and related high-value files.

## Merge behavior

Safe Exec loads rules in this model:

1. built-in defaults
2. policy bundles selected in the rules file
3. policy bundles selected in settings
4. rule arrays and sections from the rules file
5. explicit settings overrides

Important merge details:

- `dangerousCommands`, `allowedCommands`, and `confirmationCommands` are appended to the default and bundled lists
- `protectedCommands` are merged by command key, then extra command IDs from `safeExec.protectedCommands` are added
- `policyBundles` from the rules file and settings are unioned
- numeric edit thresholds are overridden in the order defaults -> rules file -> settings
- numeric and boolean file-op scalars are overridden in the order defaults -> rules file -> settings
- `editHeuristics.protectedPathPatterns` and `editHeuristics.ignoredPathPatterns` are unioned
- `fileOps.protectedPathPatterns` and `fileOps.ignoredPathPatterns` are unioned
- file-op protected and ignored path lists also inherit the matching edit path lists so the same protected-path model applies across edits and file operations
- `fileOps.sensitiveExtensions` and `fileOps.sensitiveFileNames` are unioned

Current implementation note:

- `fileOps.ignoredPathPatterns` is merged into effective rules and lowers low-signal matches during file-operation classification, but Safe Exec still records the operation if VS Code emitted the event

This means settings and workspace rules add to coverage more often than they remove from it.

## Settings that affect rules

Relevant settings:

- `safeExec.rulesPath`
- `safeExec.policyBundles`
- `safeExec.protectedCommands`
- `safeExec.editHeuristics.minChangedCharacters`
- `safeExec.editHeuristics.minAffectedLines`
- `safeExec.editHeuristics.maxPreviewCharacters`
- `safeExec.fileOps.enabled`
- `safeExec.fileOps.maxSnapshotBytes`
- `safeExec.fileOps.maxFilesPerOperation`
- `safeExec.fileOps.minBulkOperationCount`
- `safeExec.fileOps.protectedPathPatterns`
- `safeExec.fileOps.ignoredPathPatterns`
- `safeExec.fileOps.sensitiveExtensions`
- `safeExec.fileOps.sensitiveFileNames`
- `safeExec.fileOps.captureBinarySnapshots`

Settings only override the built-in defaults when you set them explicitly.

## Validation notes

- invalid regex patterns are ignored and logged
- empty or malformed entries are skipped
- command matching is case-sensitive for exact command IDs and regex-controlled when `/regex/flags` syntax is used
- terminal regex rules are matched case-insensitively
- file-operation path matching uses case-insensitive regex evaluation

## Practical guidance

- use `allowedCommands` sparingly because it short-circuits prompting
- put stack-wide defaults in `policyBundles`, then add workspace-specific patterns in the rules file
- use protected-path patterns for files where rollback review and file-operation recovery are more useful than raw size thresholds
- keep `maxSnapshotBytes` and `maxFilesPerOperation` conservative if you want faster preflight on large folders
- do not assume file-operation coverage is complete for external tools, direct disk writes, or `workspace.fs` mutation paths
