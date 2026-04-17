import { writeFileSync, chmodSync } from 'node:fs';
import { safePath } from '../../utils/safe-path.js';

/**
 * AX skills reconciliation post-receive hook template.
 *
 * Inlined (rather than loaded from a co-located .sh file) because `tsc`
 * does not copy non-TS assets into `dist/`, and adding a postbuild copy
 * step buys us little for a ~30-line script. If you want to edit this,
 * edit it here — there is no other canonical source to keep in sync.
 *
 * Notes on the shell script itself:
 *   - `set -eu` catches undefined vars but NOT pipeline failures (that's
 *     `-o pipefail`, not POSIX). OK for best-effort.
 *   - `__AGENT_ID__` is the substitution placeholder — installPostReceiveHook
 *     replaces it per repo.
 *   - If `AX_HOOK_SECRET` is unset in the hook's env, it exits cleanly — push
 *     still succeeds. This is deliberate for dev environments.
 *   - `|| true` on curl ensures a network error does not block the push.
 *   - `xxd -p -c 256` converts binary HMAC to hex; widely available on
 *     Linux/macOS. Alpine containers may need `busybox-extras` installed or
 *     the line rewritten to use `od -An -tx1 | tr -d ' \n'`.
 */
const TEMPLATE = `#!/bin/sh
# AX skills reconciliation hook — installed by the host.
# Reads refs from stdin (per git hook spec) and POSTs to the host.
set -eu

AGENT_ID="__AGENT_ID__"

HOST_URL="\${AX_HOST_URL:-http://localhost:8080}"

# Secret must be provided at runtime; if missing, the hook is a no-op so pushes don't fail.
if [ -z "\${AX_HOOK_SECRET:-}" ]; then
  exit 0
fi

while read -r oldSha newSha ref; do
  # Only reconcile refs/heads/main — cheap filter to avoid churn on tags/PR refs.
  case "\$ref" in
    refs/heads/main) ;;
    *) continue ;;
  esac

  body=\$(printf '{"agentId":"%s","ref":"%s","oldSha":"%s","newSha":"%s"}' \\
    "\$AGENT_ID" "\$ref" "\$oldSha" "\$newSha")

  # Compute HMAC-SHA256 hex using openssl.
  sig="sha256=\$(printf '%s' "\$body" | openssl dgst -sha256 -hmac "\$AX_HOOK_SECRET" -binary | xxd -p -c 256)"

  # Best-effort. Failure of the hook MUST NOT block the push.
  curl -fsS -m 10 \\
    -H "Content-Type: application/json" \\
    -H "X-AX-Hook-Signature: \$sig" \\
    -d "\$body" \\
    "\$HOST_URL/v1/internal/skills/reconcile" >/dev/null 2>&1 || true
done
`;

/**
 * Install the AX post-receive hook into a bare git repository.
 *
 * Idempotent: overwrites any existing hook at the same path with the
 * current template and the given agent ID.
 *
 * The hook itself is best-effort at runtime — missing secret or network
 * failures never block the push (see the TEMPLATE above).
 */
export function installPostReceiveHook(bareRepoPath: string, agentId: string): void {
  const hookPath = safePath(bareRepoPath, 'hooks', 'post-receive');
  const content = TEMPLATE.replaceAll('__AGENT_ID__', agentId);
  writeFileSync(hookPath, content, { mode: 0o755 });
  // Explicit chmod: writeFileSync's `mode` is honored on create but is a
  // no-op when the file already exists on some filesystems. chmod guarantees
  // the executable bit on every call (idempotent overwrite).
  chmodSync(hookPath, 0o755);
}
