import { describe, expect, it } from 'vitest'
import type { MutuallyAssignable, WireEqual } from '.'

type HandWritten = { sessionId: string; model?: string }
type HandWrittenByAgent = Partial<Record<'claude' | 'codex', number>>

const same: WireEqual<{ sessionId: string; model?: string }, HandWritten> = true
const renamedOptionalKey: WireEqual<{ sessionId: string; label?: string }, HandWritten> = false
const missingField: WireEqual<{ model?: string }, HandWritten> = false
const widenedMapKey: WireEqual<Partial<Record<string, number>>, HandWrittenByAgent> = false
const plainCheckMissesRenamedOptionalKey: MutuallyAssignable<
  { sessionId: string; label?: string },
  HandWritten
> = true

describe('WireEqual', () => {
  it('accepts an equal shape and rejects drift that plain assignability misses', () => {
    expect({ same, renamedOptionalKey, missingField, widenedMapKey, plainCheckMissesRenamedOptionalKey }).toEqual({
      same: true,
      renamedOptionalKey: false,
      missingField: false,
      widenedMapKey: false,
      plainCheckMissesRenamedOptionalKey: true
    })
  })
})
