import { defineConfig } from 'tsdown'

/** Node-only server bundle and its profile-loaded helper plugins. */
export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/invariant.js',
    'lib/types/startup.js',
    'lib/types/session-persistence.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
