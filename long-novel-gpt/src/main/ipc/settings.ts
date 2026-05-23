import { ipcMain, app, session } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import Store from 'electron-store'
import { getDatabase, getDbPath } from '../services/db'

const store = new Store()

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', async (_, key: string) => {
    return { success: true, data: store.get(key) }
  })

  ipcMain.handle('settings:set', async (_, { key, value }) => {
    store.set(key, value)
    return { success: true }
  })

  ipcMain.handle('settings:get-all', async () => {
    return { success: true, data: store.store }
  })

  ipcMain.handle('settings:get-db-path', async () => {
    return { success: true, data: getDbPath() }
  })

  ipcMain.handle('app:get-meta', async () => {
    return { success: true, data: { version: '1.0.0' } }
  })

  ipcMain.handle('settings:clear-cache', async () => {
    let removed = 0
    let skipped = 0

    // ── Cache size query ──
  ipcMain.handle('settings:get-cache-size', async () => {
    const userDataPath = app.getPath('userData')
    const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'blob_storage']
    let totalBytes = 0
    for (const dir of cacheDirs) {
      const fullPath = path.join(userDataPath, dir)
      try {
        if (fs.existsSync(fullPath)) {
          const walkDir = (p: string): number => {
            let size = 0
            for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
              const fp = path.join(p, entry.name)
              if (entry.isDirectory()) { size += walkDir(fp) }
              else { try { size += fs.statSync(fp).size } catch { /* locked */ } }
            }
            return size
          }
          totalBytes += walkDir(fullPath)
        }
      } catch { /* locked */ }
    }
    // Also include Electron session storage estimate
    try {
      const sizeEstimate = await session.defaultSession.getStorageData()
      if (sizeEstimate.quotas) {
        for (const q of sizeEstimate.quotas) {
          totalBytes += q.usage
        }
      }
    } catch { /* */ }
    return totalBytes
  })

  // Clear Electron in-memory caches (safe while running)
    try {
      await session.defaultSession.clearCache()
      await session.defaultSession.clearStorageData()
      await session.defaultSession.clearCodeCaches({})
      removed = 3
    } catch {
      // Non-fatal
    }

    // Clean disk cache directories — skip locked ones
    const userDataPath = app.getPath('userData')
    const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'blob_storage']
    for (const dir of cacheDirs) {
      const fullPath = path.join(userDataPath, dir)
      try {
        if (fs.existsSync(fullPath)) {
          fs.rmSync(fullPath, { recursive: true, force: true })
          removed++
        }
      } catch {
        skipped++ // Directory locked by running process — non-fatal
      }
    }

    return {
      success: true,
      data: { removed, skipped, message: `已清理 ${removed} 个缓存${skipped > 0 ? `，${skipped} 个需重启后清理` : ''}` }
    }
  })

  // ── Knowledge base path settings ──
  ipcMain.handle('settings:get-kb-paths', async () => {
    const db = getDatabase()
    const rows = db.prepare('SELECT key, value FROM kb_settings').all() as Array<{ key: string; value: string }>
    const result: Record<string, string> = {}
    for (const row of rows) result[row.key] = row.value
    return result
  })

  ipcMain.handle('settings:set-kb-path', async (_event, key: string, value: string) => {
    const db = getDatabase()
    db.prepare('INSERT OR REPLACE INTO kb_settings (key, value) VALUES (?, ?)').run(key, value)
    return { success: true }
  })
}