import { defineConfig } from 'tsdown'

/** Node-only server bundle and its profile-loaded helper plugins. */
export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/environments.js',
    'lib/types/executor-broker.js',
    'lib/types/environment-context.js',
    'lib/types/tool-environment.js',
    'lib/types/cloud-execution.js',
    'lib/types/runtime-router.js',
    'lib/types/fs-router.js',
    'lib/types/subprocess-router.js',
    'lib/types/shell-router.js',
    'lib/types/tool-shell.js',
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
