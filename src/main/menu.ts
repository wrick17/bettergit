import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { ThemeMode } from './config'

// Menu commands that need renderer state (the selected repo, the open tab) are forwarded as actions.
export type MenuAction =
  | 'add-folder'
  | 'clone'
  | 'refresh'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'stash'
  | 'show-changes'
  | 'show-history'
  | 'find'
  | 'search-history'
  | 'toggle-sidebar'
  | 'reveal-repo'
  | 'fetch-all'
  | 'open-settings'

interface MenuHandlers {
  send: (action: MenuAction) => void
  setTheme: (theme: ThemeMode) => void
  currentTheme: () => ThemeMode
  checkForUpdates: () => void
}

export function buildMenu(handlers: MenuHandlers): Menu {
  const theme = handlers.currentTheme()
  const themeItem = (mode: ThemeMode, label: string): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: theme === mode,
    click: () => handlers.setTheme(mode),
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: handlers.checkForUpdates },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => handlers.send('open-settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Add folder…', accelerator: 'Cmd+O', click: () => handlers.send('add-folder') },
        { label: 'Clone Repository…', accelerator: 'Cmd+Shift+N', click: () => handlers.send('clone') },
        { type: 'separator' },
        { label: 'Reveal in Finder', accelerator: 'Cmd+Shift+R', click: () => handlers.send('reveal-repo') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        // Find searches the diffs on screen; its next and previous keys (⌘G, ⇧⌘G) are handled by the find bar itself.
        { label: 'Find…', accelerator: 'Cmd+F', click: () => handlers.send('find') },
        { label: 'Find in History', accelerator: 'Alt+Cmd+F', click: () => handlers.send('search-history') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Cmd+Shift+S', click: () => handlers.send('toggle-sidebar') },
        { type: 'separator' },
        { label: 'Changes', accelerator: 'Cmd+1', click: () => handlers.send('show-changes') },
        { label: 'History', accelerator: 'Cmd+2', click: () => handlers.send('show-history') },
        { type: 'separator' },
        { label: 'Appearance', submenu: [themeItem('system', 'System'), themeItem('light', 'Light'), themeItem('dark', 'Dark')] },
        { type: 'separator' },
        { role: 'reload', label: 'Reload UI', accelerator: 'CmdOrCtrl+Alt+R' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Repository',
      submenu: [
        { label: 'Refresh', accelerator: 'Cmd+R', click: () => handlers.send('refresh') },
        { type: 'separator' },
        { label: 'Fetch', accelerator: 'Cmd+Shift+F', click: () => handlers.send('fetch') },
        { label: 'Pull', accelerator: 'Cmd+Shift+L', click: () => handlers.send('pull') },
        { label: 'Push', accelerator: 'Cmd+Shift+P', click: () => handlers.send('push') },
        { type: 'separator' },
        { label: 'Stash Changes', accelerator: 'Cmd+Shift+H', click: () => handlers.send('stash') },
        { type: 'separator' },
        { label: 'Fetch All Repositories', click: () => handlers.send('fetch-all') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
