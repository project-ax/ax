## [2026-03-06 14:44] — Helm presets + `ax k8s init` CLI wizard

**Task:** Implement docs/plans/2026-03-06-k8s-presets-and-init-design.md — Helm presets for small/medium/large deployment sizes and an interactive CLI wizard for generating values files + K8s secrets.

**What I did:**
- Created `charts/ax/templates/_presets.tpl` with preset-aware helpers for replicas, resources, runtimeClass, and sandbox tiers. Used `kindIs "invalid"` to detect null values (user override > preset > chart default).
- Updated `charts/ax/values.yaml`: added `preset: ""` at top, `global.imagePullSecrets`, and null-defaulted all preset-controlled fields with comments.
- Updated host + agent-runtime deployment templates to use preset helpers for replicas, resources, runtimeClass, and added imagePullSecrets support.
- Updated sandbox templates configmap to use `ax.preset.sandboxTiers` helper with `fromYaml`.
- Created `src/cli/k8s-init.ts` — interactive wizard using Node readline, `execFileSync` for kubectl (no shell injection), generates values YAML and creates namespace/secrets.
- Registered `ax k8s init` subcommand in `src/cli/index.ts`.
- Added tests in `tests/cli/k8s-init.test.ts`.

**Files touched:**
- Created: `charts/ax/templates/_presets.tpl`, `src/cli/k8s-init.ts`, `tests/cli/k8s-init.test.ts`
- Modified: `charts/ax/values.yaml`, `charts/ax/templates/host/deployment.yaml`, `charts/ax/templates/agent-runtime/deployment.yaml`, `charts/ax/templates/pool-controller/configmap-sandbox-templates.yaml`, `src/cli/index.ts`

**Outcome:** Success — tsc clean, 204 test files / 2357 tests passing.

**Notes:** NATS and PostgreSQL subchart conditions (`nats.enabled`, `postgresql.internal.enabled`) can't be overridden by template presets since Helm evaluates subchart conditions before template rendering. The `ax k8s init` CLI generates the right NATS/PostgreSQL values in the output file to handle this.
