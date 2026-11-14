<!-- One problem per PR. Title: what changes for the user, ending with the issue, e.g. "Rescue line: off switch (#53)". See docs/workflow.md. -->
## What changes for the user

## Issue and approach
Closes #
<!-- Link the approach comment if this tier needs one (sensitive work does). -->

## Proof
<!-- Screenshots, before/after numbers (tools/bench.mjs, tools/cpu-ab.mjs), test output, or a sandbox installer run.
     "Tests pass" alone is not proof: say what you ran and what you saw, and anything you couldn't check. -->

## Checklist
- [ ] `tools/check-safety.sh` passes
- [ ] Theme builds: `node tools/build.mjs && node --check theme/Tess/theme.js`
- [ ] Installer/updater changes were run against a sandbox copy of Spotify (never the real one)
- [ ] Follows DESIGN.md (motion, performance rules, no broad `:has()`)
- [ ] docs/status.md updated if something user-visible changed state

## Made by
<!-- Who wrote this: a person, or the agent's model and harness, e.g. "DeepSeek V4.1 Flash in OpenCode". The reviewer must come from a different provider. -->
