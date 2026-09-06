/**
 * Vault tool executor: performs `obsidian_*` tool calls in the connected
 * Obsidian client via the Obsidian Vault API. Every result is a `{ text }`
 * payload (matching the bridge's TEXT_OUTPUT contract); failures throw with
 * a stable `code` that the connection layer wires into `tool.result`.
 *
 * The vault's write path ALWAYS runs through the local approval gate when
 * configured: the agent never bypasses the user's write-approval setting.
 *
 * @module
 */

import type { App, TFile, TFolder } from 'obsidian'

/** Executor settings subset. */
export interface ExecutorSettings {
  /** 'ask' shows a confirmation modal before every write; 'auto' writes directly. */
  writeApproval: 'ask' | 'auto'
  /** Upper bound on one read's characters (bridged caps by default). */
  maxReadChars: number
  /** Upper bound on search results. */
  searchLimit: number
}

export class ToolFailure extends Error {
  constructor(
    readonly code: 'bad-args' | 'io-error' | 'approval-denied',
    message: string,
  ) {
    super(message)
    this.name = 'ToolFailure'
  }
}

export type VaultApp = App

export async function executeToolCall(
  app: VaultApp,
  settings: ExecutorSettings,
  name: string,
  args: Record<string, unknown>,
  confirmWrite: (path: string, content: string, mode: 'overwrite' | 'append') => Promise<boolean>,
): Promise<{ text: string }> {
  switch (name) {
    case 'obsidian_list_notes':
      return listNotes(app, args)
    case 'obsidian_read_note':
      return readNote(app, args, settings)
    case 'obsidian_write_note':
      return writeNote(app, args, settings, confirmWrite)
    case 'obsidian_search_vault':
      return searchVault(app, args, settings)
    default:
      throw new ToolFailure('bad-args', `unknown tool ${JSON.stringify(name)}`)
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolFailure('bad-args', `${key} must be a non-empty string`)
  }
  return value.trim()
}

function optionalInt(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) return fallback
  return n
}

function normalizePath(raw: string): string {
  // Vault-relative, forward slashes, no leading/trailing slash, no .. escape.
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (cleaned.split('/').includes('..') || cleaned === '') {
    throw new ToolFailure('bad-args', `path must be a vault-relative path: ${JSON.stringify(raw)}`)
  }
  return cleaned
}

async function listNotes(app: VaultApp, args: Record<string, unknown>): Promise<{ text: string }> {
  const folder = args.folder !== undefined ? normalizePath(requireString(args, 'folder')) : undefined
  const limit = optionalInt(args, 'limit', 200)
  const offset = optionalInt(args, 'offset', 0)
  const files = app.vault.getMarkdownFiles()
    .filter(f => folder === undefined || f.path === folder || f.path.startsWith(`${folder}/`))
    .sort((a, b) => a.path.localeCompare(b.path))
  const slice = files.slice(offset, offset + limit)
  if (slice.length === 0) return { text: `No markdown notes found (folder=${folder ?? 'vault root'}, total ${files.length}).` }
  const lines = slice.map((f) => {
    const stat = app.vault.getAbstractFileByPath(f.path)
    const size = stat !== null && 'stat' in stat ? (stat as TFile).stat.size : 0
    const mtime = stat !== null && 'stat' in stat ? new Date((stat as TFile).stat.mtime).toISOString().slice(0, 16).replace('T', ' ') : ''
    return `${f.path} (${size}B, ${mtime})`
  })
  const suffix = files.length > offset + slice.length ? `\n… (${files.length - offset - slice.length} more; use offset to page)` : ''
  return { text: `Total ${files.length} notes; showing ${slice.length}:\n${lines.join('\n')}${suffix}` }
}

async function readNote(app: VaultApp, args: Record<string, unknown>, settings: ExecutorSettings): Promise<{ text: string }> {
  const path = normalizePath(requireString(args, 'path'))
  const fromLine = Math.max(1, optionalInt(args, 'from_line', 1))
  const maxChars = Math.min(optionalInt(args, 'max_chars', settings.maxReadChars), settings.maxReadChars)
  const file = app.vault.getAbstractFileByPath(path)
  if (file === null || !('stat' in file)) {
    throw new ToolFailure('io-error', `note not found: ${path}`)
  }
  const content = await app.vault.cachedRead(file as TFile)
  const allLines = content.split('\n')
  const lines = allLines.slice(fromLine - 1)
  let text = lines.join('\n')
  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  const header = `# ${path} (lines ${fromLine}-${fromLine + lines.length - 1} of ${allLines.length})`
  const suffix = truncated ? `\n\n[truncated at ${maxChars} chars; re-read with from_line to continue]` : ''
  return { text: `${header}\n\n${text}${suffix}` }
}

async function writeNote(
  app: VaultApp,
  args: Record<string, unknown>,
  settings: ExecutorSettings,
  confirmWrite: (path: string, content: string, mode: 'overwrite' | 'append') => Promise<boolean>,
): Promise<{ text: string }> {
  const path = normalizePath(requireString(args, 'path'))
  const contentRaw = args.content
  if (typeof contentRaw !== 'string') {
    throw new ToolFailure('bad-args', 'content must be a string')
  }
  const mode: 'overwrite' | 'append' = args.mode === 'append' ? 'append' : 'overwrite'

  if (settings.writeApproval === 'ask') {
    const approved = await confirmWrite(path, contentRaw, mode)
    if (!approved) {
      throw new ToolFailure('approval-denied', `write to ${path} was not approved by the user`)
    }
  }

  const existing = app.vault.getAbstractFileByPath(path)
  if (mode === 'append') {
    if (existing === null || !('stat' in existing)) {
      throw new ToolFailure('io-error', `note not found for append: ${path}`)
    }
    await app.vault.process((existing as TFile), (data) => `${data}${contentRaw}`)
    return { text: `Appended ${contentRaw.length} chars to ${path}.` }
  }
  if (existing !== null && 'stat' in existing) {
    await app.vault.modify(existing as TFile, contentRaw)
    return { text: `Overwrote ${path} (${contentRaw.length} chars).` }
  }
  await ensureFolder(app, path)
  await app.vault.create(path, contentRaw)
  return { text: `Created ${path} (${contentRaw.length} chars).` }
}

async function ensureFolder(app: VaultApp, filePath: string): Promise<void> {
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
  if (dir === '') return
  if (app.vault.getAbstractFileByPath(dir) !== null) return
  const parts = dir.split('/')
  let current = ''
  for (const part of parts) {
    current = current === '' ? part : `${current}/${part}`
    if (app.vault.getAbstractFileByPath(current) === null) {
      await app.vault.createFolder(current)
    }
  }
  void ({} as TFolder)
}

async function searchVault(app: VaultApp, args: Record<string, unknown>, settings: ExecutorSettings): Promise<{ text: string }> {
  const query = requireString(args, 'query').toLowerCase()
  const limit = Math.min(optionalInt(args, 'limit', settings.searchLimit), settings.searchLimit)
  const matches: string[] = []
  for (const file of app.vault.getMarkdownFiles()) {
    if (matches.length >= limit) break
    const content = await app.vault.cachedRead(file)
    const lines = content.split('\n')
    for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
      const idx = lines[i]?.toLowerCase().indexOf(query) ?? -1
      if (idx !== -1) {
        const start = Math.max(0, idx - 40)
        const snippet = lines[i]?.slice(start, start + 120)?.trim() ?? ''
        matches.push(`${file.path}:${i + 1}: ${snippet}`)
      }
    }
  }
  if (matches.length === 0) return { text: `No matches for ${JSON.stringify(query)}.` }
  return { text: `${matches.length} match(es):\n${matches.join('\n')}` }
}
