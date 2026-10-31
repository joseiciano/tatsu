import { defineConfig } from 'vitest/config'

// `tsc -b` emits compiled *.test.js next to the main bundle under out/; keep
// vitest on the sources so a stale emit can never pass or fail a run.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', 'out/**', 'dist/**', 'dist-headless/**', 'release/**']
  }
})
