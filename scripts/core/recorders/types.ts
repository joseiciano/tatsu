export interface Recorder<C extends { name: string }, R> {
  path: string
  record: (fixture: C) => R | Promise<R>
  recordedOf: (fixture: C) => R | undefined
  withRecorded: (fixture: C, recorded: R) => C
}
