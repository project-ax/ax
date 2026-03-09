## [2026-03-08 23:10] — Add WASM tier support to `ax k8s init`

**Task:** Modify the k8s init wizard and values generation to support the new WASM sandbox tier.
**What I did:**
- Added `wasm` field to `InitOptions` and `--wasm` CLI flag (accepts `enabled`, `shadow`, `disabled`)
- Added `defaultWasmMode()` function with preset-aware defaults: small=enabled, medium=shadow, large=enabled
- Added WASM wizard step (step 6) with three choices: enabled, shadow, disabled
- Updated `generateValuesYaml()` to emit `config.wasm.enabled` and `config.wasm.shadow_mode` inside the config block
- Added `config.wasm` defaults to `charts/ax/values.yaml` (enabled: false, shadow_mode: true)
- Added comprehensive tests: parseArgs --wasm, defaultWasmMode per preset, values generation for all three modes, YAML structure verification
**Files touched:** `src/cli/k8s-init.ts`, `tests/cli/k8s-init.test.ts`, `charts/ax/values.yaml`
**Outcome:** Success — all 2681 tests passing (210 test files).
**Notes:** WASM config is omitted from generated values when mode is `disabled` (chart defaults handle it). When mode is `enabled` or `shadow`, explicit config is written inside the `config:` block to override chart defaults.

## [2026-03-06 15:10] — FIX-2: Consolidate embeddings API key into single k8s secret

**Task:** Fix cortex acceptance test FIX-2 — DeepInfra embedding API key missing from k8s secrets
**What I did:** Consolidated embeddings credentials into the single `ax-api-credentials` secret. Previously k8s init created a separate `ax-embeddings-credentials` secret and used `agentRuntime.env`, which didn't match the Helm chart's `apiCredentials.envVars` pattern used by kind-values.yaml.
- Added `EMBEDDINGS_ENV_VARS` constant mapping providers to env var names
- Updated `generateValuesYaml()` to add embeddings to `apiCredentials.envVars`
- Updated `runK8sInit()` to merge embeddings key into `ax-api-credentials` secret
- Added test verifying single-secret pattern
- Updated FIX-2 status to FIXED in fixes.md
**Files touched:** `src/cli/k8s-init.ts`, `tests/cli/k8s-init.test.ts`, `tests/acceptance/cortex/fixes.md`
**Outcome:** Success — all 2358 tests passing.
**Notes:** When LLM and embeddings use the same provider (e.g., both openai), the same secret key is reused — no duplicate literal needed.

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
