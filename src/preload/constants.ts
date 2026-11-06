export const PRELOAD_GLOBALS = {
  localTransport: '__tatsu_local_transport',
  electronHelpers: '__tatsu_electron_helpers',
  web: '__TATSU_WEB__',
  platform: '__TATSU_PLATFORM__'
} as const

export const IPC_CHANNELS = {
  stateGetSnapshot: 'state:getSnapshot',
  stateEvent: 'state:event',
  transportGetClientId: 'transport:getClientId',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close'
} as const
