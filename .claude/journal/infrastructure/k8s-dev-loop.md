## [2026-03-17 21:05] — K8s Dev Loop Implementation

**Task:** Implement fast edit→build→test loop for debugging AX in a local kind cluster
**What I did:** Extended PodTemplate with extraVolumes/extraVolumeMounts, updated Helm chart (pool-controller deployment + sandbox template ConfigMap), created kind-dev-values.yaml overlay, created k8s-dev.sh script with setup/build/flush/cycle/test/logs/status/debug/db/teardown commands, updated ax-debug skill
**Files touched:**
- Modified: `src/pool-controller/k8s-client.ts` (PodTemplate interface + createPod)
- Modified: `tests/pool-controller/k8s-client.test.ts` (2 new tests)
- Modified: `charts/ax/templates/pool-controller/deployment.yaml` (extraVolumes)
- Modified: `charts/ax/values.yaml` (poolController.extraVolumes/extraVolumeMounts)
- Modified: `charts/ax/templates/pool-controller/configmap-sandbox-templates.yaml` (passthrough)
- Created: `charts/ax/kind-dev-values.yaml` (dev overlay)
- Created: `scripts/k8s-dev.sh` (dev loop script)
- Modified: `package.json` (k8s:dev script)
- Modified: `.claude/skills/ax-debug/SKILL.md` (kind dev loop section)
**Outcome:** Success — all 2411 tests pass, tsc clean, Helm renders correctly
**Notes:** Initial `Record<string, unknown>` type for extraVolumes was too loose — tsc caught incompatibility with V1Volume/V1VolumeMount. Fixed to require `name` (and `mountPath` for mounts).
