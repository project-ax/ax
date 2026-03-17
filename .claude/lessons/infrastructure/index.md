# Infrastructure Lessons

## Key Takeaways

- Queue-group delivery only works when the host claims work before it has a podName
- Helm subchart tarballs and Chart.lock should be gitignored
- ConfigMap-mounted ax.yaml reuses loadConfig() — no code changes needed beyond AX_CONFIG_PATH
- Security contexts (gVisor, capabilities) must stay hardcoded — not in Helm-configurable templates

## Entries

- Queue-group work delivery only happens when the host does not preselect a pod [entries.md](entries.md)
- Per-turn capability tokens + bound context solve sandbox session isolation [entries.md](entries.md)
- JetStream streams conflict with core NATS request/reply on same subjects [entries.md](entries.md)
