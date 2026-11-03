import { defineConfig } from 'vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  define: {
    __TATSU_VERSION__: JSON.stringify(version)
  },
  build: {
    target: 'node20',
    outDir: resolve(__dirname, 'dist-headless/cli'),
    emptyOutDir: true,
    sourcemap: true,
    ssr: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/cli/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'index.js',
        banner: '#!/usr/bin/env node'
      }
    }
  },
  ssr: {
    noExternal: []
  }
})
