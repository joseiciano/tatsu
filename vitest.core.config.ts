import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['scripts/core/**/*.core.test.ts', 'src/**/*.core.test.ts'],
    exclude: ['**/node_modules/**', 'out/**', 'dist/**', 'dist-headless/**', 'release/**']
  }
})
