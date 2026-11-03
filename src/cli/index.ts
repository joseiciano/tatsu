import { main } from './main'

void main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env
}).then((code) => {
  process.exitCode = code
})
