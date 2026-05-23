import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  db: {
    query: (table: string, condition?: string, params?: unknown[], columns?: string) =>
      ipcRenderer.invoke('db:query', { table, condition, params, columns }),
    mutation: (table: string, operation: 'insert' | 'update' | 'delete', data: unknown, condition?: string, params?: unknown[]) =>
      ipcRenderer.invoke('db:mutation', { table, operation, data, condition, params }),
    batch: (operations: Array<{
      table: string
      operation: string
      data?: unknown
      condition?: string
      params?: unknown[]
    }>) => ipcRenderer.invoke('db:batch', operations)
  },

  ai: {
    stream: (request: {
      id: string
      modelId: string
      baseUrl: string
      apiKey: string
      messages: Array<{ role: string, content: string }>
      temperature?: number
      maxTokens?: number
    }) => ipcRenderer.invoke('ai:stream', request),

    abort: (id: string) => ipcRenderer.invoke('ai:abort', id),
    connectionTest: (config: { baseUrl: string, apiKey: string, modelId: string }) =>
      ipcRenderer.invoke('ai:connection-test', config),
    safeParseJson: (raw: string) => ipcRenderer.invoke('ai:safe-parse-json', raw),
    classify: (request: { baseUrl: string; modelId: string; apiKey: string; messages: Array<{ role: string; content: string }>; jsonSchema: Record<string, unknown>; schemaName?: string; maxTokens?: number }) =>
      ipcRenderer.invoke('ai:classify', request),
    complete: (request: { baseUrl: string; modelId: string; apiKey: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number }) =>
      ipcRenderer.invoke('ai:complete', request),
    embed: (request: { baseUrl: string; model: string; prompt: string; apiKey?: string }) =>
      ipcRenderer.invoke('ai:embed', request),

    onToken: (callback: (data: { id: string, token: string }) => void) => {
      const listener = (_: unknown, data: { id: string, token: string }) => callback(data)
      ipcRenderer.on('ai:token', listener)
      return () => ipcRenderer.removeListener('ai:token', listener)
    },

    onDone: (callback: (data: { id: string }) => void) => {
      const listener = (_: unknown, data: { id: string }) => callback(data)
      ipcRenderer.on('ai:done', listener)
      return () => ipcRenderer.removeListener('ai:done', listener)
    },

    onError: (callback: (data: { id: string, error: string }) => void) => {
      const listener = (_: unknown, data: { id: string, error: string }) => callback(data)
      ipcRenderer.on('ai:error', listener)
      return () => ipcRenderer.removeListener('ai:error', listener)
    }
  },

  fs: {
    readFile: (filePath: string) => ipcRenderer.invoke('fs:read-file', filePath),
    detectEncoding: (filePath: string) => ipcRenderer.invoke('fs:detect-encoding', filePath),
    saveFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:save-file', { filePath, content }),
    selectFile: (options?: { title?: string, filters?: Array<{name: string, extensions: string[]}> }) =>
      ipcRenderer.invoke('fs:select-file', options || {}),
    selectSaveFile: (options?: { title?: string, defaultPath?: string, filters?: Array<{name: string, extensions: string[]}> }) =>
      ipcRenderer.invoke('fs:select-save-file', options || {}),
    selectDirectory: (options?: { title?: string }) =>
      ipcRenderer.invoke('fs:select-directory', options || {}),
    splitTextIntoChapters: (content: string) => ipcRenderer.invoke('fs:split-text-into-chapters', content)
  },

  context: {
    getStates: (projectId: string) => ipcRenderer.invoke('context:get-states', projectId),
    updateStates: (projectId: string, updates: Array<{name: string, state_snapshot: unknown, chapterIndex: number}>) =>
      ipcRenderer.invoke('context:update-states', { projectId, updates }),
    getChain: (projectId: string, beforeChapter: number) =>
      ipcRenderer.invoke('context:get-chain', { projectId, beforeChapter }),
    getSummary: (projectId: string, chapterId: string) =>
      ipcRenderer.invoke('context:get-summary', { projectId, chapterId }),
    lockState: (characterId: string, locked: boolean) =>
      ipcRenderer.invoke('context:lock-state', characterId, locked),
    saveSummary: (data: { projectId: string, chapterId: string, summary: { plot_summary: string, additions: Array<{type: string, content: string}> } }) =>
      ipcRenderer.invoke('context:save-summary', data),
    saveMeta: (data: { projectId: string, chapterIndex: number, meta: { foreshadowing?: string[], items?: Array<{ name: string, owner?: string }>, powerUpdates?: Array<{ name: string, realm?: string, stage?: string }> } }) =>
      ipcRenderer.invoke('context:save-meta', data),
    getMemory: (projectId: string) => ipcRenderer.invoke('context:get-memory', { projectId }),
  },

  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', { key, value }),
    getAll: () => ipcRenderer.invoke('settings:get-all'),
    clearCache: () => ipcRenderer.invoke('settings:clear-cache'),
    getDbPath: () => ipcRenderer.invoke('settings:get-db-path'),
    getCacheSize: () => ipcRenderer.invoke('settings:get-cache-size'),
    getKbPaths: () => ipcRenderer.invoke('settings:get-kb-paths'),
    setKbPath: (key: string, value: string) => ipcRenderer.invoke('settings:set-kb-path', key, value),
  },

  app: {
    getMeta: () => ipcRenderer.invoke('app:get-meta')
  },

  menu: {
    onNewProject: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('menu:new-project', listener)
      return () => ipcRenderer.removeListener('menu:new-project', listener)
    },
    onImportFile: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('menu:import-file', listener)
      return () => ipcRenderer.removeListener('menu:import-file', listener)
    },
    onViewStage: (callback: (stage: string) => void) => {
      const listener = (_: unknown, stage: string) => callback(stage)
      ipcRenderer.on('menu:view-stage', listener)
      return () => ipcRenderer.removeListener('menu:view-stage', listener)
    },
    onExportChapters: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('menu:export-chapters', listener)
      return () => ipcRenderer.removeListener('menu:export-chapters', listener)
    },
    onExportMerged: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('menu:export-merged', listener)
      return () => ipcRenderer.removeListener('menu:export-merged', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}