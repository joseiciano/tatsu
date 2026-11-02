export type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

export type WireEqual<A, B> =
  MutuallyAssignable<A, B> extends true ? MutuallyAssignable<keyof A, keyof B> : false
