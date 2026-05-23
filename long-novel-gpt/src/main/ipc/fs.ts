import { ipcMain, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import jschardet from 'jschardet'
import iconv from 'iconv-lite'
import log from 'electron-log'

export function registerFsHandlers(): void {
  log.info('Registering FS handlers')

  ipcMain.handle('fs:read-file', async (_, filePath: string) => {
    log.info(`FS: Reading file: ${filePath}`)
    try {
      const buffer = fs.readFileSync(filePath)
      const detected = jschardet.detect(buffer)
      const encoding = detected.encoding || 'utf-8'
      log.info(`FS: Detected encoding ${encoding} for ${filePath}`)

      let content: string
      const enc = encoding.toLowerCase()
      if (enc === 'gb2312' || enc === 'gb-2312' || enc === 'gbk' || enc === 'gb18030') {
        content = iconv.decode(buffer, 'gb18030')
      } else {
        content = buffer.toString('utf-8')
      }

      log.info(`FS: File read successfully, size=${buffer.length} bytes`)
      return { success: true, data: { content, encoding } }
    } catch (error) {
      log.error(`FS: Failed to read file ${filePath}:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('fs:detect-encoding', async (_, filePath: string) => {
    try {
      const buffer = fs.readFileSync(filePath)
      const detected = jschardet.detect(buffer)
      return { success: true, data: { encoding: detected.encoding, confidence: detected.confidence } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('fs:save-file', async (_, { filePath, content }) => {
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(filePath, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('fs:select-file', async (_, options: { title?: string, filters?: Array<{name: string, extensions: string[]}> }) => {
    log.info(`FS: Opening file dialog: ${options.title || 'Select File'}`)
    try {
      const result = await dialog.showOpenDialog({
        title: options.title || 'Select File',
        filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
        properties: ['openFile']
      })

      if (result.canceled || result.filePaths.length === 0) {
        log.info('FS: No file selected')
        return { success: false, error: 'No file selected' }
      }

      log.info(`FS: File selected: ${result.filePaths[0]}`)
      return { success: true, data: { filePath: result.filePaths[0] } }
    } catch (error) {
      log.error('FS: File dialog error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('fs:select-save-file', async (_, options: { title?: string, defaultPath?: string, filters?: Array<{name: string, extensions: string[]}> }) => {
    log.info(`FS: Opening save dialog: ${options.title || 'Save File'}`)
    try {
      const result = await dialog.showSaveDialog({
        title: options.title || 'Save File',
        defaultPath: options.defaultPath,
        filters: options.filters || [{ name: 'JSON Files', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) {
        log.info('FS: Save dialog canceled')
        return { success: false, error: 'No file path selected' }
      }
      log.info(`FS: Save path selected: ${result.filePath}`)
      return { success: true, data: { filePath: result.filePath } }
    } catch (error) {
      log.error('FS: Save dialog error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('fs:select-directory', async (_, options: { title?: string }) => {
    try {
      const result = await dialog.showOpenDialog({
        title: options.title || 'Select Directory',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'No directory selected' }
      }
      return { success: true, data: { dirPath: result.filePaths[0] } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // ── Chapter splitting ──
  ipcMain.handle('fs:split-text-into-chapters', async (_, content: string) => {
    const result = splitChapters(content)
    log.info(`FS: Split into ${result.length} chapters`)
    return { success: true, data: result }
  })
}

// ──────────────────────────────────────────
// Chapter splitting — line-based (参考 novel-expander-0)
// ──────────────────────────────────────────
interface ChapterItem {
  index: number
  title: string
  content: string
}

/** Heading patterns — must match the ENTIRE trimmed line */
const headingRegexes: RegExp[] = [
  /^第[零一二三四五六七八九十百千万\d]+章\s*.*$/,
  /^第\s*\d+\s*章\s*.*$/,
  /^[Cc]hapter\s+\d+.*$/,
  /^[Cc]h\.\s*\d+.*$/,
  /^第[零一二三四五六七八九十百千万\d]+[章节卷].*$/,
  /^(楔子|序章|序言|尾声|终章|后记|附录|番外).*$/,
]

/** Exclusion patterns — these look like headings but aren't */
const excludeRegexes: RegExp[] = [
  /^第[零一二三四五六七八九十百千万\d]+[个位次名篇种条项]/,
]

function isHeading(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 100) return false
  if (excludeRegexes.some(r => r.test(trimmed))) return false
  return headingRegexes.some(r => r.test(trimmed))
}

function splitChapters(content: string): ChapterItem[] {
  const lines = content.split(/\r?\n/)

  // Find all heading line indices
  const headingIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      headingIndices.push(i)
    }
  }

  // No headings — whole text as one chapter
  if (headingIndices.length === 0) {
    return [{
      index: 1,
      title: '全文',
      content: content.trim(),
    }]
  }

  const chapters: ChapterItem[] = []

  for (let i = 0; i < headingIndices.length; i++) {
    const startLine = headingIndices[i]
    const endLine = i + 1 < headingIndices.length
      ? headingIndices[i + 1]
      : lines.length

    const title = lines[startLine].trim()
    // Content starts from the line AFTER the heading
    const contentLines = lines.slice(startLine + 1, endLine)
    const body = contentLines.join('\n').trim()

    if (body.length > 0 || i === headingIndices.length - 1) {
      chapters.push({
        index: i + 1,
        title,
        content: body,
      })
    }
  }

  return chapters
}
