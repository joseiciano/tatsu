export const PRELOAD_GLOBALS = {
  localTransport: '__harness_local_transport',
  electronHelpers: '__harness_electron_helpers',
  web: '__HARNESS_WEB__',
  platform: '__HARNESS_PLATFORM__'
} as const

export const IPC_CHANNELS = {
  stateGetSnapshot: 'state:getSnapshot',
  stateEvent: 'state:event',
  transportGetClientId: 'transport:getClientId',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close'
} as const
