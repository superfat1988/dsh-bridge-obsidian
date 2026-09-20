/**
 * Adapter shim: satisfies `assistant-stream.ts`'s `./attachments.ts` import.
 *
 * The Obsidian panel has no multimodal surface — it never renders streamed
 * images, and its `Row` carries no image field. Returning an empty list is
 * therefore behavior-preserving rather than a silent truncation: the vendored
 * state machine only uses this to decide between a text row, an image row, and
 * no row, and text-only is the panel's sole supported outcome.
 *
 * Keeping the shim explicit (instead of editing the vendored file) lets the
 * sync script treat `assistant-stream.ts` as an unmodified upstream artifact.
 *
 * @module
 */

/** Minimal image reference shape; unused by the Obsidian panel today. */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** @returns no image references; the Obsidian panel does not surface images. */
export function imageRefsFromBlocks(_blocks: unknown): ImageAttachmentRef[] {
  return []
}
