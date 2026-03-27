import type * as vscode from "vscode";
import type { PolicyBundleDefinition } from "./types";

export const POLICY_BUNDLES: Record<string, PolicyBundleDefinition> = {
  "node-web": {
    id: "node-web",
    label: "Node / Web",
    description: "Protect package publishing, deploy-style scripts, env files, and JS toolchain config.",
    confirmationCommands: [
      { pattern: "\\b(?:npm|pnpm|yarn|bun)\\s+(?:publish|version)\\b", description: "Package registry publish or versioning", risk: "high" },
      { pattern: "\\b(?:npm|pnpm|yarn|bun)\\s+run\\s+(?:deploy|release|publish)\\b", description: "Scripted deploy or release", risk: "medium" },
      { pattern: "\\b(?:vercel|netlify|wrangler)\\b[^\\n\\r]*\\b(?:deploy|publish)\\b", description: "Web platform deploy command", risk: "medium" }
    ],
    editHeuristics: {
      protectedPathPatterns: [
        "(^|[\\\\/])next\\.config\\.[^\\\\/]+$",
        "(^|[\\\\/])vite\\.config\\.[^\\\\/]+$",
        "(^|[\\\\/])webpack\\.config\\.[^\\\\/]+$",
        "(^|[\\\\/])rollup\\.config\\.[^\\\\/]+$",
        "(^|[\\\\/])astro\\.config\\.[^\\\\/]+$"
      ]
    }
  },
  python: {
    id: "python",
    label: "Python",
    description: "Protect packaging, lockfiles, Python env configuration, and dependency sync commands.",
    confirmationCommands: [
      { pattern: "\\b(?:pip|pip3|poetry|pdm)\\s+(?:install|uninstall|lock|publish)\\b", description: "Python package mutation or publish", risk: "medium" },
      { pattern: "\\buv\\s+(?:pip|sync|lock)\\b", description: "uv dependency mutation", risk: "medium" }
    ],
    editHeuristics: {
      protectedPathPatterns: [
        "(^|[\\\\/])requirements(?:-.*)?\\.txt$",
        "(^|[\\\\/])\\.python-version$"
      ]
    }
  },
  docker: {
    id: "docker",
    label: "Docker",
    description: "Protect container/image cleanup, compose changes, and Docker build configuration.",
    dangerousCommands: [
      { pattern: "\\bdocker\\s+(?:rm|rmi|volume\\s+rm|network\\s+rm)\\b", description: "Docker resource removal", risk: "high" }
    ],
    confirmationCommands: [
      { pattern: "\\bdocker\\s+compose\\s+(?:down|up|build)\\b", description: "Docker Compose lifecycle command", risk: "medium" }
    ],
    editHeuristics: {
      protectedPathPatterns: [
        "(^|[\\\\/])\\.dockerignore$"
      ]
    }
  },
  "terraform-kubernetes": {
    id: "terraform-kubernetes",
    label: "Terraform / Kubernetes",
    description: "Protect infrastructure apply/change commands and IaC manifests.",
    confirmationCommands: [
      { pattern: "\\bterraform\\s+apply\\b", description: "Terraform apply", risk: "critical" },
      { pattern: "\\bkubectl\\s+(?:apply|patch|scale|rollout\\s+restart)\\b", description: "Kubernetes mutation", risk: "high" },
      { pattern: "\\bhelm\\s+(?:install|upgrade|uninstall|rollback)\\b", description: "Helm release mutation", risk: "high" }
    ],
    editHeuristics: {
      protectedPathPatterns: [
        "(^|[\\\\/])values(?:\\.[^\\\\/]+)?\\.ya?ml$"
      ]
    }
  },
  "git-ci": {
    id: "git-ci",
    label: "Git / CI",
    description: "Protect force-pushes, workflow triggers, and CI pipeline configuration.",
    confirmationCommands: [
      { pattern: "\\bgit\\s+push\\s+--force(?:-with-lease)?\\b", description: "Force push", risk: "high" },
      { pattern: "\\bgh\\s+workflow\\s+run\\b", description: "Trigger CI workflow", risk: "medium" }
    ],
    editHeuristics: {
      protectedPathPatterns: [
        "(^|[\\\\/])azure-pipelines\\.ya?ml$",
        "(^|[\\\\/])buildkite\\.ya?ml$"
      ]
    }
  }
};

export function getPolicyBundleDefinitions(bundleIds: readonly string[], output: vscode.OutputChannel): PolicyBundleDefinition[] {
  return Array.from(new Set(bundleIds))
    .map((bundleId) => {
      const bundle = POLICY_BUNDLES[bundleId];
      if (!bundle) {
        output.appendLine(`[rules] Ignoring unknown policy bundle "${bundleId}".`);
      }

      return bundle;
    })
    .filter((bundle): bundle is PolicyBundleDefinition => Boolean(bundle));
}
