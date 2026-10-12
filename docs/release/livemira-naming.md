# LiveMira naming

| Item | Name |
| --- | --- |
| Engine brand | LiveMira |
| Root npm name | `livemira` |
| Workspace modules | `@livemira/contracts`, `@livemira/sdk` and the other `@livemira/*` packages |
| Integration SDK package | `@livemira/engine` (version: root `package.json`) |
| Stable import paths | `@livemira/engine`, `/browser`, `/single`, `/single/min` and the tool names; SDK-only multi-file modules use `/development/...` |
| Single-file core | `lm-engine.mjs` / `lm-engine.min.mjs` |
| Optional modules | `lm-target-quality`, `lm-tracking-visuals`, `lm-recognition-diagnostics` |
| Release directories and records | `livemira-*` / `lm-*` |

"WebAR" describes the technology category, not a former brand. Algorithm IDs, the target bundle format and the persisted or logged compatibility keys keep their names so existing data stays readable.

Compatibility keys that keep their historical names: `webar-local-evidence` (the IndexedDB archive database); `webar-recognition-diagnostics/1`, `webar-demo-diagnostics-archive/1` and `webar-phone-paired-performance{,-archive}/1` (log formats); `webar-target-quality/1`, `webar-target-quality/2` and `webar-target-suitability` (scoring data and formula identities). New package names, file names, build audits and interface identifiers use LiveMira / `lm-`.
