import { defineConfig } from 'tsdown'

/**
 * Bundle the compiled package root, matching the DSH package convention:
 * tsc emits to `lib/types`, tsdown bundles that entry into `lib/index.js`.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
