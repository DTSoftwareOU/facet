/** IPC channel names shared by the main process and the preload script. */
export const Ch = {
  deviceName: 'facet:device-name',
  secretsSeal: 'facet:secrets:seal',
  secretsOpen: 'facet:secrets:open',
  openExternal: 'facet:open-external',
  saveFile: 'facet:save-file',
  notify: 'facet:notify',
  /** main → renderer */
  notificationClick: 'facet:notification-click',

  oauthRedirectUri: 'facet:oauth:redirect-uri',
  oauthAuthorize: 'facet:oauth:authorize',
  oauthCancel: 'facet:oauth:cancel',

  computerInfo: 'facet:computer:info',
  computerTools: 'facet:computer:tools',
  computerCall: 'facet:computer:call',
  computerCancel: 'facet:computer:cancel',
  computerDefaultWorkspace: 'facet:computer:default-workspace',
  computerPickFolder: 'facet:computer:pick-folder',
  computerOpen: 'facet:computer:open',

  stdioSpawn: 'facet:stdio:spawn',
  stdioSend: 'facet:stdio:send',
  stdioKill: 'facet:stdio:kill',
  /** main → renderer: (handle, message) */
  stdioMessage: 'facet:stdio:message',
  /** main → renderer: (handle, code, stderr) */
  stdioExit: 'facet:stdio:exit',

  updatesState: 'facet:updates:state',
  updatesCheck: 'facet:updates:check',
  updatesInstall: 'facet:updates:install',
  /** main → renderer: (state) */
  updatesChanged: 'facet:updates:changed',

  hostSettings: 'facet:host:settings',
  hostSetSettings: 'facet:host:set-settings',
  /** main → renderer: (settings) */
  hostSettingsChanged: 'facet:host:settings-changed',
  hostListFolders: 'facet:host:list-folders',
  hostAgentSessions: 'facet:host:agent-sessions',
  hostReadAgentSession: 'facet:host:read-agent-session',
  hostSetBusy: 'facet:host:set-busy',
  hostActivity: 'facet:host:activity',
} as const;
