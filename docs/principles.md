# Principles

The ideas behind Tess, so every decision can be checked against them. When two pull in different directions, the
earlier one in this list wins.

1. **Never break someone's Spotify.** People install Tess on the app they listen to every day. A failure at any step
   must leave Spotify exactly as it was. This is why the folder is only ever swapped, never deleted and refilled; why
   installers are tested on copies; why a release gate blocks anything that breaks it.
2. **Earn trust, don't assume it.** Tess runs code on other people's Macs. Every update is signed and checked; nothing
   reaches users untested (dev → promote); remote fix-ups need an offline key; users are told what runs and can turn
   things off. Security problems are reported privately and fixed first.
3. **Privacy by default.** Tess collects only what's needed to keep itself working, strips anything personal, and
   never reads what you listen to, your account, your screen or your files. No names of real people in anything
   public.
4. **Zero commands after install.** One line installs it; everything after that (updates, repairs after Spotify
   updates, fixes) happens by itself. Asking a user to run a command again is a bug.
5. **Spotify keeps working.** Tess restyles; it never removes what Spotify does. Every Spotify feature stays reachable.
6. **The music is the hero, and Apple Music is the bar.** Calm glass, the artwork's colours, motion that answers you.
   See DESIGN.md.
7. **Fast is part of the design.** Performance and looks improve together, measured on the real app with the window
   visible. Nothing moves for ever; hidden things cost nothing.
8. **Proof, not claims.** A change is done when it was run for real and there's something to look at: a screenshot, a
   number, a test, a log. Numbers are read carefully (macOS CPU averages, hidden windows, noise).
9. **Everything written down.** Every ask is an issue; every decision is in `decisions.md`; the state is in
   `status.md`; any thread can start cold.
10. **Free where possible, honest about cost.** Free tiers with hard caps; no paid dependency without the owner's OK.
    When something isn't possible (a 200 MB Spotify), say so plainly and offer the closest real target.
