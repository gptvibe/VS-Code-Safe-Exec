# Rules Format

Safe Exec merges built-in defaults with a workspace JSON file. By default that file lives at `.vscode/safe-exec.rules.json`.

Supported top-level keys:

- `dangerousCommands`
- `allowedCommands`
- `confirmationCommands`
- `protectedCommands`
- `editHeuristics`

Each terminal command rule uses a regex `pattern`. Protected command rules use a VS Code command ID in `command`. Exact command IDs are the simplest option, but `/regex/flags` syntax is also accepted by the protected command matcher.

Example:

```json
{
  "dangerousCommands": [
    {
      "pattern": "\\brm\\s+-rf\\b",
      "description": "Recursive force delete",
      "risk": "critical"
    },
    {
      "pattern": "\\b(?:Remove-Item|ri|rm)\\b(?=[^\\n\\r]*-Recurse\\b)(?=[^\\n\\r]*-Force\\b)[^\\n\\r]*",
      "description": "PowerShell recursive forced delete",
      "risk": "critical"
    },
    {
      "pattern": "\\b(?:del|erase)\\b(?=[^\\n\\r]*\\s/f\\b)(?=[^\\n\\r]*\\s/s\\b)(?=[^\\n\\r]*\\s/q\\b)[^\\n\\r]*",
      "description": "Windows cmd recursive forced delete",
      "risk": "critical"
    },
    {
      "pattern": "\\b(?:rmdir|rd)\\b(?=[^\\n\\r]*\\s/s\\b)(?=[^\\n\\r]*\\s/q\\b)[^\\n\\r]*",
      "description": "Windows cmd recursive directory removal",
      "risk": "critical"
    },
    {
      "pattern": "\\bgit\\s+reset\\s+--hard\\b",
      "description": "Discard working tree changes",
      "risk": "high"
    },
    {
      "pattern": "\\bgit\\s+clean\\s+-fdx\\b",
      "description": "Delete ignored and untracked files",
      "risk": "high"
    },
    {
      "pattern": "\\bdocker\\s+system\\s+prune\\s+-f\\b",
      "description": "Destroy unused Docker artifacts",
      "risk": "high"
    },
    {
      "pattern": "\\bterraform\\s+destroy\\b",
      "description": "Destroy infrastructure",
      "risk": "critical"
    },
    {
      "pattern": "\\bkubectl\\s+delete\\b",
      "description": "Delete Kubernetes resources",
      "risk": "high"
    },
    {
      "pattern": "\\bmkfs(?:\\.[A-Za-z0-9_+-]+)?\\b",
      "description": "Format a filesystem",
      "risk": "critical"
    },
    {
      "pattern": "\\bdd\\b[^\\n\\r]*\\bof=/dev/",
      "description": "Write directly to a device",
      "risk": "critical"
    },
    {
      "pattern": "\\bdiskutil\\s+erase(?:Disk|Volume)\\b",
      "description": "Erase a macOS disk or volume",
      "risk": "critical"
    },
    {
      "pattern": "\\bFormat-Volume\\b",
      "description": "Format a Windows volume",
      "risk": "critical"
    },
    {
      "pattern": "\\b(?:Clear-Disk|Initialize-Disk)\\b",
      "description": "Reinitialize a Windows disk",
      "risk": "critical"
    },
    {
      "pattern": "\\bdiskpart\\b(?![^\\n\\r]*\\s+/\\?)",
      "description": "Open or script the Windows disk partitioning tool",
      "risk": "critical"
    }
  ],
  "allowedCommands": [
    {
      "pattern": "^\\s*(pwd|ls|dir|Get-ChildItem|gci|Get-Location|gl|git\\s+(?:status|diff|log|show|branch))\\b",
      "description": "Common inspection commands across Unix shells and PowerShell",
      "risk": "low"
    }
  ],
  "confirmationCommands": [
    {
      "pattern": "\\bgit\\s+push\\b",
      "description": "Push to a remote repository",
      "risk": "medium"
    },
    {
      "pattern": "\\bnpm\\s+publish\\b",
      "description": "Publish a package",
      "risk": "high"
    },
    {
      "pattern": "\\bgh\\s+pr\\s+merge\\b",
      "description": "Merge a pull request",
      "risk": "high"
    },
    {
      "pattern": "\\bcode\\s+--install-extension\\b",
      "description": "Install a VS Code extension",
      "risk": "medium"
    },
    {
      "pattern": "\\b(?:brew|apt(?:-get)?|dnf|yum|pacman|winget|choco|scoop)\\s+(?:install|upgrade|remove|uninstall)\\b",
      "description": "Mutate packages with a system package manager",
      "risk": "medium"
    },
    {
      "pattern": "\\bSet-ExecutionPolicy\\b",
      "description": "Change the PowerShell execution policy",
      "risk": "high"
    }
  ],
  "protectedCommands": [
    {
      "command": "workbench.action.terminal.runSelectedText",
      "description": "Run selected text in terminal",
      "risk": "high"
    },
    {
      "command": "workbench.action.tasks.runTask",
      "description": "Run a workspace task",
      "risk": "medium"
    },
    {
      "command": "github.copilot.generate",
      "description": "Trigger AI generation",
      "risk": "medium"
    }
  ],
  "editHeuristics": {
    "minChangedCharacters": 120,
    "minAffectedLines": 8,
    "maxPreviewCharacters": 1500,
    "multipleChangeCount": 3,
    "protectedPathPatterns": [
      "(^|[\\\\/])\\.github[\\\\/]",
      "(^|[\\\\/])\\.vscode[\\\\/]",
      "(^|[\\\\/])package\\.json$",
      "(^|[\\\\/])tsconfig\\.json$"
    ],
    "ignoredPathPatterns": [
      "(^|[\\\\/])node_modules[\\\\/]",
      "(^|[\\\\/])out[\\\\/]"
    ]
  }
}
```

Notes:

- terminal command rules are regex strings
- invalid regex patterns are ignored and logged
- the built-in defaults intentionally include Unix, macOS, PowerShell, and `cmd.exe` examples
- `allowedCommands` short-circuits terminal prompting
- `dangerousCommands` and `confirmationCommands` both trigger approvals, but their risk labels can differ
- edit heuristics are conservative thresholds, not semantic code analysis
