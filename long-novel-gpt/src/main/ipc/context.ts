import { ipcMain } from 'electron'
import { getDatabase } from '../services/db'
import { nanoid } from 'nanoid'
import log from 'electron-log'

interface CharacterUpdate {
  name: string
  state_snapshot: {
    appearance?: string
    emotion?: string
    location?: string
    status?: string
    relationships?: Record<string, string>
  }
  chapterIndex: number
}

interface ChapterSummaryData {
  plot_summary: string
  additions: Array<{ type: string, content: string }>
  scene_summary?: string
}

export function registerContextHandlers(): void {
  log.info('Registering Context handlers')

  ipcMain.handle('context:get-states', async (_, projectId: string) => {
    log.info(`Context: Getting character states for project ${projectId}`)
    const db = getDatabase()
    try {
      const stmt = db.prepare(`
        SELECT * FROM character_state
        WHERE project_id = ? AND locked = 0
        ORDER BY updated_at DESC
      `)
      const characters = stmt.all(projectId)
      log.info(`Context: Found ${characters.length} character states`)
      return { success: true, data: characters }
    } catch (error) {
      log.error(`Context: Failed to get character states:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('context:update-states', async (_, { projectId, updates }: { projectId: string, updates: CharacterUpdate[] }) => {
    log.info(`Context: Updating ${updates.length} character states for project ${projectId}`)
    const db = getDatabase()
    try {
      for (const update of updates) {
        const existing = db.prepare(
          'SELECT id FROM character_state WHERE project_id = ? AND name = ?'
        ).get(projectId, update.name) as { id: string } | undefined

        if (existing) {
          db.prepare(`
            UPDATE character_state
            SET state_snapshot = ?, updated_at = ?, updated_from_chapter = ?
            WHERE id = ?
          `).run(JSON.stringify(update.state_snapshot), new Date().toISOString(), update.chapterIndex, existing.id)
          log.debug(`Context: Updated character ${update.name}`)
        } else {
          const id = nanoid()
          db.prepare(`
            INSERT INTO character_state (id, project_id, name, state_snapshot, source, updated_at, updated_from_chapter)
            VALUES (?, ?, ?, ?, 'auto', ?, ?)
          `).run(id, projectId, update.name, JSON.stringify(update.state_snapshot), new Date().toISOString(), update.chapterIndex)
          log.debug(`Context: Created new character ${update.name}`)
        }
      }
      return { success: true }
    } catch (error) {
      log.error(`Context: Failed to update character states:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('context:get-chain', async (_, { projectId, beforeChapter }: { projectId: string, beforeChapter: number }) => {
    log.info(`Context: Getting chapter summary chain for project ${projectId}, before chapter ${beforeChapter}`)
    const db = getDatabase()
    try {
      const stmt = db.prepare(`
        SELECT cs.chapter_id, cs.plot_summary, cs.additions, cs.created_at,
               c.chapter_index
        FROM chapter_summaries cs
        JOIN chapters c ON cs.chapter_id = c.id
        WHERE cs.project_id = ? AND c.chapter_index < ?
        ORDER BY c.chapter_index ASC
      `)
      const summaries = stmt.all(projectId, beforeChapter)
      log.info(`Context: Found ${summaries.length} chapter summaries`)
      return { success: true, data: summaries.slice(-50) }
    } catch (error) {
      log.error(`Context: Failed to get chapter summary chain:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Load a single chapter summary (on-demand)
  ipcMain.handle('context:get-summary', async (_, { projectId, chapterId }: { projectId: string; chapterId: string }) => {
    const db = getDatabase()
    try {
      const row = db.prepare(
        'SELECT id, chapter_id, plot_summary, additions, scene_summary, created_at FROM chapter_summaries WHERE project_id = ? AND chapter_id = ?'
      ).get(projectId, chapterId) as any
      return { success: true, data: row || null }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('context:lock-state', async (_, characterId: string, locked: boolean) => {
    log.info(`Context: ${locked ? 'Locking' : 'Unlocking'} character state ${characterId}`)
    const db = getDatabase()
    try {
      db.prepare('UPDATE character_state SET locked = ? WHERE id = ?').run(locked ? 1 : 0, characterId)
      return { success: true }
    } catch (error) {
      log.error(`Context: Failed to lock/unlock character state:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('context:save-summary', async (_, { projectId, chapterId, summary }: { projectId: string, chapterId: string, summary: ChapterSummaryData }) => {
    log.info(`Context: Saving chapter summary for chapter ${chapterId}`)
    const db = getDatabase()
    try {
      const id = nanoid()
      db.prepare(`
        INSERT INTO chapter_summaries (id, project_id, chapter_id, plot_summary, additions, scene_summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, chapterId, summary.plot_summary, JSON.stringify(summary.additions), summary.scene_summary || null, new Date().toISOString())
      log.info(`Context: Chapter summary saved, id=${id}`)
      return { success: true, data: { id } }
    } catch (error) {
      log.error(`Context: Failed to save chapter summary:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('context:get-manual-scenes', async (_, projectId: string) => {
    log.info(`Context: Getting manual scene markers for project ${projectId}`)
    const db = getDatabase()
    try {
      const stmt = db.prepare(`
        SELECT c.id as chapter_id, c.chapter_index, p.content, p.scene_tags
        FROM chapters c
        JOIN paragraphs p ON c.id = p.chapter_id
        WHERE c.project_id = ? AND p.scene_tags LIKE '%"source":"manual"%'
      `)
      const results = stmt.all(projectId)
      return { success: true, data: results }
    } catch (error) {
      log.error(`Context: Failed to get manual scenes:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  // ── Memory persistence ──
  ipcMain.handle('context:save-meta', async (_, { projectId, chapterIndex, meta }: {
    projectId: string; chapterIndex: number;
    meta: { foreshadowing?: string[]; items?: Array<{ name: string; owner?: string }>; powerUpdates?: Array<{ name: string; realm?: string; stage?: string }> }
  }) => {
    log.info(`Context: Saving memory meta for project ${projectId} chapter ${chapterIndex}`)
    const db = getDatabase()
    const now = new Date().toISOString()
    try {
      // Save foreshadowing
      if (meta.foreshadowing) {
        for (const f of meta.foreshadowing) {
          db.prepare('INSERT INTO foreshadowing (id, project_id, content, planted_in, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(Date.now().toString() + Math.random().toString(36).slice(2), projectId, f, chapterIndex, 'pending', now)
        }
      }
      // Save items
      if (meta.items) {
        for (const item of meta.items) {
          db.prepare('INSERT INTO items (id, project_id, name, owner, chapter_index, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(Date.now().toString() + Math.random().toString(36).slice(2), projectId, item.name, item.owner || null, chapterIndex, now)
        }
      }
      // Save power updates
      if (meta.powerUpdates) {
        for (const p of meta.powerUpdates) {
          db.prepare('INSERT INTO power_levels (id, project_id, character_name, realm, stage, chapter_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(Date.now().toString() + Math.random().toString(36).slice(2), projectId, p.name, p.realm || null, p.stage || null, chapterIndex, now)
        }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('context:get-memory', async (_, { projectId }: { projectId: string }) => {
    const db = getDatabase()
    try {
      const foreshadowing = db.prepare('SELECT * FROM foreshadowing WHERE project_id = ? AND status = ? ORDER BY planted_in ASC').all(projectId, 'pending')
      const items = db.prepare('SELECT * FROM items WHERE project_id = ? AND status = ? ORDER BY chapter_index DESC').all(projectId, 'active')
      const powerLevels = db.prepare('SELECT * FROM power_levels WHERE project_id = ? ORDER BY chapter_index DESC').all(projectId)
      return { success: true, data: { foreshadowing, items, powerLevels } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}