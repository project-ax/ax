# Container Design Simplification

## [2026-03-15 13:25] — Simplify container resource tiers

**Task:** Simplify container design — right-size light tier to 250m vCPU / 500Mi, make workspace volume size configurable per tier instead of hardcoded.
**What I did:**
- Added `workspaceSize` to `PodTemplate` interface in `k8s-client.ts`
- Replaced hardcoded `tier === 'heavy' ? '50Gi' : '10Gi'` with `template.workspaceSize ?? '10Gi'`
- Updated light tier defaults: cpu `1` → `250m`, memory `2Gi` → `500Mi`
- Updated heavy tier defaults: cpu `4` → `1`, memory `16Gi` → `2Gi`
- Added `workspaceSize` to both tier templates (light: 10Gi, heavy: 50Gi)
- Updated controller and main tests to match new defaults
**Files touched:** src/pool-controller/k8s-client.ts, src/pool-controller/main.ts, tests/pool-controller/controller.test.ts, tests/pool-controller/main.test.ts
**Outcome:** Success — all 12 pool-controller tests pass, tsc clean
**Notes:** The two tiers share the same container type (image + command). The simplification removes tier-specific logic from the k8s client and right-sizes resources for cost efficiency.
