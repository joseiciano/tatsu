import { TEMPLATE_RUN_FIELDS, tokenizeTemplate, type ParsedWorkflowDefinition } from '../../../../shared/workflow-def'

export interface TemplateCompletion {
  label: string
  detail: string
}

export interface OpenTemplatePrefix {
  start: number
  prefix: string
}

const OPEN = '{{'
const PREFIX = /^[A-Za-z0-9_.-]*$/

export function openTemplatePrefix(lineBefore: string): OpenTemplatePrefix | null {
  const last = tokenizeTemplate(lineBefore).at(-1)
  if (last?.kind !== 'error' || last.raw.includes('}}')) return null
  const inner = last.raw.slice(OPEN.length)
  const prefix = inner.trimStart()
  if (!PREFIX.test(prefix)) return null
  return { start: last.start + OPEN.length + inner.length - prefix.length, prefix }
}

function allCompletions(parsed: ParsedWorkflowDefinition | undefined): TemplateCompletion[] {
  const out: TemplateCompletion[] = []
  for (const name of Object.keys(parsed?.inputs ?? {})) out.push({ label: `inputs.${name}`, detail: `Input "${name}"` })
  for (const step of parsed?.steps ?? []) {
    out.push({ label: `steps.${step.id}.summary`, detail: `Summary of step "${step.id}"` })
    out.push({ label: `steps.${step.id}.status`, detail: `Status of step "${step.id}"` })
    for (const field of Object.keys(step.output?.fields ?? {})) {
      out.push({ label: `steps.${step.id}.data.${field}`, detail: `Data field "${field}" of step "${step.id}"` })
    }
  }
  for (const field of TEMPLATE_RUN_FIELDS) out.push({ label: `run.${field}`, detail: `Run property "${field}"` })
  if (parsed?.item_input !== undefined) out.push({ label: 'item.', detail: `Field of each "${parsed.item_input}" item` })
  return out
}

export function templateCompletions(parsed: ParsedWorkflowDefinition | undefined, prefix: string): TemplateCompletion[] {
  return allCompletions(parsed).filter((c) => c.label.startsWith(prefix))
}
