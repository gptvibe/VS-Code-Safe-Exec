import type * as vscode from "vscode";
import type { PolicyBundleDefinition } from "./types";

const PERSISTENCE_PROTECTED_PATHS = [
  "(^|[\\\\/])\\.(?:bashrc|bash_profile|zshrc|zprofile|profile)$",
  "(^|[\\\\/])\\.config[\\\\/]fish[\\\\/]config\\.fish$",
  "(^|[\\\\/])(?:PowerShell|WindowsPowerShell)[\\\\/]Microsoft\\.PowerShell_profile\\.ps1$",
  "(^|[\\\\/])(?:etc|usr[\\\\/]lib)[\\\\/]systemd[\\\\/].*\\.(?:service|socket|timer)$",
  "(^|[\\\\/])etc[\\\\/]init\\.d[\\\\/].+",
  "(^|[\\\\/])etc[\\\\/]rc\\.local$",
  "(^|[\\\\/])Library[\\\\/](?:LaunchAgents|LaunchDaemons)[\\\\/].+\\.plist$",
  "(^|[\\\\/])(?:etc[\\\\/]cron\\.(?:d|daily|hourly|monthly|weekly)[\\\\/].+|var[\\\\/]spool[\\\\/]cron[\\\\/].+)$",
  "(^|[\\\\/])Windows[\\\\/]System32[\\\\/]Tasks(?:[\\\\/]|$)"
];

const SECRETS_IDENTITY_PROTECTED_PATHS = [
  "(^|[\\\\/])\\.ssh[\\\\/](?:config|authorized_keys|known_hosts|id_(?:rsa|dsa|ecdsa|ed25519)(?:\\.pub)?)$",
  "(^|[\\\\/])\\.aws[\\\\/](?:credentials|config)$",
  "(^|[\\\\/])\\.azure[\\\\/]",
  "(^|[\\\\/])(?:\\.config[\\\\/]gcloud|AppData[\\\\/]Roaming[\\\\/]gcloud)[\\\\/]",
  "(^|[\\\\/])\\.kube[\\\\/]config$",
  "(^|[\\\\/])\\.docker[\\\\/]config\\.json$",
  "(^|[\\\\/])containers[\\\\/]auth\\.json$",
  "(^|[\\\\/])\\.netrc$",
  "(^|[\\\\/])\\.git-credentials$",
  "(^|[\\\\/])\\.gnupg[\\\\/]"
];

const CLOUD_RELEASE_PROTECTED_PATHS = [
  "(^|[\\\\/])\\.releaserc(?:\\.[^\\\\/]+)?$",
  "(^|[\\\\/])release(?:-[^\\\\/]+)?\\.config\\.[^\\\\/]+$",
  "(^|[\\\\/])cloudbuild\\.ya?ml$",
  "(^|[\\\\/])appspec\\.ya?ml$",
  "(^|[\\\\/])serverless\\.ya?ml$",
  "(^|[\\\\/])samconfig\\.toml$",
  "(^|[\\\\/])wrangler\\.toml$",
  "(^|[\\\\/])firebase\\.json$",
  "(^|[\\\\/])vercel\\.json$",
  "(^|[\\\\/])netlify\\.toml$",
  "(^|[\\\\/])fly\\.toml$",
  "(^|[\\\\/])amplify\\.ya?ml$"
];

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
  },
  "system-admin": {
    id: "system-admin",
    label: "System Admin",
    description: "Protect destructive disk and volume tooling, partition rewrites, and storage administration surfaces.",
    dangerousCommands: [
      {
        pattern: "\\bwipefs\\b[^\\n\\r]*(?:^|\\s)(?:-a|--all)(?=\\s|$)",
        description: "Linux filesystem signature wipe",
        risk: "critical"
      },
      { pattern: "\\bblkdiscard\\b", description: "Linux block discard on a device", risk: "critical" },
      {
        pattern: "\\b(?:sgdisk|gdisk)\\b[^\\n\\r]*(?:^|\\s)(?:--zap-all|-Z)(?=\\s|$)",
        description: "Partition table wipe",
        risk: "critical"
      },
      { pattern: "\\b(?:pvremove|vgremove|lvremove)\\b", description: "LVM volume removal", risk: "critical" },
      { pattern: "\\bzpool\\s+destroy\\b", description: "ZFS pool destruction", risk: "critical" },
      { pattern: "\\bmdadm\\b[^\\n\\r]*\\b--zero-superblock\\b", description: "RAID metadata wipe", risk: "critical" },
      { pattern: "\\bparted\\b[^\\n\\r]*\\bmklabel\\b", description: "Partition table rewrite", risk: "critical" },
      { pattern: "\\bnewfs(?:\\.[A-Za-z0-9_+-]+)?\\b", description: "BSD filesystem formatting", risk: "critical" },
      { pattern: "\\bdiskutil\\s+apfs\\s+delete(?:Container|Volume)\\b", description: "macOS APFS container or volume deletion", risk: "critical" }
    ],
    editHeuristics: {
      protectedPathPatterns: [
        "(^|[\\\\/])fstab$",
        "(^|[\\\\/])crypttab$",
        "(^|[\\\\/])mdadm\\.conf$"
      ]
    }
  },
  persistence: {
    id: "persistence",
    label: "Persistence",
    description: "Protect service/task persistence, shell profile mutation, and autorun configuration across platforms.",
    confirmationCommands: [
      { pattern: "\\bsystemctl\\s+(?:enable|disable|mask|unmask|preset(?:-all)?|link)\\b", description: "systemd persistence change", risk: "high" },
      {
        pattern: "\\b(?:update-rc\\.d\\s+\\S+\\s+(?:defaults|enable|disable|remove)|chkconfig\\s+\\S+\\s+(?:on|off)|rc-update\\s+(?:add|del))\\b",
        description: "SysV or OpenRC service persistence change",
        risk: "high"
      },
      { pattern: "\\blaunchctl\\s+(?:bootstrap|bootout|enable|disable|load|unload)\\b", description: "macOS launchd service registration", risk: "high" },
      { pattern: "\\b(?:sc(?:\\.exe)?\\s+create|New-Service)\\b", description: "Windows service creation", risk: "high" },
      {
        pattern: "\\b(?:sc(?:\\.exe)?\\s+config\\b[^\\n\\r]*\\bstart=|Set-Service\\b[^\\n\\r]*(?:^|\\s)-StartupType\\b)\\b",
        description: "Windows service startup persistence change",
        risk: "high"
      },
      { pattern: "\\b(?:schtasks(?:\\.exe)?\\s+/(?:Create|Change)|Register-ScheduledTask|Set-ScheduledTask)\\b", description: "Scheduled task persistence change", risk: "high" },
      {
        pattern: "\\b(?:reg(?:\\.exe)?\\s+add\\b[^\\n\\r]*\\\\(?:Run|RunOnce)\\b|(?:New-ItemProperty|Set-ItemProperty)\\b[^\\n\\r]*\\\\(?:Run|RunOnce)\\b)",
        description: "Windows Run-key autorun change",
        risk: "high"
      },
      {
        pattern: "(?:>>|>|\\|\\s*tee(?:\\s+-a)?)\\s*(?:['\"])?(?:~[\\\\/]|\\$HOME[\\\\/])?\\.(?:bashrc|bash_profile|zshrc|zprofile|profile)(?:['\"])?\\b",
        description: "Unix shell profile mutation via terminal",
        risk: "high"
      },
      {
        pattern: "(?:>>|>|\\|\\s*tee(?:\\s+-a)?)\\s*(?:['\"])?(?:~[\\\\/]|\\$HOME[\\\\/])?\\.config[\\\\/]fish[\\\\/]config\\.fish(?:['\"])?\\b",
        description: "Fish shell profile mutation via terminal",
        risk: "high"
      },
      {
        pattern: "\\b(?:Add-Content|Set-Content|Out-File|New-Item|ni)\\b[^\\n\\r]*\\$(?:PROFILE|profile)\\b",
        description: "PowerShell profile mutation",
        risk: "high"
      }
    ],
    editHeuristics: {
      protectedPathPatterns: PERSISTENCE_PROTECTED_PATHS
    }
  },
  "secrets-identity": {
    id: "secrets-identity",
    label: "Secrets / Identity",
    description: "Protect credential and identity files, secret-bearing key material, and outbound upload-style commands.",
    confirmationCommands: [
      {
        pattern: "\\bcurl\\b[^\\n\\r]*(?:^|\\s)(?:-T|--upload-file|-F|--form)(?=\\s|$)",
        description: "curl file upload",
        risk: "high"
      },
      {
        pattern: "\\bcurl\\b[^\\n\\r]*(?:^|\\s)--data-binary(?=\\s|$)[^\\n\\r]*@",
        description: "curl binary upload from a local file",
        risk: "high"
      },
      {
        pattern: "\\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\\b[^\\n\\r]*(?:^|\\s)-InFile\\b",
        description: "PowerShell upload from a local file",
        risk: "high"
      },
      { pattern: "\\bscp\\b", description: "Secure copy upload or download", risk: "high" },
      {
        pattern: "\\brsync\\b[^\\n\\r]*(?:[A-Za-z0-9._%+-]+@[^:\\s]+:|rsync://|sftp://)",
        description: "Remote rsync transfer",
        risk: "high"
      }
    ],
    editHeuristics: {
      protectedPathPatterns: SECRETS_IDENTITY_PROTECTED_PATHS
    },
    fileOps: {
      protectedPathPatterns: SECRETS_IDENTITY_PROTECTED_PATHS,
      sensitiveExtensions: [".age", ".asc", ".gpg", ".kdbx", ".pgp"],
      sensitiveFileNames: [".netrc", ".git-credentials", "authorized_keys", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
    }
  },
  "cloud-release": {
    id: "cloud-release",
    label: "Cloud / Release",
    description: "Protect registry publish flows, container pushes, release tooling, and common cloud deploy commands.",
    confirmationCommands: [
      { pattern: "\\b(?:npm|pnpm|yarn|bun)\\s+(?:publish|version|dist-tag)\\b", description: "JavaScript package publish or release tagging", risk: "high" },
      { pattern: "\\b(?:twine|poetry|uv|cargo|gem|nuget)\\s+(?:upload|publish|push)\\b", description: "Package registry publish across ecosystems", risk: "high" },
      { pattern: "\\b(?:docker|podman)\\s+push\\b", description: "Container registry push", risk: "high" },
      { pattern: "\\bdocker\\s+buildx\\s+build\\b[^\\n\\r]*\\s--push\\b", description: "Buildx image build and push", risk: "high" },
      { pattern: "\\bhelm\\s+push\\b", description: "Helm chart publish", risk: "high" },
      { pattern: "\\bgh\\s+release\\s+(?:create|upload|edit)\\b", description: "GitHub release publication", risk: "high" },
      {
        pattern: "\\b(?:sam\\s+deploy|cdk\\s+deploy|serverless\\s+deploy|sls\\s+deploy|firebase\\s+deploy|flyctl\\s+deploy|railway\\s+up)\\b",
        description: "Application deploy via release tooling",
        risk: "high"
      },
      {
        pattern: "\\baws\\s+(?:cloudformation\\s+deploy|ecs\\s+update-service|lambda\\s+(?:update-function-code|update-function-configuration|publish-version)|appconfig\\s+start-deployment)\\b",
        description: "AWS release or deploy command",
        risk: "high"
      },
      { pattern: "\\bgcloud\\s+(?:run\\s+deploy|functions\\s+deploy|app\\s+deploy)\\b", description: "Google Cloud deploy command", risk: "high" },
      {
        pattern: "\\baz\\s+(?:webapp\\s+deploy|functionapp\\s+deployment\\s+source\\s+config-zip|containerapp\\s+up)\\b",
        description: "Azure deploy command",
        risk: "high"
      },
      { pattern: "\\b(?:vercel|netlify|wrangler)\\b[^\\n\\r]*\\b(?:deploy|publish)\\b", description: "Edge or hosting platform deploy command", risk: "medium" }
    ],
    editHeuristics: {
      protectedPathPatterns: CLOUD_RELEASE_PROTECTED_PATHS
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
