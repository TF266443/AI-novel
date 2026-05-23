import { app, shell, BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log'
import { initDatabase, closeDatabase } from './services/db'

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192 --expose-gc')

// Trigger GC every 30s to clean up Strict Mode double-effects and IPC buffers
const gcInterval = setInterval(() => {
  try { (global as any).gc?.() } catch { /* */ }
}, 30_000)
app.on('before-quit', () => clearInterval(gcInterval))
import { registerDbHandlers } from './ipc/db'
import { registerFsHandlers } from './ipc/fs'
import { registerAiHandlers } from './ipc/ai'
import { registerContextHandlers } from './ipc/context'
import { registerSettingsHandlers } from './ipc/settings'

log.initialize()
log.transports.file.level = 'info'
log.transports.file.resolvePathFn = () => 'D:/AI/logs/app.log'
log.transports.console.level = 'debug'

import { mkdirSync } from 'fs'
try {
  mkdirSync('D:/AI/logs', { recursive: true })
} catch {
  // Directory may already exist
}

log.info('='.repeat(50))
log.info('Long Novel GPT starting...')
log.info('App version:', '1.0.0')
log.info('Electron version:', process.versions.electron)
log.info('Node version:', process.versions.node)
log.info('Platform:', process.platform)
log.info('='.repeat(50))

process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error)
  app.exit(1)
})

let mainWindow: BrowserWindow | null = null

function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建项目',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.send('menu:new-project')
          }
        },
        {
          label: '导入 TXT',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow?.webContents.send('menu:import-file')
          }
        },
        { type: 'separator' },
        {
          label: '导出',
          submenu: [
            {
              label: '逐章导出',
              click: () => {
                mainWindow?.webContents.send('menu:export-chapters')
              }
            },
            {
              label: '合并导出',
              click: () => {
                mainWindow?.webContents.send('menu:export-merged')
              }
            }
          ]
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click: () => {
            app.quit()
          }
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '分章',
          accelerator: 'CmdOrCtrl+1',
          click: () => {
            mainWindow?.webContents.send('menu:view-stage', 'split')
          }
        },
        {
          label: '\u573A\u666F\u8BC6\u522B',
          accelerator: 'CmdOrCtrl+2',
          click: () => {
            mainWindow?.webContents.send('menu:view-stage', 'scan')
          }
        },
        {
          label: '\u6539\u5199',
          accelerator: 'CmdOrCtrl+3',
          click: () => {
            mainWindow?.webContents.send('menu:view-stage', 'rewrite')
          }
        },
        {
          label: '预览',
          accelerator: 'CmdOrCtrl+4',
          click: () => {
            mainWindow?.webContents.send('menu:view-stage', 'preview')
          }
        },
        {
          label: '\u5BFC\u51FA',
          accelerator: 'CmdOrCtrl+5',
          click: () => {
            mainWindow?.webContents.send('menu:view-stage', 'export')
          }
        },
        { type: 'separator' },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            const { dialog } = require('electron')
            dialog.showMessageBox({
              type: 'info',
              title: '关于 Long Novel GPT',
              message: 'Long Novel GPT v1.0.0',
              detail: 'AI 小说改写工具\n\n基于 Electron + React + TypeScript 构建'
            })
          }
        },
        {
          label: '日志文件',
          click: () => {
            shell.openPath('D:/AI/logs/app.log')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  log.info('Application menu created')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    log.info('Main window ready and shown')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.longnovelgpt.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDatabase()

  registerDbHandlers()
  registerFsHandlers()
  registerAiHandlers()
  registerContextHandlers()
  registerSettingsHandlers()

  createMenu()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  closeDatabase()
  log.info('Application closing')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})