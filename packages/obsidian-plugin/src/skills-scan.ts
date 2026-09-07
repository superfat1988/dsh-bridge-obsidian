/**
 * Vault skills scanner: reads the `Deepseek Harness/skills/<name>/SKILL.md`
 * tree and publishes a manifest (name + trigger description + path) that the
 * bridge injects into bridge-owned sessions. The model reads a skill's full
 * SKILL.md via obsidian_read_note only when its description matches — the
 * same on-demand semantics Copilot V4 uses.
 *
 * @module
 */

import type { App, TFile } from 'obsidian'
import type { VaultSkillEntry } from './protocol.ts'

/** Scan `<folder>/skills/**\/SKILL.md` and parse minimal frontmatter. */
export async function scanVaultSkills(app: App, archiveFolder: string): Promise<VaultSkillEntry[]> {
  const root = `${archiveFolder}/skills/`
  const skills: VaultSkillEntry[] = []
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(root) || !file.path.endsWith('SKILL.md')) continue
    skills.push(await readSkillEntry(app, file))
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

async function readSkillEntry(app: App, file: TFile): Promise<VaultSkillEntry> {
  const folderName = file.parent?.name ?? file.path
  let content = ''
  try {
    content = await app.vault.cachedRead(file)
  } catch {
    content = ''
  }
  const frontmatter = parseFrontmatter(content)
  const name = frontmatter.name ?? folderName
  const description = frontmatter.description ?? ''
  return { name, description, path: file.path }
}

/** Minimal `name:` / `description:` frontmatter reader (leading `---` block). */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = content.slice(3, end)
  let name: string | undefined
  let description: string | undefined
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (name === undefined && line.startsWith('name:')) {
      name = line.slice(5).trim().replace(/^["']|["']$/g, '')
    } else if (description === undefined && line.startsWith('description:')) {
      description = line.slice(12).trim().replace(/^["']|["']$/g, '')
    }
  }
  return {
    ...(name !== undefined && name !== '' ? { name } : {}),
    ...(description !== undefined && description !== '' ? { description } : {}),
  }
}
