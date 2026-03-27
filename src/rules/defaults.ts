import type { SafeExecRules } from "./types";

const COMMON_PROTECTED_PATH_PATTERNS = [
  "(^|[\\\\/])\\.github[\\\\/]",
  "(^|[\\\\/])\\.github[\\\\/]workflows[\\\\/]",
  "(^|[\\\\/])\\.gitlab-ci\\.ya?ml$",
  "(^|[\\\\/])\\.circleci[\\\\/]",
  "(^|[\\\\/])\\.vscode[\\\\/]",
  "(^|[\\\\/])\\.env(?:\\.[^\\\\/]+)?$",
  "(^|[\\\\/])\\.npmrc$",
  "(^|[\\\\/])\\.pypirc$",
  "(^|[\\\\/])package\\.json$",
  "(^|[\\\\/])tsconfig\\.json$",
  "(^|[\\\\/])yarn\\.lock$",
  "(^|[\\\\/])bun\\.lockb$",
  "(^|[\\\\/])pnpm-lock\\.yaml$",
  "(^|[\\\\/])pnpm-workspace\\.yaml$",
  "(^|[\\\\/])package-lock\\.json$",
  "(^|[\\\\/])pyproject\\.toml$",
  "(^|[\\\\/])poetry\\.lock$",
  "(^|[\\\\/])uv\\.lock$",
  "(^|[\\\\/])Pipfile(?:\\.lock)?$",
  "(^|[\\\\/])Dockerfile(?:\\.[^\\\\/]+)?$",
  "(^|[\\\\/])(?:docker-)?compose(?:\\.[^\\\\/]+)?\\.ya?ml$",
  "\\.tf$",
  "\\.tfvars(?:\\.json)?$",
  "(^|[\\\\/])\\.terraform\\.lock\\.hcl$",
  "(^|[\\\\/])Chart\\.ya?ml$",
  "(^|[\\\\/])kustomization\\.ya?ml$",
  "(^|[\\\\/])Jenkinsfile$"
];

const COMMON_IGNORED_PATH_PATTERNS = [
  "(^|[\\\\/])node_modules[\\\\/]",
  "(^|[\\\\/])out[\\\\/]",
  "(^|[\\\\/])dist[\\\\/]",
  "\\.git[\\\\/]"
];

const FILE_OPERATION_SENSITIVE_EXTENSIONS = [
  ".pem",
  ".key",
  ".crt",
  ".cer",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".tfstate",
  ".tfvars",
  ".kubeconfig"
];

const FILE_OPERATION_SENSITIVE_FILE_NAMES = [
  ".env",
  ".npmrc",
  ".pypirc",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "Dockerfile",
  "Chart.yaml",
  "kustomization.yaml",
  "Jenkinsfile"
];

export const DEFAULT_RULES: SafeExecRules = {
  dangerousCommands: [
    { pattern: "\\brm\\s+-rf\\b", description: "Recursive force delete", risk: "critical" },
    {
      pattern: "\\b(?:Remove-Item|ri|rm)\\b(?=[^\\n\\r]*-Recurse\\b)(?=[^\\n\\r]*-Force\\b)[^\\n\\r]*",
      description: "PowerShell recursive forced delete",
      risk: "critical"
    },
    {
      pattern: "\\b(?:del|erase)\\b(?=[^\\n\\r]*\\s/f\\b)(?=[^\\n\\r]*\\s/s\\b)(?=[^\\n\\r]*\\s/q\\b)[^\\n\\r]*",
      description: "Windows cmd recursive forced delete",
      risk: "critical"
    },
    {
      pattern: "\\b(?:rmdir|rd)\\b(?=[^\\n\\r]*\\s/s\\b)(?=[^\\n\\r]*\\s/q\\b)[^\\n\\r]*",
      description: "Windows cmd recursive directory removal",
      risk: "critical"
    },
    { pattern: "\\bgit\\s+reset\\s+--hard\\b", description: "Git hard reset", risk: "high" },
    { pattern: "\\bgit\\s+clean\\s+-fdx\\b", description: "Git clean destructive sweep", risk: "high" },
    { pattern: "\\bdocker\\s+system\\s+prune\\s+-f\\b", description: "Docker destructive cleanup", risk: "high" },
    { pattern: "\\bterraform\\s+destroy\\b", description: "Terraform destroy", risk: "critical" },
    { pattern: "\\bkubectl\\s+delete\\b", description: "Kubernetes delete", risk: "high" },
    { pattern: "\\bmkfs(?:\\.[A-Za-z0-9_+-]+)?\\b", description: "Filesystem formatting", risk: "critical" },
    { pattern: "\\bdd\\b[^\\n\\r]*\\bof=/dev/", description: "Raw device write", risk: "critical" },
    { pattern: "\\bdiskutil\\s+erase(?:Disk|Volume)\\b", description: "macOS disk erase", risk: "critical" },
    { pattern: "\\bFormat-Volume\\b", description: "Windows volume formatting", risk: "critical" },
    { pattern: "\\b(?:Clear-Disk|Initialize-Disk)\\b", description: "Windows disk reinitialization", risk: "critical" },
    { pattern: "\\bdiskpart\\b(?![^\\n\\r]*\\s+/\\?)", description: "Windows disk partitioning tool", risk: "critical" }
  ],
  allowedCommands: [
    {
      pattern: "^\\s*(pwd|ls|dir|Get-ChildItem|gci|Get-Location|gl|git\\s+(?:status|diff|log|show|branch))\\b",
      description: "Common read-only commands across Unix shells and PowerShell",
      risk: "low"
    }
  ],
  confirmationCommands: [
    { pattern: "\\bgit\\s+push\\b", description: "Git push", risk: "medium" },
    { pattern: "\\bnpm\\s+publish\\b", description: "Package publishing", risk: "high" },
    { pattern: "\\bgh\\s+pr\\s+merge\\b", description: "Pull request merge", risk: "high" },
    { pattern: "\\bcode\\s+--install-extension\\b", description: "Install extension", risk: "medium" },
    {
      pattern: "\\b(?:brew|apt(?:-get)?|dnf|yum|pacman|winget|choco|scoop)\\s+(?:install|upgrade|remove|uninstall)\\b",
      description: "System package manager mutation",
      risk: "medium"
    },
    { pattern: "\\bSet-ExecutionPolicy\\b", description: "PowerShell execution policy change", risk: "high" }
  ],
  protectedCommands: [
    {
      command: "workbench.action.terminal.runSelectedText",
      description: "Run selected text in terminal",
      risk: "high"
    },
    {
      command: "workbench.action.tasks.runTask",
      description: "Run a configured task",
      risk: "medium"
    },
    {
      command: "github.copilot.generate",
      description: "AI code generation",
      risk: "medium"
    }
  ],
  editHeuristics: {
    minChangedCharacters: 120,
    minAffectedLines: 8,
    maxPreviewCharacters: 1500,
    multipleChangeCount: 3,
    protectedPathPatterns: COMMON_PROTECTED_PATH_PATTERNS,
    ignoredPathPatterns: COMMON_IGNORED_PATH_PATTERNS
  },
  fileOps: {
    enabled: true,
    maxSnapshotBytes: 262144,
    maxFilesPerOperation: 25,
    minBulkOperationCount: 10,
    protectedPathPatterns: COMMON_PROTECTED_PATH_PATTERNS,
    ignoredPathPatterns: COMMON_IGNORED_PATH_PATTERNS,
    sensitiveExtensions: FILE_OPERATION_SENSITIVE_EXTENSIONS,
    sensitiveFileNames: FILE_OPERATION_SENSITIVE_FILE_NAMES,
    captureBinarySnapshots: true
  }
};

export const SAMPLE_RULES_JSON = `${JSON.stringify(DEFAULT_RULES, null, 2)}\n`;
