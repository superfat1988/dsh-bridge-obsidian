/**
 * Adapter shim: satisfies `assistant-stream.ts`'s `./events.ts` import with the
 * Obsidian panel's own event model.
 *
 * The vendored `assistant-stream.ts` is kept byte-identical to upstream so a
 * sync script can verify it by hash; every difference lives here instead. The
 * Obsidian panel already owns `Row` / `SessionEventView` / `textFromBlocks`, so
 * this shim is a pure re-export rather than a second implementation.
 *
 * @module
 */

export { textFromBlocks, type Row, type SessionEventView } from '../../session-events.ts'
