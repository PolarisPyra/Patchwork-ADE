const settings = { onboarded: true, theme: "dark", agents: ["claude"], integrations: { github: false, terminal: false, figma: false, browser: false }, projects: [], activeProjectId: null, shell: null, tokens: { showUsage: false, warnAbove: 150000, askBeforeResume: true, autoCompact: true, autoCompactAbove: 200000, defaultModels: {} } };
const responses = { get_settings: settings, list_threads: [], list_folders: [], get_last_thread: null, get_collapsed: [], git_changes: [] };
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd) => (cmd in responses ? responses[cmd] : null),
  transformCallback: () => 0,
  unregisterCallback: () => {},
  convertFileSrc: (p) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
};
