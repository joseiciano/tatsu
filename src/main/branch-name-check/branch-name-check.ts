import { execFile } from 'child_process'
import { promisify } from 'util'
import { branchNameProblem } from '../../shared/branch-name-rules'

const execFileAsync = promisify(execFile)

export async function checkBranchName(name: string): Promise<string | null> {
  const problem = branchNameProblem(name)
  if (problem !== null) return problem
  const refused = `“${name}” is not a valid git branch name`
  try {
    const { stdout } = await execFileAsync('git', ['check-ref-format', '--branch', name])
    return stdout.trim() === name ? null : refused
  } catch {
    return refused
  }
}
