import { ipcMain } from 'electron'
import { getDatabase } from '../services/db'
import { nanoid } from 'nanoid'
import log from 'electron-log'

export function registerDbHandlers(): void {
  log.info('Registering DB handlers')

  ipcMain.handle('db:query', async (_, { table, condition, params, columns }) => {
    try {
      const db = getDatabase()
      const cols = columns || '*'
      let sql = `SELECT ${cols} FROM ${table}`
      if (condition) {
        sql += ` WHERE ${condition}`
      }
      const stmt = db.prepare(sql)
      const result = stmt.all(...(params || []))
      // [OOM-PROBE] measure payload size; warn on suspiciously large results
      let bytes = 0
      try { bytes = JSON.stringify(result).length } catch { bytes = -1 }
      log.info(`DB query: ${table}, rows=${result.length}, bytes=${bytes}, condition=${condition || '(none)'}`)
      if (bytes > 5_000_000) {
        log.warn(`[OOM-RISK] ${table} returned ${(bytes / 1e6).toFixed(1)}MB without LIMIT (condition=${condition || 'none'})`)
      }
      return { success: true, data: result }
    } catch (error) {
      log.error(`DB query error on ${table}:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:mutation', async (_, { table, operation, data, condition, params }) => {
    try {
      const db = getDatabase()
      let result
      switch (operation) {
        case 'insert': {
          // Use provided id if present, otherwise generate
          const id = data.id || nanoid()
          const now = new Date().toISOString()
          const columns = Object.keys(data).filter(k => k !== 'id')
          const values = columns.map(k => data[k])
          const placeholders = values.map(() => '?').join(', ')
          const sql = `INSERT INTO ${table} (id, ${columns.join(', ')}, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?)`
          const stmt = db.prepare(sql)
          stmt.run(id, ...values, now, now)
          result = { id }
          log.info(`DB insert: ${table}, id=${id}`)
          break
        }
        case 'update': {
          const now = new Date().toISOString()
          const setClause = Object.keys(data).map(k => `${k} = ?`).join(', ')
          let sql = `UPDATE ${table} SET ${setClause}, updated_at = ?`
          if (condition) {
            sql += ` WHERE ${condition}`
          }
          const stmt = db.prepare(sql)
          const allParams = [...Object.values(data), now, ...(params || [])]
          stmt.run(...allParams)
          result = { changes: db.changes }
          log.info(`DB update: ${table}, changes=${db.changes}`)
          break
        }
        case 'delete': {
          let sql = `DELETE FROM ${table}`
          if (condition) {
            sql += ` WHERE ${condition}`
          }
          const stmt = db.prepare(sql)
          stmt.run(...(params || []))
          result = { changes: db.changes }
          log.info(`DB delete: ${table}, changes=${db.changes}`)
          break
        }
        default:
          throw new Error(`Unknown operation: ${operation}`)
      }
      return { success: true, data: result }
    } catch (error) {
      log.error(`DB mutation error: ${operation} on ${table}:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:batch', async (_, operations) => {
    const db = getDatabase()
    const results: Array<{success: boolean, data?: unknown, error?: string}> = []

    const transaction = db.transaction(() => {
      for (const op of operations) {
        try {
          const { table, operation, data, condition, params } = op
          let result

          switch (operation) {
            case 'insert': {
              const id = data.id || nanoid()
              const now = new Date().toISOString()
              const columns = Object.keys(data).filter(k => k !== 'id')
              const values = columns.map(k => data[k])
              const placeholders = values.map(() => '?').join(', ')
              const sql = `INSERT INTO ${table} (id, ${columns.join(', ')}, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?)`
              const stmt = db.prepare(sql)
              stmt.run(id, ...values, now, now)
              result = { id }
              break
            }
            case 'update': {
              const now = new Date().toISOString()
              const setClause = Object.keys(data).map(k => `${k} = ?`).join(', ')
              let sql = `UPDATE ${table} SET ${setClause}, updated_at = ?`
              if (condition) sql += ` WHERE ${condition}`
              const stmt = db.prepare(sql)
              const allParams = [...Object.values(data), now, ...(params || [])]
              stmt.run(...allParams)
              result = { changes: db.changes }
              break
            }
            case 'delete': {
              let sql = `DELETE FROM ${table}`
              if (condition) sql += ` WHERE ${condition}`
              const stmt = db.prepare(sql)
              stmt.run(...(params || []))
              result = { changes: db.changes }
              break
            }
          }
          results.push({ success: true, data: result })
        } catch (error) {
          results.push({ success: false, error: (error as Error).message })
        }
      }
    })

    transaction()

    return results.every(r => r.success)
      ? { success: true, data: results }
      : { success: false, error: 'Batch operation failed', results }
  })
}