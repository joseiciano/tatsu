import { parseArgs, type ParseArgsConfig } from 'node:util'
import { commands, findCommand, type Command, type CommandOption, type GlobalOptions } from '../commands'
import { CliError, exitCodeFor, toCliError } from '../errors'
import { createOutput, formatTable, printError, type Write } from '../output'

declare const __TATSU_VERSION__: string | undefined

export const CLI_VERSION = typeof __TATSU_VERSION__ === 'string' ? __TATSU_VERSION__ : '0.0.0-dev'

export interface CliIO {
  stdout: Write
  stderr: Write
  env: Readonly<Record<string, string | undefined>>
}

const HELP_HINT = "Run 'tatsu --help' for usage."

const GLOBAL_OPTIONS: Record<string, CommandOption> = {
  json: { type: 'boolean', description: 'Print machine-readable JSON' },
  url: { type: 'string', valueName: 'url', description: 'Backend WebSocket URL (skips discovery)' },
  token: { type: 'string', valueName: 'token', description: 'Backend auth token (with --url)' },
  timeout: { type: 'string', valueName: 'ms', description: 'Request timeout in milliseconds (default 30000)' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
  version: { type: 'boolean', description: 'Print the CLI version' }
}

type ParsedValues = Record<string, string | boolean | (string | boolean)[] | undefined>

function toParseArgsOptions(options: Record<string, CommandOption>): NonNullable<ParseArgsConfig['options']> {
  return Object.fromEntries(
    Object.entries(options).map(([name, { type, short, multiple }]) => [
      name,
      { type, ...(short ? { short } : {}), ...(multiple ? { multiple } : {}) }
    ])
  )
}

function isParseArgsError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS')
}

function parse(argv: string[], options: Record<string, CommandOption>): { values: ParsedValues; positionals: string[] } {
  try {
    return parseArgs({ args: argv, options: toParseArgsOptions(options), strict: true, allowPositionals: true })
  } catch (err) {
    if (!isParseArgsError(err)) throw err
    throw new CliError('usage', `${err.message.split('. ')[0]}. ${HELP_HINT}`)
  }
}

function looseJsonFlag(argv: string[]): boolean {
  try {
    const { values } = parseArgs({ args: argv, options: toParseArgsOptions(GLOBAL_OPTIONS), strict: false, allowPositionals: true })
    return values.json === true
  } catch {
    return argv.includes('--json')
  }
}

function loosePositionals(argv: string[]): string[] {
  return parseArgs({ args: argv, options: toParseArgsOptions(GLOBAL_OPTIONS), strict: false, allowPositionals: true })
    .positionals
}

function toGlobals(values: ParsedValues): GlobalOptions {
  const globals: GlobalOptions = { json: values.json === true }
  if (typeof values.url === 'string') globals.url = values.url
  if (typeof values.token === 'string') globals.token = values.token
  if (typeof values.timeout === 'string') {
    const ms = Number(values.timeout)
    if (!Number.isInteger(ms) || ms <= 0) {
      throw new CliError('usage', `--timeout must be a positive integer of milliseconds. ${HELP_HINT}`)
    }
    globals.timeoutMs = ms
  }
  return globals
}

function optionRows(options: Record<string, CommandOption>): string[][] {
  return Object.entries(options).map(([name, opt]) => {
    const flag = `${opt.short ? `-${opt.short}, ` : ''}--${name}${opt.type === 'string' ? ` <${opt.valueName ?? 'value'}>` : ''}`
    return [`  ${flag}`, opt.description]
  })
}

function section(title: string, rows: string[][]): string {
  return `${title}:\n${rows.length ? formatTable(rows) : '  (none yet)'}`
}

function rootHelp(registry: readonly Command[]): string {
  return [
    'Usage: tatsu [options] <command> [command options]',
    section('Commands', registry.map((c) => [`  ${c.name}`, c.summary])),
    section('Global options', optionRows(GLOBAL_OPTIONS)),
    "Run 'tatsu <command> --help' for command options."
  ].join('\n\n')
}

function commandHelp(command: Command): string {
  return [
    `Usage: tatsu ${command.usage}`,
    command.summary,
    ...(Object.keys(command.options).length ? [section('Options', optionRows(command.options))] : []),
    section('Global options', optionRows(GLOBAL_OPTIONS))
  ].join('\n\n')
}

function notImplementedClient(): never {
  throw new CliError('command-failed', 'not implemented')
}

async function dispatch(argv: string[], io: CliIO, registry: readonly Command[]): Promise<number> {
  const match = findCommand(registry, loosePositionals(argv))

  if (!match) {
    const { values, positionals } = parse(argv, GLOBAL_OPTIONS)
    toGlobals(values)
    if (values.version === true) {
      io.stdout(`${CLI_VERSION}\n`)
      return 0
    }
    if (positionals.length > 0) {
      throw new CliError('usage', `unknown command '${positionals.join(' ')}'. ${HELP_HINT}`)
    }
    io.stdout(`${rootHelp(registry)}\n`)
    return 0
  }

  const { command } = match
  const { values, positionals } = parse(argv, { ...command.options, ...GLOBAL_OPTIONS })
  const globals = toGlobals(values)
  if (values.help === true) {
    io.stdout(`${commandHelp(command)}\n`)
    return 0
  }

  const words = command.name.split(' ')
  if (words.some((word, i) => positionals[i] !== word)) {
    throw new CliError('usage', `could not parse arguments for '${command.name}'. ${HELP_HINT}`)
  }

  const output = createOutput({ json: globals.json, stdout: io.stdout })
  await command.run({
    values,
    positionals: positionals.slice(words.length),
    globals,
    env: io.env,
    client: async () => notImplementedClient(),
    output
  })
  output.flush()
  return 0
}

export async function main(argv: string[], io: CliIO, registry: readonly Command[] = commands): Promise<number> {
  try {
    return await dispatch(argv, io, registry)
  } catch (err) {
    const cliError = toCliError(err)
    printError(cliError, { json: looseJsonFlag(argv), stderr: io.stderr })
    return exitCodeFor(cliError.code)
  }
}
