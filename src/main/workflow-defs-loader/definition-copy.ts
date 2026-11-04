import { isMap, isScalar, parseDocument } from 'yaml'

export const MAX_COPY_ATTEMPTS = 100

export function copyNameCandidates(name: string): string[] {
  const base = `${name.trim()}-copy`
  return Array.from({ length: MAX_COPY_ATTEMPTS }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`))
}

export function renameDefinitionSource(source: string, name: string): string {
  const doc = parseDocument(source, { uniqueKeys: true, prettyErrors: false })
  if (doc.errors.length > 0 || !isMap(doc.contents)) return source
  const pair = doc.contents.items.find((item) => isScalar(item.key) && item.key.value === 'name')
  const range = pair && isScalar(pair.value) ? pair.value.range : null
  if (range) {
    const spliced = `${source.slice(0, range[0])}${JSON.stringify(name)}${source.slice(range[1])}`
    if (topLevelName(spliced) === name) return spliced
  }
  doc.set('name', name)
  return String(doc)
}

function topLevelName(source: string): unknown {
  const doc = parseDocument(source, { uniqueKeys: true, prettyErrors: false })
  return doc.errors.length === 0 && isMap(doc.contents) ? doc.get('name') : undefined
}
