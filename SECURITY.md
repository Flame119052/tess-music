# Security

Tess runs code inside people's Spotify and updates itself, so security problems matter.

**Report privately:** open a [private security advisory](https://github.com/Flame119052/tess-music/security/advisories/new)
(GitHub → Security → Report a vulnerability). Please don't file a public issue for anything that could let someone
run code on other people's Macs.

How Tess protects users (details in [`docs/architecture.md`](docs/architecture.md) and [`docs/secrets-and-env.md`](docs/secrets-and-env.md)):
- Every update is signed (Ed25519) and checked on the Mac before anything is installed; binaries carry a stable code
  signature.
- Emergency "rescue" orders need a separate key kept offline (never in GitHub/CI), can't be replayed, and expire.
- Builds reach users only after being tried on the internal channel and promoted.
- Health reports are anonymous (no names, paths, computer names or emails) and can be turned off with
  `tess reports off`; nothing can read them back over the web.
