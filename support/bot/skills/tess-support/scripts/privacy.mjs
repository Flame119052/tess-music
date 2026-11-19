// The Mac plugin runs this file as a program to scrub tool output. A Worker import
// does not take that branch: argv[1] is not this file.
import { pathToFileURL } from 'node:url';

// The privacy rules for everything a support report carries, in one place.
//
// This list used to exist twice: in the bot's triage step, which prepares the text, and in the inbox, which is the last
// gate before it is stored. The two drifted, and a rule that exists on one side is a rule a stranger walks around on the
// other. So the rules are here and both import them; a new one can only be written once.
//
// Nothing here imports anything: the Worker bundles this with its own code, and the bot runs it on a server with no
// build step. It is deliberately lossy — a home folder becomes `~`, an email `(email)`, a token `(token)` — because the
// issue it ends up in is public.

// Characters no terminal draws but every reader obeys: all of Cf (format), which is the bidi overrides and marks, the
// zero-width joiners and spaces, the soft hyphen, the byte-order mark and the deprecated bidi controls; the C0/C1
// controls a terminal eats; and the invisible marks that are not Cf — the combining grapheme joiner, the variation
// selectors, the Hangul and Khmer fillers, and the tag characters. A right-to-left override reorders a line so an
// honest path reads as a different one, and a token split by one of these is two harmless halves to a pattern. They go
// before any pattern runs: a pattern that runs first has already missed the secret they were hiding.
const INVISIBLE = /[\p{Cf}\u0000-\u0008\u000b-\u001f\u007f-\u009f\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180d\u3164\ufe00-\ufe0f\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

export const stripInvisible = (text) => String(text ?? '').replace(INVISIBLE, '');

// A secret is a secret whatever service it belongs to, and the issue is public. These are the shapes a person pastes by
// accident: the two this project holds (Telegram's `<digits>:<secret>` and the inbox's `tess_<hex>`), the key shapes of
// GitHub, AWS, Slack and the common `sk-`/`pk-` APIs, a JSON Web Token, and a private-key block, which is a secret for
// its whole length rather than for one line of it.
//
// No `g` flag: the inbox asks these the same way with `.test()`, and a global regex remembers where it stopped, so the
// second ask would answer about the wrong text.
export const SECRET_SHAPES = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/,
  /\btess_[0-9a-f]{16,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
];

// What identifies a person, in the order it has to be removed. A path before an email, because a path can hold an `@`,
// and a token before the phone rule, because the phone rule would otherwise leave half of one behind.
const PERSONAL = [
  [/\b[0-9a-f]{32}\b/gi, '(install id withheld)'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '(email)'],
  // A home folder is a person: the folder is their account and a file under it says what they do. The doctor prints it
  // as `~`, an absolute path names it, and `~bob` names the account. None of them is safe because it is quoted, follows
  // an `=`, or starts with a capital letter — so the rule must not care what stands in front of it.
  // A `file:///Users/...` link is the same folder behind extra slashes, so any run of slashes in front counts too.
  [/(^|[^\w/])\/*(?:\/(?:Users|users|home|Volumes|root|private\/var\/folders|var\/folders))\b[^\s"'`)]*/g, '$1~'],
  [/(^|[^\w~])~(?:[A-Za-z0-9._-]+)?\/[^\s"'`)]+/g, '$1~'],
  [/(^|[^\w~/])~[A-Za-z0-9._-]*[A-Za-z][A-Za-z0-9._-]*/g, '$1~'],
  [/\b[A-Za-z0-9][A-Za-z0-9._-]*\.local\b/g, '(computer)'],
  // A phone number is the person, whoever is holding the phone. Timestamps and four-part versions are held aside by
  // clean() so this rule cannot eat them.
  [/(^|[\s([])\+?\d[\d ().-]{7,}\d(?=$|[\s.,;:)\]\n])/g, '$1(number)'],
  [/@[A-Za-z0-9_]{3,}/g, '(handle)'],
];

// Cleaned text. The placeholders use NUL, which stripInvisible has already removed from the input, so nothing the person
// typed can be mistaken for one.
export const clean = (text) => {
  if (text == null || text === '') return '';
  const keep = [];
  let out = stripInvisible(text)
    // A timestamp or a version ("0.2.32", "1.2.52.442") is not a phone number, and both are kept byte for byte. A
    // dotted 3-3-4 run ("415.555.0134") is the one version-shaped thing that is a phone number, so it is not held aside.
    .replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\b(?!(?:\d{1,3}\.)?\d{3}\.\d{3}\.\d{4}\b)\d+(?:\.\d+){2,}\b/g, (m) => `\u0000${keep.push(m) - 1}\u0000`);
  for (const re of SECRET_SHAPES) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '(token)');
  for (const [re, to] of PERSONAL) out = out.replace(re, to);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    process.stdout.write(clean(Buffer.concat(chunks).toString('utf8')));
  });
}
