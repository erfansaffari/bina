const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')

const IS_DEV = process.env.NODE_ENV === 'development' || !app.isPackaged
const API_PORT = 8765
const API_BASE = `http://127.0.0.1:${API_PORT}`

let mainWindow = null
let pythonProcess = null

// ---------------------------------------------------------------------------
// Python sidecar
// ---------------------------------------------------------------------------

function findPythonAndBackend() {
  if (app.isPackaged) {
    const resourcesPath = process.resourcesPath
    return {
      python: path.join(resourcesPath, 'backend', '.venv', 'bin', 'python3'),
      script: path.join(resourcesPath, 'backend', 'backend', 'api.py'),
    }
  }
  // Development: use the project-level venv
  const root = path.join(__dirname, '..', '..')
  return {
    python: path.join(root, '.venv', 'bin', 'python3'),
    script: path.join(root, 'backend', 'api.py'),
  }
}

function startPythonSidecar() {
  const { python, script } = findPythonAndBackend()
  console.log(`[sidecar] Starting: ${python} ${script} ${API_PORT}`)

  pythonProcess = spawn(python, [script, String(API_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  pythonProcess.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`))
  pythonProcess.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`))
  pythonProcess.on('exit', (code) => console.log(`[sidecar] exited: ${code}`))
}

function waitForApi(retries = 30, delay = 500) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`${API_BASE}/status`, (res) => {
        if (res.statusCode === 200) resolve()
        else attempt(n - 1)
      }).on('error', () => {
        if (n <= 0) return reject(new Error('API never started'))
        setTimeout(() => attempt(n - 1), delay)
      })
    }
    attempt(retries)
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    backgroundColor: '#0d0d0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  if (IS_DEV) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

function buildMenu() {
  const template = [
    {
      label: 'Bina',
      submenu: [
        { label: 'About Bina', role: 'about' },
        { type: 'separator' },
        { label: 'Hide Bina', accelerator: 'CmdOrCtrl+H', role: 'hide' },
        { label: 'Hide Others', accelerator: 'CmdOrCtrl+Alt+H', role: 'hideOthers' },
        { type: 'separator' },
        { label: 'Quit Bina', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        IS_DEV ? { role: 'toggleDevTools' } : null,
      ].filter(Boolean),
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose the folder Bina should watch',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('shell:openPath', async (_event, filePath) => {
  await shell.openPath(filePath)
})

ipcMain.handle('shell:showInFinder', async (_event, filePath) => {
  shell.showItemInFolder(filePath)
})

ipcMain.handle('api:get', async (_event, endpoint) => {
  return fetch(`${API_BASE}${endpoint}`).then(r => r.json())
})

ipcMain.handle('api:post', async (_event, endpoint, body) => {
  return fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json())
})

ipcMain.handle('api:delete', async (_event, endpoint, body) => {
  return fetch(`${API_BASE}${endpoint}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json())
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  buildMenu()
  startPythonSidecar()

  try {
    await waitForApi()
    console.log('[main] API ready')
  } catch (e) {
    console.error('[main] API failed to start:', e.message)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill('SIGTERM')
    pythonProcess = null
  }
})
