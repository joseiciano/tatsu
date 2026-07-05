import { basename } from 'path'

// POSIX single-quote escaping. Safe to splice into a shell command line
// because nothing inside single quotes is interpreted (no command
// substitution, no `$`, no backticks). Embedded single quotes are
// handled with the standard `'\''` close/escape/reopen trick.
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Build the argv elements for invoking a shell with a `-c`-style command.
 *  Handles fish/nu/nushell and pwsh/powershell variants; everything else
 *  gets the POSIX `<shell> -c <command>` form. */
export function commandArgsForShell(shell: string, command: string): string[] {
  const shellName = basename(shell).toLowerCase()
  if (shellName === 'fish' || shellName === 'nu' || shellName === 'nushell') return [shell, '-c', command]
  if (shellName === 'pwsh' || shellName === 'powershell' || shellName === 'powershell.exe' || shellName === 'pwsh.exe') {
    return [shell, '-NoLogo', '-NoProfile', '-Command', command]
  }
  return [shell, '-c', command]
}
