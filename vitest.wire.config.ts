import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/wire/**/*.wire.test.ts'],
    exclude: ['**/node_modules/**', 'out/**', 'dist/**', 'dist-headless/**', 'release/**']
  }
})
