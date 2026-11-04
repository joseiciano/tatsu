export type PickerKind = 'issue' | 'pr' | 'file'

export interface PickerOption {
  value: string
  label: string
  detail?: string
}

export type PickerStatus = 'loading' | 'ready' | 'error'

export type PickerSource =
  | { mode: 'combobox'; status: PickerStatus; options: PickerOption[] }
  | { mode: 'number' }
