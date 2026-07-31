import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { RadioManager } from './manager.js'
import { registerIpc } from './ipc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Keep external links out of the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

// Radios present a self-signed certificate. Accept it for the radio hosts we talk to; every
// other origin still goes through normal verification.
app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  try {
    const host = new URL(url).hostname
    const known = new Set(storeRef?.radios.map((r) => r.host) ?? [])
    const isPrivate =
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host)
    if (known.has(host) || isPrivate) {
      event.preventDefault()
      callback(true)
      return
    }
  } catch {
    /* fall through to the default */
  }
  callback(false)
})

let storeRef: Store | null = null

app.whenReady().then(() => {
  const store = new Store()
  storeRef = store
  const manager = new RadioManager(store)

  registerIpc(store, manager, () => mainWindow)
  mainWindow = createWindow()
  manager.startPolling()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  app.on('before-quit', () => manager.stopPolling())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
