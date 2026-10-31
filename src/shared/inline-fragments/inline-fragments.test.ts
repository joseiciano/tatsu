import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'

import { stripLegacyTemplateMarker } from '../harness-template-render'
import { expandInlineFragments, inlineFragmentNames, resolveInlineFragmentEdit } from '.'

function sha12(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex').slice(0, 12)
}

function region(name: string, body: string, sha = sha12(body)): string[] {
  return [`<!-- tatsu:fragment ${name} sha=${sha} -->`, ...body.split('\n'), `<!-- /tatsu:fragment ${name} -->`]
}

const fragments = new Map([
  ['style', 'Prefer small diffs.\nKeep commits atomic.\n'],
  ['safety', 'Never push to main.']
])

describe('expandInlineFragments', () => {
  it('returns the input itself when it has no placeholders or markers', () => {
    for (const input of ['plain\nbody\n', 'line one\r\nline two\r\n', '﻿---\r\nname: x\r\n---\r\nbody\r\n', '']) {
      expect(expandInlineFragments(input, fragments)).toEqual({ content: input, fragments: [], edited: [], errors: [] })
    }
  })

  it('replaces a placeholder line with a marked section hashed from the trimmed fragment text', () => {
    const result = expandInlineFragments('Intro\n{{fragment:style}}\nOutro\n', fragments)
    expect(result.errors).toEqual([])
    expect(result.fragments).toEqual(['style'])
    expect(result.content).toBe(
      ['Intro', ...region('style', 'Prefer small diffs.\nKeep commits atomic.'), 'Outro', ''].join('\n')
    )
  })

  it('keeps the BOM and frontmatter of the file', () => {
    const input = '﻿---\nname: x\n---\n  {{fragment:safety}}  \n'
    expect(expandInlineFragments(input, fragments).content).toBe(
      ['﻿---', 'name: x', '---', ...region('safety', 'Never push to main.'), ''].join('\n')
    )
  })

  it('is idempotent', () => {
    const input = '---\nname: x\n---\n{{fragment:style}}\n\nMiddle\n{{fragment:safety}}\n'
    const once = expandInlineFragments(input, fragments)
    const twice = expandInlineFragments(once.content, fragments)
    expect(twice.content).toBe(once.content)
    expect(twice.edited).toEqual([])
    expect(twice.fragments).toEqual(['safety', 'style'])
  })

  it('refreshes an untouched section when its fragment changes', () => {
    const expanded = expandInlineFragments('A\n{{fragment:safety}}\nB\n', fragments).content
    const changed = new Map([['safety', 'Never force-push.\nAsk first.']])
    const result = expandInlineFragments(expanded, changed)
    expect(result.edited).toEqual([])
    expect(result.content).toBe(['A', ...region('safety', 'Never force-push.\nAsk first.'), 'B', ''].join('\n'))
  })

  it('leaves an untouched section byte-identical when its fragment is unchanged', () => {
    const expanded = ['Top', ...region('safety', 'Never push to main.'), 'Bottom'].join('\n')
    expect(expandInlineFragments(expanded, fragments).content).toBe(expanded)
  })

  it('keeps a hand-edited section and reports it, while refreshing others', () => {
    const input = [
      ...region('style', 'Prefer huge diffs.', sha12('Prefer small diffs.')),
      ...region('safety', 'Old safety text.'),
      ''
    ].join('\n')
    const result = expandInlineFragments(input, fragments)
    expect(result.errors).toEqual([])
    expect(result.edited).toEqual(['style'])
    expect(result.content).toBe(
      [
        ...region('style', 'Prefer huge diffs.', sha12('Prefer small diffs.')),
        ...region('safety', 'Never push to main.'),
        ''
      ].join('\n')
    )
  })

  it('does not treat CRLF or trailing whitespace in a section as an edit', () => {
    const body = 'Prefer small diffs.\nKeep commits atomic.'
    const sha = sha12(body)
    const crlf = [`<!-- tatsu:fragment style sha=${sha} -->`, 'Prefer small diffs.', 'Keep commits atomic.', '<!-- /tatsu:fragment style -->', ''].join('\r\n')
    const trailing = [`<!-- tatsu:fragment style sha=${sha} -->`, '', 'Prefer small diffs.', 'Keep commits atomic.   ', '', '<!-- /tatsu:fragment style -->'].join('\n')
    expect(expandInlineFragments(crlf, fragments).edited).toEqual([])
    expect(expandInlineFragments(trailing, fragments).edited).toEqual([])
  })

  it('never expands frontmatter, fenced code, escaped placeholders, or inline code', () => {
    const input = [
      '---',
      'note: {{fragment:style}}',
      '{{fragment:style}}',
      '---',
      '```md',
      '{{fragment:style}}',
      '```',
      '~~~~',
      '{{fragment:style}}',
      '~~~',
      '{{fragment:style}}',
      '~~~~',
      '\\{{fragment:style}}',
      'Write `{{fragment:style}}` on its own line.',
      ''
    ].join('\n')
    expect(expandInlineFragments(input, fragments)).toEqual({ content: input, fragments: [], edited: [], errors: [] })
  })

  it('maps each malformed input to its error code and returns the input unchanged', () => {
    const cases: { name: string; input: string; frags?: Map<string, string>; code: string; line: number }[] = [
      { name: 'placeholder mid-line', input: 'ok\nSee {{fragment:style}} here\n', code: 'misplaced-placeholder', line: 2 },
      { name: 'two placeholders on one line', input: '{{fragment:style}} {{fragment:safety}}\n', code: 'misplaced-placeholder', line: 1 },
      { name: 'unknown fragment', input: '{{fragment:style}}\n{{fragment:nope}}\n', code: 'unknown-fragment', line: 2 },
      {
        name: 'fragment containing a placeholder',
        input: '{{fragment:outer}}\n',
        frags: new Map([['outer', 'x\n{{fragment:style}}']]),
        code: 'nested-fragment',
        line: 1
      },
      {
        name: 'fragment containing a marker',
        input: '{{fragment:outer}}\n',
        frags: new Map([['outer', '<!-- /tatsu:fragment style -->']]),
        code: 'nested-fragment',
        line: 1
      },
      {
        name: 'open marker without close',
        input: `{{fragment:style}}\n<!-- tatsu:fragment safety sha=${sha12('Never push to main.')} -->\nNever push to main.\n`,
        code: 'unbalanced-marker',
        line: 2
      },
      { name: 'stray close marker', input: 'text\n<!-- /tatsu:fragment safety -->\n', code: 'unbalanced-marker', line: 2 },
      {
        name: 'close marker naming another fragment',
        input: `<!-- tatsu:fragment safety sha=${sha12('Never push to main.')} -->\nNever push to main.\n<!-- /tatsu:fragment style -->\n`,
        code: 'unbalanced-marker',
        line: 1
      }
    ]
    for (const testCase of cases) {
      const result = expandInlineFragments(testCase.input, testCase.frags ?? fragments)
      expect(result.content, testCase.name).toBe(testCase.input)
      expect(result.errors.map(({ code, line }) => ({ code, line })), testCase.name).toContainEqual({
        code: testCase.code,
        line: testCase.line
      })
    }
  })

  it('reports errors sorted by line', () => {
    const result = expandInlineFragments('{{fragment:a}}\nSee {{fragment:b}}\n{{fragment:c}}\n', new Map())
    expect(result.errors.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: 'unknown-fragment', line: 1 },
      { code: 'misplaced-placeholder', line: 2 },
      { code: 'unknown-fragment', line: 3 }
    ])
  })

  it('writes a marker that legacy template marker stripping leaves in place', () => {
    const expanded = expandInlineFragments('---\nname: x\n---\n{{fragment:style}}\n', fragments).content
    expect(expanded.split('\n')[3]).toMatch(/^<!-- tatsu:fragment style /)
    const bodyOnly = expandInlineFragments('{{fragment:safety}}\n', fragments).content
    expect(stripLegacyTemplateMarker(bodyOnly)).toBe(bodyOnly)
  })
})

describe('inlineFragmentNames', () => {
  it('lists names from placeholders and markers, sorted and deduplicated, ignoring fenced code', () => {
    const input = [
      '{{fragment:zeta}}',
      ...region('alpha', 'body'),
      '{{fragment:zeta}}',
      '```',
      '{{fragment:fenced}}',
      ...region('fenced-region', 'x'),
      '```',
      '{{fragment:mid}}'
    ].join('\n')
    expect(inlineFragmentNames(input)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('lists nothing for a file without placeholders or markers', () => {
    expect(inlineFragmentNames('---\nname: x\n---\nbody\n')).toEqual([])
  })
})

describe('resolveInlineFragmentEdit', () => {
  const staleSha = sha12('Prefer small diffs.\nKeep commits atomic.')
  const input = [
    'Intro',
    ...region('style', 'My own style.\nEdited.', staleSha),
    ...region('style', 'Prefer small diffs.\nKeep commits atomic.'),
    ...region('safety', 'Hand edit on safety.', sha12('Never push to main.')),
    '{{fragment:safety}}',
    ''
  ].join('\n')
  const untouchedTail = [
    ...region('style', 'Prefer small diffs.\nKeep commits atomic.'),
    ...region('safety', 'Hand edit on safety.', sha12('Never push to main.')),
    '{{fragment:safety}}',
    ''
  ]

  it('overwrite restores the fragment text in the edited section only', () => {
    const result = resolveInlineFragmentEdit(input, 'style', 'overwrite', 'New style.')
    expect(result.fragmentContent).toBeUndefined()
    expect(result.content).toBe(['Intro', ...region('style', 'New style.'), ...untouchedTail].join('\n'))
  })

  it('detach drops the markers and keeps the edited text', () => {
    const result = resolveInlineFragmentEdit(input, 'style', 'detach', 'ignored')
    expect(result.fragmentContent).toBeUndefined()
    expect(result.content).toBe(['Intro', 'My own style.', 'Edited.', ...untouchedTail].join('\n'))
  })

  it('keep-edit returns the edited text and rewrites the marker hash', () => {
    const result = resolveInlineFragmentEdit(input, 'style', 'keep-edit', 'ignored')
    expect(result.fragmentContent).toBe('My own style.\nEdited.')
    expect(result.content).toBe(['Intro', ...region('style', 'My own style.\nEdited.'), ...untouchedTail].join('\n'))
  })

  it('after keep-edit, expanding with the kept text reports no edits for that fragment', () => {
    const doc = ['A', ...region('style', 'Rewritten by hand.  \n', staleSha), 'B', ''].join('\n')
    const kept = resolveInlineFragmentEdit(doc, 'style', 'keep-edit', 'Prefer small diffs.\nKeep commits atomic.')
    const reexpanded = expandInlineFragments(kept.content, new Map([['style', kept.fragmentContent!]]))
    expect(reexpanded.errors).toEqual([])
    expect(reexpanded.edited).toEqual([])
    expect(reexpanded.content).toBe(kept.content)
  })

  it('keeps the BOM of the file', () => {
    const doc = '﻿' + region('safety', 'Edited.', sha12('Never push to main.')).join('\n')
    expect(resolveInlineFragmentEdit(doc, 'safety', 'detach', '').content).toBe('﻿Edited.')
  })
})
