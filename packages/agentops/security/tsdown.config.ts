import { defineConfig } from 'tsdown'

/** Bundle the compiled security package root. */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    // Keep DSH packages external: inlining schemastery would create a second
    // Schema instance and break schema identity checks at runtime.
    external: [/^@deepseek-ai\//],
    clean: false,
  },
])
