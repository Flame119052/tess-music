<!-- Work normally lands on main; open a PR only when Krish asks for one. -->
## What changes for the user

## Issue
Closes #

## Proof
<!-- Screenshots, before/after numbers (tools/bench.mjs, tools/cpu-ab.mjs), test output, or a sandbox installer run. -->

## Checklist
- [ ] `tools/check-safety.sh` passes
- [ ] Theme builds: `node tools/build.mjs && node --check theme/Tess/theme.js`
- [ ] Installer/updater changes were run against a sandbox copy of Spotify (never the real one)
- [ ] Follows DESIGN.md (motion, performance rules, no broad `:has()`)
- [ ] docs/status.md updated if something user-visible changed state
