# Infrastructure Lessons

## Key Takeaways

- Helm subchart tarballs and Chart.lock should be gitignored
- ConfigMap-mounted ax.yaml reuses loadConfig() — no code changes needed beyond AX_CONFIG_PATH
- Security contexts (gVisor, capabilities) must stay hardcoded — not in Helm-configurable templates
