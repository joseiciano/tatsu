export const MAX_FILE_READ_BYTES = 2 * 1024 * 1024

export const CODE_DIFF_MAX_FILES = 2000

// Above either cap the code diff pane shows git's changed hunks instead of
// both full sides in the side-by-side editor.
export const CODE_DIFF_MAX_EDITOR_LINES = 20_000
export const CODE_DIFF_MAX_PATCH_BYTES = 512 * 1024

// Larger ceiling for binary viewers (images / PDFs) than the editor read
// path, which is meant for text editing.
export const MAX_FILE_BINARY_READ_BYTES = 50 * 1024 * 1024

export const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf'
}

export const MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024