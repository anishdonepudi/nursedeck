# NurseDeck

Local-first, evidence-cited study tool for nursing students. Give it your
lecture slides; it turns them into flashcards, short-answer questions,
NCLEX-style vignettes and practice exams — **with a citation on every claim,
checked before you ever see the card.**

It runs on your own Claude subscription through the Claude Code CLI. No API key,
no per-use cost, and your lectures never leave your machine except as text sent
to Claude to generate from.

---

## Contents

- [What it does](#what-it-does)
- [How it avoids making things up](#how-it-avoids-making-things-up)
- [Reading slides that are only a picture](#reading-slides-that-are-only-a-picture)
- [Cross-checking against an outside authority](#cross-checking-against-an-outside-authority)
- [Studying](#studying)
- [Practice exams and diagnostics](#practice-exams-and-diagnostics)
- [Your own cards, and other people's](#your-own-cards-and-other-peoples)
- [Getting your cards out](#getting-your-cards-out)
- [Requirements](#requirements)
- [Installing](#installing)
- [Building installers](#building-installers)
- [Development](#development)
- [Known limits](#known-limits)

---

## What it does

### 1. Import

PowerPoint (`.pptx`), PDF, Word (`.docx`), or **photographs of handwritten
notes**, which are transcribed by Claude's vision.

For PowerPoint specifically:

- **Slide order** comes from `presentation.xml` relationship IDs, never from
  filename sort — decks routinely store slides out of order on disk.
- **Speaker notes** are extracted and treated as first-class content. On two of
  the decks this was tested against, the notes carry 17–20× more text than the
  slide bodies, and they are usually where the exam material lives.
- **Tables** are rendered so each row names its own columns, because
  `Respiratory acidosis | down | up` quoted on its own cannot tell you which
  column was pH.
- **Pictures** are read for text — see
  [below](#reading-slides-that-are-only-a-picture).

### 2. Generate

Four kinds of study material, each with its own rules:

| Kind | What it is |
|---|---|
| **Flashcards** | One fact per card, answer under 20 words, never giving the answer away in the question |
| **Fill in the blank** | Cloze deletions where the blank is the *information payload* — never a word grammar alone would reveal |
| **Short answer** | Questions needing an explanation, stored with the key points a complete answer must contain |
| **NCLEX questions** | Clinical vignettes following the 2026 NCLEX-RN test plan, with a rationale on **every** option and a named error class on each distractor |

### 3. Review

Nothing reaches your deck unreviewed. Triage is keyboard-driven — one key to
keep, one to discard — with the source quote visible beside every card so the
decision is made on evidence rather than on whether the card "looks right".

**Check all** verifies an entire lecture in one go rather than one card at a
time. It is cancellable, stops at a spending limit, and one card that errors
never abandons the rest.

### 4. Study

Spaced repetition with FSRS-6, typing answers rather than flipping cards.

---

## How it avoids making things up

Every claim must quote the slide it came from, and that quote is checked in four
stages, cheapest first:

| Stage | Check | Cost |
|---|---|---|
| Licence | May this source be used this way at all? | free |
| Verbatim | Does the quote actually appear on the cited slide, in order? | free |
| Numeric | Does every dose, range and threshold asserted appear in the quote? | free |
| Entailment | Does the quote actually *support* the claim? | one model call |

The entailment audit runs in a **separate, isolated session** that sees only the
claim and the quote — never the lecture, never the original prompt — so it
cannot rubber-stamp its own earlier output.

A card is studiable only when you have accepted it **and** its citation is
verified. That rule is enforced in SQL, not left to the UI.

### Citations are checked against the slide they name, not the whole lecture

This matters more than it sounds. Verifying against the entire deck concatenated
together would let a quote stitch a fragment from slide 3 to one from slide 30 —
a quote that verifies against the concatenation and appears on no single slide.

### Widening an under-cited quote

Most rejected cards are not wrong, they are under-cited: a slide splits a fact
across a heading, a bullet and a table, and one span cannot carry all of it.

When the auditor names the part it could not support, that part becomes a search
term **against the same slide**. Any fragment added must appear there verbatim,
fragments are ordered by their position in the slide, and the widened quote is
re-audited by the same isolated auditor, which is never told a repair happened.

A claim the auditor says the slide **contradicts** is never repaired. If the
slide disagrees with the card, more quoting cannot fix it.

Measured on four real lecture decks: **+44% more cards verified, with zero
integrity violations** — every rescued quote still verbatim on its own slide and
still carrying every number its card asserts.

### What this costs you in yield

Across those four decks, 85% of generated cards pass the full gate (96%, 87%,
84% and 72% by deck). The rest stay out of your study queue. The gate costs
throughput, not accuracy — and the audit of what survives has found **zero
fabricated quotes and zero unsupported numbers.**

---

## Reading slides that are only a picture

On the four decks this was built against, **18 of 96 slides contain no text at
all** — and 32% of one lecture. The heading, the content and the nursing note
are all baked into an image. Those slides used to produce nothing, so a third of
that lecture was silently missing.

So the text printed inside slide pictures is transcribed, and the transcript
becomes citable source text: a card quoting a diagram is checked by exact string
match against the transcript, exactly as a card quoting a bullet is checked
against the slide.

Because the transcript *is* the evidence, the model is told to transcribe and
never to interpret, complete or correct. A model that helpfully finishes a
mnemonic would be manufacturing a claim that then passes verification.

Only slides with little text of their own are transcribed, so a picture beside a
full slide costs nothing.

---

## Cross-checking against an outside authority

Verifying against your lecture proves the slide says it. That is a different
question from whether it is *true*, and slides do carry stale values.

So a card can also be cross-checked against free, authoritative sources —
openFDA (public domain), DailyMed and RxNorm — which answer with one of:

- **Confirmed** — an independent source states the same thing, attached as a
  second citation.
- **Disagrees** — the official labelling says something incompatible. This is
  the valuable result: it is surfaced rather than resolved, because we cannot
  know whether the slide is outdated or the match is simply off.
- **No official source covers this** — common and fine; plenty of nursing
  practice is not drug labelling.

Every outbound host is on an explicit allow-list with its published rate limit.
Sources that forbid automated access — and every commercial test-prep vendor —
are on a deny-list **with the reason recorded**, so nobody re-adds one by
accident.

---

## Studying

- **Type the answer, don't flip the card.** Re-reading beats recall at five
  minutes and loses badly at a week. Passive flipping feels productive and is
  the weaker mode, so it is not the default.
- **Confidence is captured before the answer is revealed**, and stored
  separately from whether you were right. *Confident and wrong* is the single
  most valuable signal here, and it is unrecoverable if the two are conflated.
  Those cards get their own list.
- **Read aloud.** Any card can be spoken, with nursing shorthand expanded
  properly — `K+ 3.5-5.0 mEq/L` is read as potassium, three point five **to**
  five point zero milliequivalents per litre, not as a subtraction.
- **Study everything at once** or one lecture at a time. Exams mix topics, and
  so can the queue.
- **Teach-back grading.** A short-answer question is marked against the key
  points stored on the card, not by string comparison — a correct three-sentence
  explanation in your own words scores as correct. Each key point is marked
  individually, quoting *your* words back where you covered it. The grader may
  only judge the card's own key points; it cannot invent a criterion you were
  never told about.
- **Concept maps**, built **only from cards whose citation is verified**. Every
  arrow comes from one such card and clicking it shows that card's lecture quote.
  A map is a view over checked material, never a new source of claims — a wrong
  arrow is worse than a wrong flashcard, because it reshapes how you organise a
  whole topic.

---

## Practice exams and diagnostics

Exams are assembled against the **2026 NCLEX-RN test plan** blueprint, and
scored the way the real thing is — polytomously, with the flooring unit varying
by item type:

| Rule | Mechanics |
|---|---|
| **0/1** | +1 per correct selection, no penalty |
| **+/−** | +1 correct, −1 incorrect, **floored per column or group** — so selecting everything gains nothing |
| **Rationale** | All-or-nothing on linked cause→effect. **A wrong cause scores zero however many effects are right.** |

The dashboard reports:

- **Topic readiness with a credible interval**, never a bare percentage from
  three reviews. "Not enough data yet" is a real answer.
- **Cards you were confident about and got wrong** — the illusion-of-knowing
  list.
- **Cards that keep failing** (leeches), which is usually where badly generated
  items concentrate.
- **Workload ahead**, and a projection to your exam date that simulates the
  reviews actually due before it.

---

## Your own cards, and other people's

**Write your own.** They are studiable immediately — you are the source for a
card you wrote, and reviewing your own card against itself would be theatre.

**Edit a generated card** and its citation is invalidated, because the quote was
checked against the old wording. The card leaves the study queue until
re-checked, and the app says so plainly rather than letting it vanish.

**Import a classmate's deck** (Anki text export or Quizlet CSV). Imported cards
arrive **pending and unverified and cannot be studied**: a shared deck carries no
evidence, and user-generated study content is exactly the unreliable source this
tool exists to replace. Making one studiable requires you to **Keep** it, which
records that *you* stand behind it — the same honest footing as a card you wrote.
Generated cards can never be promoted this way; the citation gate is not
optional.

---

## Getting your cards out

Your cards are never trapped here.

- **`.apkg`** — a real Anki package, carrying the deck and your desired-retention
  setting. It deliberately does **not** carry review history: Anki's own FSRS
  would re-optimise from logs produced by a different implementation of the same
  algorithm, and a disagreement there shows up as wrong intervals rather than as
  an error. Cards start fresh in Anki's scheduler, tagged so a reset interval is
  explicable.
- **Anki text** and **Quizlet CSV** — plain, dependency-free, and importable
  anywhere.

**Only verified cards are exported**, and the count withheld is reported. Pushing
an unchecked claim into a tool that has no idea it was never verified is how a
bad card escapes the whole design.

---

## Requirements

**[Claude Code](https://claude.com/claude-code), installed and signed in with a
Claude subscription.** That is the only thing you need to install yourself —
NurseDeck bundles everything else, including its own Node runtime and database
engine.

The app checks this on startup and shows you the exact command for your
platform:

```sh
# macOS — in Terminal
curl -fsSL https://claude.ai/install.sh | bash
```

```powershell
# Windows — in PowerShell
irm https://claude.ai/install.ps1 | iex
```

Then run `claude` once and sign in. If you already have Node.js, `npm install -g
@anthropic-ai/claude-code` works too.

**Startup checks**, all shown with a one-click fix where one exists: data folder
writable · database engine · Claude Code found · version new enough · required
options supported · signed in · subscription rather than per-use billing ·
internet reachable.

Only the last is non-blocking, because **studying, exams, the dashboard and
export all work offline.** Making *new* cards needs a connection.

---

## Installing

### macOS

Download `NurseDeck-<version>-mac-universal.dmg` from [Releases](../../releases).
One file runs on both Apple Silicon and Intel.

The app is **not signed** with an Apple Developer certificate (that needs a paid
account), so macOS blocks it on first launch:

1. Open the `.dmg` and drag **NurseDeck** to Applications.
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

---

## Building installers

A macOS `.dmg` **cannot be built on Windows or Linux**: electron-builder needs
`hdiutil` and `codesign`, which exist only on macOS. Use CI:

- Push a tag (`git tag v0.1.1 && git push --tags`) to build both installers and
  attach them to a GitHub Release. The build fails if the tag and
  `package.json`'s version disagree, so installer filenames always match the
  release.
- Or run the **Build installers** workflow manually from the Actions tab.

Locally you can only build for the platform you are on:

```sh
npm install
npm run dist:win     # on Windows
npm run dist:mac     # on macOS
```

---

## Development

```sh
npm install
npm run dev          # Electron + Vite with hot reload
npm run typecheck    # both TS projects, plus a check for bundler-breaking characters
npm run test:unit    # 460 tests
npm run test:e2e     # builds, then drives a real Electron window
```

### How the tests are arranged

- **Unit and integration** (460). Includes adversarial suites written as
  attempts to get an unsupported claim into the study queue, and hostile-input
  suites covering slides containing instruction-shaped text, corrupt files, lone
  surrogates and 200KB single lines.
- **End-to-end** (23), driving the real Electron window and the real Claude CLI.
- **Packaged-app** (2), driving the built `.exe` rather than the dev build —
  because a module resolved by path can work in development and fail only inside
  an `app.asar`. This is what catches, for example, the WebAssembly SQLite the
  Anki export depends on failing to load from inside the package.

About a dozen tests drive the real Claude CLI deliberately — they assert the
auditor actually catches a shifted lab range or a reversed safety instruction,
which a mocked model could not. **They skip when no CLI is present**, so CI runs
423 of the 460 and a developer machine runs all of them. There is no Claude Code
on a CI runner and there must not be: putting a subscription credential into CI
is exactly what this app avoids.

### Known flakiness

Tests that call the live model are not perfectly deterministic — it may word a
card differently or judge a borderline citation differently between runs. Those
tests assert *properties* (every quote appears in its source; no number is
asserted that the citation lacks) rather than exact strings, which absorbs most
of it, but an occasional re-run is expected. The pure-logic suites — scoring,
scheduling, blueprint, quality rules, export — are deterministic.

---

## Known limits

- **The app is unsigned** on both platforms. Signing needs a paid Apple
  Developer account and a Windows code-signing certificate.
- **15% of generated cards do not pass the gate** and stay out of your deck.
  Most are under-cited rather than wrong. Loosening the auditor would raise that
  number and is deliberately not done.
- **Proficiency levels are not reported.** Other tools map practice scores to a
  readiness level using cut scores that are proprietary and unpublished.
  Inventing one would be a fabricated claim about your exam readiness, which is
  worse than a fabricated flashcard, because you would plan your studying around
  it.
- **Image occlusion is not implemented.** It was planned, then dropped on
  evidence: the pictures in these decks are mnemonic cartoons rather than
  labelled anatomical diagrams, so there was almost nothing to occlude. Reading
  the text out of them turned out to matter far more.
