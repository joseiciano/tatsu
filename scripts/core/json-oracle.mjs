import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

const number = (n) => (Object.is(n, -0) ? '-0' : String(n))

const scalarOps = {
  number: ({ input }) => `n:${number(Number(input))}`,
  truthy: ({ input }) => `b:${Boolean(input)}`,
  string: ({ input }) => `s:${JSON.stringify(String(input))}`,
  trim: ({ input }) => `s:${JSON.stringify(input.trim())}`,
  parseInt: ({ input, radix }) => `n:${number(parseInt(input, radix))}`,
  encodeURIComponent: ({ input }) => {
    try {
      return `s:${JSON.stringify(encodeURIComponent(input))}`
    } catch {
      return '!'
    }
  },
  utf16Length: ({ input }) => `n:${input.length}`,
  toFixed: ({ input, digits }) => `s:${JSON.stringify(Number(input).toFixed(digits))}`,
}

const jsonRecord = (line) => {
  try {
    const value = JSON.parse(line)
    return `=${JSON.stringify(value)}\n${JSON.stringify(value, null, 2)}\n\n`
  } catch {
    return '!\n\n'
  }
}

const scalarRecord = (line) => {
  const request = JSON.parse(line)
  return `${scalarOps[request.op](request)}\n\n`
}

const record = process.argv[2] === 'scalars' ? scalarRecord : jsonRecord

for await (const line of lines) {
  process.stdout.write(record(line))
}
