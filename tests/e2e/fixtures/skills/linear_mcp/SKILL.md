---
name: linear_mcp
description: Linear via mock MCP (e2e test fixture — do not use in production)
mcpServers:
  - name: linear
    url: https://mock-target.test/mcp/linear
    transport: http
---

# Linear (mock MCP)

This is a test-fixture skill used by the Task 4.4 e2e test. It declares a
mock MCP server at `https://mock-target.test/mcp/linear`; `config.url_rewrites`
in `kind-values.yaml` redirects that hostname to the e2e mock server where
a small JSON-RPC 2.0 handler speaks MCP.

Tools advertised by the mock: `get_team`, `list_cycles`, `list_issues`.

The Task 4.4 test chains all three through the unified `call_tool` indirect
dispatch pipeline to prove the catalog is populated correctly, MCP calls
actually land on the server, and zero retries are needed.
