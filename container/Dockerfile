# AX agent container image
#
# Used for both local Docker sandbox (--network=none, volume mounts)
# and k8s sandbox pods (gVisor, NATS communication).
#
# Entry points:
#   - Agent runner (default): tsx src/container/agent-runner.ts
#   - Sandbox worker (k8s):   node dist/sandbox-worker/main.js
#   - Pool controller (k8s):  node dist/pool-controller/main.js

FROM node:22-slim

# Install git (needed for workspace provisioning in k8s mode)
# and tsx for running TypeScript directly
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g tsx

# Create non-root user for the agent
RUN groupadd -r agent && useradd -r -g agent -m agent

# Create workspace directory for sandbox pods
RUN mkdir -p /workspace && chown agent:agent /workspace

# Copy project files (node_modules + compiled source)
WORKDIR /opt/ax
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY src/ ./src/

# Run as non-root
USER agent

# Default entrypoint — host overrides command via docker run or k8s pod spec
ENTRYPOINT ["tsx"]
CMD ["src/container/agent-runner.ts"]
