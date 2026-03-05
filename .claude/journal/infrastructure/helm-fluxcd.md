## [2026-03-05 05:30] — Helm Chart + FluxCD GitOps Implementation

**Task:** Convert raw k8s manifests into Helm chart with FluxCD GitOps, replacing scattered env vars with ConfigMap-mounted ax.yaml
**What I did:**
- Added AX_CONFIG_PATH env var support to configPath() (TDD)
- Added SANDBOX_TEMPLATE_DIR support to pool controller (TDD)
- Created full Helm chart at charts/ax/ with Chart.yaml, values.yaml, _helpers.tpl
- Created 15+ Helm templates: ConfigMap, Host, Agent Runtime, Pool Controller, Network Policies, Cloud SQL Proxy, NATS Stream Init Job
- Created FluxCD structure with SOPS config, Git/Helm sources, staging/production overlays
- Archived raw k8s/ manifests to k8s/archive/
**Files touched:** src/paths.ts, src/pool-controller/main.ts, tests/paths.test.ts, tests/pool-controller/main.test.ts, charts/ax/**, flux/**, .sops.yaml, .gitignore, k8s/archive/**
**Outcome:** Success — helm lint passes, all 2411 tests pass, template rendering correct with all conditional flags working
**Notes:** NATS and PostgreSQL are subchart dependencies. ConfigMap approach reuses existing loadConfig() code path. Security contexts stay hardcoded in k8s-client.ts.
