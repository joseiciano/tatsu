export interface AttachStream {
  /** Called for every terminal:data chunk for this id from mount onward. */
  push(data: string): void
  /** The attach/create reply arrived. When `discardBuffered` is true,
   *  drop everything pushed so far (the reply's history already contains
   *  it); otherwise write the buffered chunks in order. Then go live. */
  beginLive(discardBuffered: boolean): void
}

export function createAttachStream(write: (data: string) => void): AttachStream {
  let live = false
  let buffered: string[] = []
  return {
    push(data) {
      if (live) write(data)
      else buffered.push(data)
    },
    beginLive(discardBuffered) {
      if (live) return
      live = true
      const pending = buffered
      buffered = []
      if (discardBuffered) return
      for (const chunk of pending) write(chunk)
    }
  }
}
