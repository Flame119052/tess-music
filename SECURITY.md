# Security

Tess runs code inside people's Spotify and updates itself, so security problems matter.

**Report privately:** open a [private security advisory](https://github.com/Flame119052/tess-music/security/advisories/new)
(GitHub → Security → Report a vulnerability). Please don't file a public issue for anything that could let someone
run code on other people's Macs.

How Tess protects users (details in [`docs/architecture.md`](docs/architecture.md) and [`docs/secrets-and-env.md`](docs/secrets-and-env.md)):
- Every update is signed (Ed25519) and checked on the Mac before anything is installed; binaries carry a stable code
  signature.
- Emergency "rescue" orders need a separate key kept offline (never in GitHub/CI), can't be replayed, and expire.
  The maintainer can remotely run one of five Tess actions on your Mac without asking: check, update, repair,
  restore Spotify's interface, or uninstall Tess. Orders cannot carry scripts or reach outside Tess and Spotify.
  Exception: rescue lines installed before 13 Nov 2026 use an older format whose signed orders can run any script
  as you, and updates never replace them. `tess repair` tells you if your Mac has one. Only the offline rescue
  key holder can send an order. Use `tess rescue log` to see what ran, `tess status` to check the line, and
  `tess rescue off` to turn it off.
- Builds reach users only after being tried on the internal channel and promoted. A channel with no signed installer
  refuses to install; the public line never runs an installer from `main`.
- Health reports are anonymous (no names, paths, computer names or emails) and can be turned off with
  `tess reports off`; nothing can read them back over the web.

## Limits

- **The channel itself is not signed.** The release key signs the theme and the parts list, and `rev` stops a Mac going
  backwards, but nothing ties those files to `stable` or `dev`. A mirror or CDN that can answer for `stable` with a
  correctly signed `dev` build can make stable Macs run unpromoted code, and can raise their floor. Today the control
  for that is HTTPS to GitHub plus the repository account; a promotion key that signs the channel name is future work.
- **The `rev` floor lives in Spotify's localStorage**, next to the cached theme. Code that can already write that storage
  can lower or delete the floor. The signed copies still have to verify, so this re-opens replay of an older signed
  release, not arbitrary code. Hardening this needs storage the page cannot rewrite; it is tracked separately.
