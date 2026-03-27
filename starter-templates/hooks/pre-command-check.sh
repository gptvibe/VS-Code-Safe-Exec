#!/usr/bin/env bash
set -euo pipefail

command_text="${1:-}"
cwd="${2:-$(pwd)}"

if [[ -z "$command_text" ]]; then
  echo "Usage: pre-command-check.sh '<command>' [cwd]" >&2
  exit 64
fi

blocked_patterns=(
  '(^|[[:space:]])rm[[:space:]]+-rf[[:space:]]+/'
  'git[[:space:]]+reset[[:space:]]+--hard'
  'git[[:space:]]+clean[[:space:]]+-fdx'
  'docker[[:space:]]+system[[:space:]]+prune([[:space:]]|$)'
  'kubectl[[:space:]]+delete([[:space:]]|$)'
)

protected_path_patterns=(
  '(^|[[:space:]])(\.github[\\/]|\.vscode[\\/]|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Dockerfile|docker-compose\.ya?ml)'
)

for pattern in "${blocked_patterns[@]}"; do
  if [[ "$command_text" =~ $pattern ]]; then
    echo "Denied by starter hook: $command_text" >&2
    echo "Reason: destructive commands should stay behind explicit user approval and an isolated execution path." >&2
    exit 1
  fi
done

for pattern in "${protected_path_patterns[@]}"; do
  if [[ "$command_text" =~ $pattern ]]; then
    echo "Review required for a protected path in: $command_text" >&2
    echo "Working directory: $cwd" >&2
    echo "Route this through explicit Safe Exec commands or get fresh human approval." >&2
    exit 1
  fi
done

exit 0
