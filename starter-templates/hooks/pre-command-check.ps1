param(
  [string]$CommandText = "",
  [string]$Cwd = ""
)

if ([string]::IsNullOrWhiteSpace($Cwd)) {
  $Cwd = (Get-Location).Path
}

if ([string]::IsNullOrWhiteSpace($CommandText)) {
  Write-Error "Usage: pre-command-check.ps1 -CommandText '<command>' [-Cwd '<path>']"
  exit 64
}

$blockedPatterns = @(
  '(^|\s)rm\s+-rf\s+/',
  'git\s+reset\s+--hard',
  'git\s+clean\s+-fdx',
  'docker\s+system\s+prune(\s|$)',
  'kubectl\s+delete(\s|$)'
)

$protectedPathPatterns = @(
  '(^|\s)(\.github[\\/]|\.vscode[\\/]|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Dockerfile|docker-compose\.ya?ml)'
)

foreach ($pattern in $blockedPatterns) {
  if ($CommandText -match $pattern) {
    [Console]::Error.WriteLine("Denied by starter hook: $CommandText")
    [Console]::Error.WriteLine("Reason: destructive commands should stay behind explicit user approval and an isolated execution path.")
    exit 1
  }
}

foreach ($pattern in $protectedPathPatterns) {
  if ($CommandText -match $pattern) {
    [Console]::Error.WriteLine("Review required for a protected path in: $CommandText")
    [Console]::Error.WriteLine("Working directory: $Cwd")
    [Console]::Error.WriteLine("Route this through explicit Safe Exec commands or get fresh human approval.")
    exit 1
  }
}

exit 0
