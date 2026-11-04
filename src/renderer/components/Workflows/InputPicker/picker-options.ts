import { fuzzyMatch } from '../../../fuzzy'
import type { IssueSummary, PRSummary } from '../../../../shared/github-types'
import type { PickerOption } from './types'

export const PICKER_OPTION_LIMIT = 50

const NUMBER_PATTERN = /^#?(\d{1,9})$/

export function isRepoRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '').slice(0, 9)
}

export function fileOptions(files: readonly string[], query: string): PickerOption[] {
  const text = query.trim()
  const matches = text === '' ? files.slice(0, PICKER_OPTION_LIMIT) : fuzzyMatch(text, [...files]).map((r) => r.item)
  return matches.slice(0, PICKER_OPTION_LIMIT).map((path) => ({ value: path, label: path }))
}

function typedNumber(query: string, listed: readonly PickerOption[]): PickerOption[] {
  const match = NUMBER_PATTERN.exec(query.trim())
  if (!match) return []
  const value = String(Number(match[1]))
  return listed.some((option) => option.value === value) ? [] : [{ value, label: `#${value}`, detail: 'Use this number' }]
}

function numbered(number: number, title: string, detail?: string): PickerOption {
  return { value: String(number), label: `#${number} ${title}`, ...(detail ? { detail } : {}) }
}

export function prOptions(prs: readonly PRSummary[], query: string): PickerOption[] {
  const text = query.trim().replace(/^#/, '').toLowerCase()
  const listed = prs
    .filter((pr) => text === '' || `${pr.number} ${pr.title} ${pr.headBranch}`.toLowerCase().includes(text))
    .slice(0, PICKER_OPTION_LIMIT)
    .map((pr) => numbered(pr.number, pr.title, pr.headBranch))
  return [...typedNumber(query, listed), ...listed]
}

export function issueOptions(issues: readonly IssueSummary[], query: string): PickerOption[] {
  const listed = issues
    .slice(0, PICKER_OPTION_LIMIT)
    .map((issue) => numbered(issue.number, issue.title, issue.author ?? undefined))
  return [...typedNumber(query, listed), ...listed]
}
