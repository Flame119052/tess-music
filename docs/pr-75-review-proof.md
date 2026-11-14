# PR #75 sandbox verification

14 November 2026. These checks use temporary folders and fake network and launchctl commands. They do not prove
real login behavior, deployment, promotion, or behavior on a user's Mac.

- `node tools/test-rescue-control.mjs`: rescue off writes the marker, calls disable and bootout, removes the login
  plist, and stays stopped during a simulated login. An updater run removes a recreated stale plist and preserves
  opt-out. Turning it on enables the job and explains that orders sent while off are skipped. The independent
  verifier remains unchanged when the packaged verifier differs.
- `node tools/test-installer-legacy.mjs`: the real installer runs with `TESS_TEST=1`, isolated `TESS_HOME`,
  `TESS_CONFIG`, and `TESS_SPOTIFY`, and a copied fake Spotify.app. The fixture list contains only patcher, theme,
  and updater. Installation finishes, displays the remote-action notice, and leaves no installed state for absent
  installer, uninstall, wake, or command parts. The fallback command matches `installer/tess-command.sh`.
- `node tools/test-installer-legacy.mjs --command`: the installer installs the signed command part when present.
- `node tools/test-updater.mjs`: an existing Mac receives the signed command; existing health failures do not ban
  an unrelated part; a new validation failure restores the previous part and suppresses retry of its hash.
- `node tools/test-wake.mjs`: an unaccepted rescue serial triggers once; a newer serial triggers again.
- `node tools/test-rescue.mjs`: generates an ephemeral Ed25519 key and builds the real Go verifier with its public
  key. All five actions pass; scripts, unknown actions, injected text, bad signatures, expired orders, replays, and
  orders for other Macs are refused or skipped. Production keys and installed Tess are never needed.

The safety gate and updater, wake, rescue-control, swap-recovery, rescue, agent-review, dial-pick and legacy-install
checks passed under empty HOME directories. Agent review has 9 passing tests; Dial picking has 16. Swap recovery
kills each of the three scripts between renames and verifies recovery on the next run.

The updater uses the reviewer's conservative validation rule: automatic rollback applies when the doctor was
healthy before the parts loop. If that baseline already fails, unrelated parts are not permanently banned. This
does not distinguish individual health problems or prove a part is healthy when the baseline already fails.
