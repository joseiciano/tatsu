import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of lines) {
  let record
  try {
    const value = JSON.parse(line)
    record = `=${JSON.stringify(value)}\n${JSON.stringify(value, null, 2)}\n\n`
  } catch {
    record = '!\n\n'
  }
  process.stdout.write(record)
}
