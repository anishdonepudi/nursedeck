# NurseDeck

Local-first, evidence-cited study tool for nursing students. Upload lecture
slides; NurseDeck uses the Claude Code CLI to turn them into flashcards, Q&A,
NCLEX-style questions and practice exams — **with a citation on every claim.**

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
