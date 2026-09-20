#!/usr/bin/env node
/**
 * Package the Obsidian client plugin into `release/dsh-bridge-obsidian-plugin/`
 * and a versioned ZIP beside the checkout root.
 *
 * `esbuild.config.mjs` writes `main.js` into the package directory, while the
 * installable artifact is the three-file bundle (main.js / manifest.json /
 * styles.css) under `release/`. Keeping that copy manual is how a stale
 * `main.js` can ship: the build succeeds, the release directory keeps an older
 * bundle, and nothing fails. This script makes the copy part of the build and
 * asserts the result actually contains the code just compiled.
 *
 * Usage: node scripts/package-plugin.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'packages/obsidian-plugin')
const releaseDir = join(root, 'release/dsh-bridge-obsidian-plugin')
const builtMain = join(pkgDir, 'main.js')

if (!existsSync(builtMain)) {
  console.error(`package-plugin: ${builtMain} is missing; run \`pnpm build\` first`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8'))
const version = manifest.version
if (typeof version !== 'string' || version === '') {
  console.error('package-plugin: manifest.json has no version')
  process.exit(1)
}

// Fail before copying if the build predates the current sources: a stale bundle
// is the exact failure this script exists to prevent. The sentinels are string
// literals from the vendored state machine rather than class names, because a
// production build minifies identifiers away but keeps these.
const builtAt = readFileSync(builtMain, 'utf8')
for (const sentinel of ['rebaseline', 'startedAfterSeq']) {
  if (!builtAt.includes(sentinel)) {
    console.error(`package-plugin: built main.js is missing "${sentinel}" — it looks stale or partial`)
    process.exit(1)
  }
}

mkdirSync(releaseDir, { recursive: true })
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  const from = join(pkgDir, file)
  if (!existsSync(from)) {
    console.error(`package-plugin: ${from} is missing`)
    process.exit(1)
  }
  copyFileSync(from, join(releaseDir, file))
}
console.log(`package-plugin: release/dsh-bridge-obsidian-plugin/ updated (v${version})`)

const zipName = `dsh-obsidian-plugin-${version}.zip`
const zipPath = join(root, zipName)
rmSync(zipPath, { force: true })
// Archive from inside the release dir so the three files sit at the ZIP root:
// Obsidian rejects a nested folder as "manifest.json not found".
execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: releaseDir })
if (!existsSync(zipPath)) {
  console.error('package-plugin: zip was not produced')
  process.exit(1)
}
const listed = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
if (!listed.split('\n').includes('manifest.json')) {
  console.error('package-plugin: manifest.json is not at the ZIP root')
  process.exit(1)
}
console.log(`package-plugin: wrote ${zipName}`)
