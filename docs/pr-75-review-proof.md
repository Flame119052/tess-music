# PR #75 sandbox verification

14 November 2026. These checks use temporary folders and fake network and launchctl commands. They do not prove
real login behavior, deployment, promotion, or behavior on a user's Mac.

- `node tools/test-rescue-control.mjs`: rescue off writes the marker, calls disable and bootout, removes the login
  plist, and stays stopped during a simulated login. An updater run removes a recreated stale plist and preserves
  opt-out. Turning it on requires adoption to return success and creates the plist directly, even with the updater locked.
  The message warns that an unexpired order sent while off may run, because older installed rescue scripts can
  silently skip adoption. Adoption failure leaves the marker, disables and unloads the job. The independent
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

Round 2 adds actual `tess repair` followed by `tess uninstall` to both legacy installer fixtures. The first run
failed with `installer.sh: No such file or directory`. After the fix both commands finish, and uninstall removes
sandbox TESS_HOME and config. The unsigned local fallback scripts get no false signed-part state. The embedded
command and uninstaller must match their source files byte for byte. Reinstall and uninstall call launchctl enable
to clear a previous disable; the test records those calls through fake launchctl.

New rescue copies fail adoption for unavailable or unverified orders, and can adopt with the off marker still
present without executing an action. Existing rescue scripts remain unchanged. Their old success status cannot
prove adoption, so the command makes no promise about skipping orders sent while off.

Theme updates run the real patcher refresh against a complete staged Apps folder with an isolated config. This
preserves color.ini processing (colors.css and spicetify-config.json) before the checked swap. A sandbox integration
test builds the real Go patcher, updates a theme color, and checks generated colors, JSON, script and unchanged
live config. The guard log now says that a loaded agent takes the new interval at next login.

The single theme.last-good copy remains deliberately available for rollback. It is replaced at the next theme
update; it is not an accumulating history. Existing Macs see the rescue notice on install/repair and can read
`tess rescue` and `tess status`; this fix does not add an unsolicited notice. PR #75 already links #71 and #56
in its body; those inherited changes remain in this PR.
