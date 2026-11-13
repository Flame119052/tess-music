# Issue Triage, Labels & Milestones

How GitHub issues are sorted by **priority**, **importance (milestone)**, **category (area)**, and **tags (type & status)**.

## 1. Priority (`P0`–`P3`, one per issue)

| Label | Meaning | Response bar |
| --- | --- | --- |
| `P0: critical` | Security vulnerability, broken Spotify / data loss, key safety, release-blocking safety | Fix before anything else |
| `P1: high` | High-impact bug, core UX/performance direction, essential trust or release-flow change | Current phase top of queue |
| `P2: medium` | Polish, secondary features, testing matrix gaps, non-urgent bugs | Normal phase order |
| `P3: low` | Paused, deferred, or future-platform work | Held until unpaused |

## 2. Category (`area:*`, one or more per issue)

| Label | Covers | Paths |
| --- | --- | --- |
| `area: theme` | Look, player, lyrics, Dial, library, Home, artist/album/playlist pages | `theme/` |
| `area: patcher` | Spicetify fork, CSS map, safe swap, upstream watchdog | `patcher/` |
| `area: installer` | Installer, updater, doctor, rescue, macOS permissions, DMG detection | `installer/` |
| `area: mini` | Tess Mini native macOS Swift miniplayer | `mini/` |
| `area: companion` | Phone PWA companion | `companion/` |
| `area: release-ci` | Release pipeline, channels, signing, CI workflows, watchdogs | `tools/`, `.github/` |
| `area: docs` | Documentation, roadmap, governance, privacy | `docs/`, `AGENTS.md`, `DESIGN.md` |

## 3. Kind / Type

`bug` · `enhancement` · `design` · `security` · `testing` · `documentation` · `spec` (root v1 umbrella)

## 4. Workflow Status

- `waiting on Krish` — needs owner decision, design review, or owner-only action
- `status: verify` — implemented; waiting on real-world/hardware verification before closing
- `status: paused` — explicitly paused or deferred by Krish

## 5. Plain-English Issue Titles

Write every issue title in clear, everyday language that anyone can understand at a glance (no cryptic internal IDs or jargon). Put file paths and technical details inside the issue body.

## 6. Importance & Release Phases (Milestones)

Issues are assigned to one of the five roadmap milestones (`docs/roadmap.md`):

1. **Phase 1: Trust, Security & Release Flow** — security audit (`#56`), key backup (`#55`), rescue consent (`#53`), privacy clean-up (`#54`), App Management verification (`#28`), PR/dev/beta/stable docs (`#62`), v1 sign-off (`#7`, `#9`).
2. **Phase 2: Core Fixes, Quality & Reach** — foreground motion & visibility (`#57`), quality-first perf (`#58`), artist Photo/Video fix (`#60`), vinyl tonearm rework (`#63`), no-lyrics full-screen fix (`#65`), Library Blends vs Playlists (`#61`), Spicetify fork cleanup & watchdog (`#59`), DMG check (`#51`), Mac testing matrix (`#49`, `#50`), Glass Shelves & page reviews (`#45`, `#4`).
3. **Phase 3: Apple-Level Polish** — Liquid Glass polish (`#47`), library transition (`#46`), full icon coverage (`#48`), customization & design preferences (`#64`).
4. **Phase 4: Features & Enhancements** — fallback lyrics (`#3`), artist video fallback (`#5`), external drive downloads (`#6`), word-by-word lyrics (`#2` paused).
5. **Phase 5: Beyond the Mac** — phone companion PWA (`#8`), Windows port (`#34` paused).
