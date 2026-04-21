# AX unified agent container — host, agent-runtime, and pool-controller
#
# Single container image replaces the previous 3-image architecture.
# Agents execute tools locally inside the container with a host-side
# audit gate for pre-execution approval.
#
# Entry points:
#   - Host:            node dist/host/server-k8s.js
#   - Agent runtime:   node dist/host/agent-runtime-process.js
#   - Pool controller: node dist/pool-controller/main.js

FROM node:22-slim

# Standard bash tools for agent sandbox (matches Claude Code expectations)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git git-lfs curl jq ca-certificates \
    ripgrep \
    tree \
    less \
    wget \
    zip unzip \
    make \
    patch \
    file \
    procps \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system

WORKDIR /opt/ax
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY templates/ ./templates/
COPY skills/ ./skills/

# e2e test fixtures — test-only skills used by the regression harness.
# Production ignores this path unless AX_SKILLS_DIR points here (which it
# only does in `tests/e2e/kind-values.yaml`). A few KB; not gated.
COPY tests/e2e/fixtures/ ./fixtures/

RUN groupadd -r ax && useradd -r -g ax -m ax
USER ax

ENTRYPOINT ["node"]
CMD ["dist/host/server-k8s.js"]
