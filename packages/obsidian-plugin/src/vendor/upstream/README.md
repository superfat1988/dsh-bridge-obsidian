# Vendored upstream code (`dsh-bridge-browser`)

This directory holds source copied verbatim from the upstream
[`dsh-bridge-browser`](https://github.com/Lum1104/dsh-browser) extension. The
point of vendoring is that DSH keeps shipping breaking changes, and upstream
absorbs those changes for us — so we inherit its fix instead of rediscovering
it. The one rule that makes that work:

> **`assistant-stream.ts` is copied byte-for-byte and never edited.**
> Every adaptation lives in the sibling shims (`events.ts`, `attachments.ts`),
> so a sync can be verified by hash and a patch can never silently diverge.

## Layout

| File | Origin | Editable here |
|---|---|---|
| `assistant-stream.ts` | `extensions/dsh-browser/src/panel/assistant-stream.ts` | **no** — hash-checked |
| `assistant-stream.ts.sha256` | hash of the upstream file at vendoring time | regenerated only by a sync |
| `events.ts` | shim over `src/session-events.ts` | yes |
| `attachments.ts` | shim; the Obsidian panel has no image surface | yes |

## What the vendored file is

`AssistantStreamView` is upstream's state machine for one session's in-flight
Assistant attempt. It is deliberately framework-free (no React, no DOM), which
is why an Obsidian panel can use it unchanged even though upstream runs it
inside a React extension.

It owns three things the panel must not reimplement:

1. **Dense index tracking** — a gap in chunk indices is detected rather than
   rendered as if the text were contiguous.
2. **Revision ordering** — out-of-order or replayed frames are ignored instead
   of double-applied.
3. **Settlement** — a durable `assistant/message`/`assistant/attempt` replaces
   the transient row, so live text cannot outlive the message that superseded it.

`replace()` takes an authoritative follow *opening* (the Host baseline);
`accept()` takes incremental frames; `row()` returns the text to render, or
`null` once the attempt has settled.

## Why the shims exist

The vendored file imports `./events.ts` and `./attachments.ts`. Rewriting those
imports inside the vendored file would make it differ from upstream and destroy
the hash check, so the imports are satisfied by shims instead:

- **`events.ts`** re-exports the panel's own `Row`, `SessionEventView`, and
  `textFromBlocks`. The panel already had equivalents; this is a re-export, not
  a second implementation.
- **`attachments.ts`** returns no image references. The Obsidian panel has no
  multimodal surface and its `Row` carries no image field, so text-only is the
  panel's sole supported outcome — an empty list is behavior-preserving, not a
  silent truncation.

## Syncing with upstream

Upstream changes this file rarely but meaningfully (its `74cebab` adaptation to
DSH's stream frames is exactly the class of change we want to inherit).

1. Read the upstream file and hash it:
   ```sh
   git -C ~/.dsh/dsh-browser log -1 --format=%H -- \
     extensions/dsh-browser/src/panel/assistant-stream.ts
   sha256sum ~/.dsh/dsh-browser/extensions/dsh-browser/src/panel/assistant-stream.ts
   ```
2. If the hash differs from `assistant-stream.ts.sha256`, copy the new file in,
   update the hash, and re-run `pnpm typecheck`.
3. **A type error after a sync is the intended failure mode.** It means upstream
   changed the contract (a new field, a renamed method). Widen the shim or the
   `SessionEventView` declaration — never the vendored file. If the change cannot
   be absorbed by a shim, that is the signal to stop and reassess the vendoring
   boundary rather than to patch upstream's code.

## Provenance

- Vendored on 2026-09-20 from `dsh-browser` @ `fce0a26`, file SHA-256
  `5096cf8c6f9357a2e3ccef14dfea002e1fa95682d1b6f2972ca59b47f7f22f5a`.
- Upstream is MIT-licensed (Copyright (c) 2026 Yuxiang Lin); this repository is
  MIT-licensed too, so the copy is license-compatible. Keep this note with the
  code so the origin stays attributable.
