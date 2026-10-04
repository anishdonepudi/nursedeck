# NurseDeck

Local-first, evidence-cited study tool for nursing students. Upload lecture
slides; NurseDeck uses the Claude Code CLI to turn them into flashcards, Q&A,
NCLEX-style questions and practice exams — **with a citation on every claim.**

## What it does

1. **Import** a lecture PowerPoint. Slide order, speaker notes, tables and
   images are extracted.
2. **Generate** flashcards, fill-in-the-blank cards, short-answer questions and
   NCLEX-style vignettes from it.
3. **Review** every generated card before it enters your deck, with the quote
   it is based on shown alongside.
4. **Study** with FSRS-6 spaced repetition, typing answers rather than flipping
   cards, and rating your confidence before each answer is revealed.

### How it avoids making things up

Every claim must quote the slide it came from, and that quote is checked in
four stages, cheapest first:

| Stage | Check | Cost |
|---|---|---|
| Licence | May this source be used this way at all? | free |
| Verbatim | Does the quote actually appear in the source, in order? | free |
| Numeric | Does every dose, range and threshold asserted appear in the quote? | free |
| Entailment | Does the quote actually *support* the claim? | one model call |

The entailment audit runs in a separate, isolated session that sees only the
claim and the quote -- never the lecture, never the original prompt -- so it
cannot rubber-stamp its own earlier output.

A card is only ever studiable when you have accepted it **and** its citation is
verified. That rule is enforced in SQL, not left to the UI.

### Cross-checking against an outside authority

Verifying against your lecture proves the slide says it. That is a different
question from whether it is *true*, and slides do carry stale values.

So a card can also be cross-checked against free, authoritative sources --
openFDA (public domain), DailyMed and RxNorm -- which answer with one of:

- **Confirmed** - an independent source states the same thing, and that source
  is attached as a second citation.
- **Disagrees** - the official labelling says something incompatible. This is
  the valuable result: it is surfaced rather than resolved, because we cannot
  know whether the slide is outdated or the match is simply off.
- **No official source covers this** - common and fine; plenty of nursing
  practice is not drug labelling.

Every outbound host is on an explicit allow-list with its published rate limit.
Sources that forbid automated access are on a deny-list with the reason, so
nobody re-adds one by accident.

## Requirements

- [Claude Code](https://claude.com/claude-code) installed and signed in with a
  **Claude subscription**. NurseDeck runs entirely on that subscription; it never
  uses an API key, so there is no per-use cost.
- The app checks all of this on startup and walks you through signing in.

## Installing

### macOS

Download `NurseDeck-<version>-mac-universal.dmg` from
[Releases](../../releases). One file works on both Apple Silicon and Intel.

The app is **not signed** with an Apple Developer certificate (that needs a paid
account), so macOS blocks it on first launch:

1. Open the `.dmg`, drag **NurseDeck** to Applications.
2. In Applications, **right-click NurseDeck → Open**. Double-clicking will not
   work the first time.
3. Click **Open** in the dialog. macOS remembers the choice from then on.

If macOS claims the app "is damaged and can't be opened", that is the download
quarantine flag, not actual damage:

```sh
xattr -cr /Applications/NurseDeck.app
```

### Windows

Download and run `NurseDeck-<version>-win-x64-setup.exe`. SmartScreen will warn
about an unknown publisher (the app is unsigned) — choose **More info → Run
anyway**.

## Building installers

A macOS `.dmg` **cannot be built on Windows or Linux**: electron-builder needs
`hdiutil` and `codesign`, which only exist on macOS. Use CI:

- Push a tag (`git tag v0.1.0 && git push --tags`) to build both installers and
  attach them to a GitHub Release.
- Or run the **Build installers** workflow manually from the Actions tab.

Locally, you can only build for the platform you are on:

```sh
npm install
npm run dist:win     # on Windows
npm run dist:mac     # on macOS
```

## Development

```sh
npm install
npm run dev          # Electron + Vite with hot reload
npm run typecheck
npm run test:unit    # unit + integration (drives the real Claude CLI)
npm run test:e2e     # builds, then drives the real Electron window
```

Some tests invoke the real Claude Code CLI and therefore need it installed and
signed in. Auth-failure states are covered by a stub CLI instead, so the test
suite never has to sign you out.
