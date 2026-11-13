# Spicetify 2.46.4 — prebuilt files (vendored)

`tools/release.mjs` used to download these from Spicetify's GitHub release at build time with no checksum, then sign
the result as Tess. That made a compromised Spicetify release into code on every Tess Mac. These are the same bytes,
reviewed and committed once:

- Source: `https://github.com/spicetify/cli/releases/download/v2.46.4/spicetify-2.46.4-darwin-arm64.tar.gz`
- SHA-256 of that archive: `d217bcf3b780136d66dee9b3548b3689f6004263a958c57d96ad73d7f6fcdd5b`
- Files: `jsHelper/` (`spicetifyWrapper.js`, `spicetifyWrapper.js.map`, `expFeatures.js`, `homeConfig.js`,
  `sidebarConfig.js`) and `css-map.json`
- Licence: GNU Lesser General Public License v2.1, like the rest of the Spicetify fork. See `../../LICENSE` and
  `../../NOTICE.md`; all credit belongs to the Spicetify project and its contributors.

Tess does not modify these files. To move to a new Spicetify version, add a new `spicetify-<version>/` directory with
the extracted files, record the archive's SHA-256 here, and point `tools/release.mjs` at it in a reviewed change.
