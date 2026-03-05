### Helm subchart dependencies should be gitignored
**Date:** 2026-03-05
**Context:** Creating Helm chart with NATS and PostgreSQL subcharts
**Lesson:** Add `charts/*/charts/` and `charts/*/Chart.lock` to .gitignore. These are downloaded by `helm dependency update` and should not be committed. The Chart.yaml specifies the version ranges.
**Tags:** helm, gitignore, subcharts

### ConfigMap-mounted config reuses loadConfig() via AX_CONFIG_PATH
**Date:** 2026-03-05
**Context:** Replacing scattered env vars with a single ax.yaml ConfigMap
**Lesson:** Adding `AX_CONFIG_PATH` env var to `configPath()` in paths.ts is all that's needed to support ConfigMap-mounted config in k8s. The existing loadConfig() reads from configPath() and handles all parsing/validation. No changes needed to config.ts itself.
**Tags:** config, helm, k8s, configmap

### Security contexts must stay hardcoded in k8s-client.ts
**Date:** 2026-03-05
**Context:** Making sandbox tier configs Helm-configurable via SANDBOX_TEMPLATE_DIR
**Lesson:** The sandbox templates (light.json, heavy.json) mounted via ConfigMap should ONLY control resources (CPU, memory), image, command, and NATS config. Security context (gVisor runtime, readOnlyRootFilesystem, drop ALL capabilities, runAsNonRoot) must remain hardcoded in `k8s-client.ts:createPod()` — never make security hardening configurable.
**Tags:** security, helm, sandbox, k8s
