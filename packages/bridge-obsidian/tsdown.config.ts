import { defineConfig } from 'tsdown'

/**
 * The bridge package ships TWO runtime entries: the plugin (index) and the
 * protocol module — the Obsidian plugin mirrors the protocol contract, so the
 * protocol bundle is part of the published surface, not an internal module.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/protocol.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/schemastery',
      'ws',
    ],
  },
})
