import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isPidAlive } from './endpoint'
import { main } from './main'

void main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  files: { readFile: (path) => readFile(path, 'utf8'), homedir, platform: process.platform, isPidAlive }
}).then((code) => {
  process.exitCode = code
})
