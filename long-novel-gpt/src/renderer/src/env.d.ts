/// <reference types="vite/client" />

interface Window {
  electron: typeof import('@electron-toolkit/preload').electronAPI
  api: {
    db: {
      query: (table: string, condition?: string, params?: unknown[], columns?: string) => Promise<{ success: boolean, data?: unknown, error?: string }>
      mutation: (table: string, operation: 'insert' | 'update' | 'delete', data: unknown, condition?: string, params?: unknown[]) => Promise<{ success: boolean, data?: unknown, error?: string }>
      batch: (operations: Array<{ table: string, operation: string, data?: unknown, condition?: string, params?: unknown[] }>) => Promise<{ success: boolean, data?: unknown, error?: string, results?: Array<{ success: boolean, data?: unknown, error?: string }> }>
    }
    ai: {
      stream: (request: {
        id: string
        modelId: string
        baseUrl: string
        apiKey: string
        messages: Array<{ role: string, content: string }>
        temperature?: number
        maxTokens?: number
      }) => Promise<{ success: boolean, error?: string }>
      abort: (id: string) => Promise<{ success: boolean, error?: string }>
      connectionTest: (config: { baseUrl: string, apiKey: string, modelId: string }) => Promise<{ success: boolean, error?: string }>
      safeParseJson: (raw: string) => Promise<{ data?: unknown, error?: string }>
      classify: (request: {
        baseUrl: string
        modelId: string
        apiKey: string
        messages: Array<{ role: string, content: string }>
        jsonSchema: Record<string, unknown>
        schemaName?: string
        maxTokens?: number
      }) => Promise<{ success: boolean, data?: unknown, error?: string }>
      complete: (request: {
        baseUrl: string
        modelId: string
        apiKey: string
        messages: Array<{ role: string, content: string }>
        temperature?: number
        maxTokens?: number
      }) => Promise<{ success: boolean, data?: string, error?: string }>
      embed: (request: { baseUrl: string; model: string; prompt: string; apiKey?: string }) => Promise<{ success: boolean; data: number[]; error?: string }>
      onToken: (callback: (data: { id: string, token: string }) => void) => () => void
      onDone: (callback: (data: { id: string }) => void) => () => void
      onError: (callback: (data: { id: string, error: string }) => void) => () => void
    }
    fs: {
      readFile: (filePath: string) => Promise<{ success: boolean, data?: { content: string, encoding: string }, error?: string }>
      detectEncoding: (filePath: string) => Promise<{ success: boolean, data?: { encoding: string, confidence: number }, error?: string }>
      saveFile: (filePath: string, content: string) => Promise<{ success: boolean, error?: string }>
      selectFile: (options?: { title?: string, filters?: Array<{ name: string, extensions: string[] }> }) => Promise<{ success: boolean, data?: { filePath: string }, error?: string }>
      selectSaveFile: (options?: { title?: string, defaultPath?: string, filters?: Array<{ name: string, extensions: string[] }> }) => Promise<{ success: boolean, data?: { filePath: string }, error?: string }>
      selectDirectory: (options?: { title?: string }) => Promise<{ success: boolean, data?: { dirPath: string }, error?: string }>
      splitTextIntoChapters: (content: string) => Promise<{ success: boolean, data?: Array<{ index: number, title: string, content: string }>, error?: string }>
    }
    context: {
      getStates: (projectId: string) => Promise<{ success: boolean, data?: unknown, error?: string }>
      updateStates: (projectId: string, updates: Array<{ name: string, state_snapshot: unknown, chapterIndex: number }>) => Promise<{ success: boolean, error?: string }>
      getChain: (projectId: string, beforeChapter: number) => Promise<{ success: boolean, data?: unknown, error?: string }>
      getSummary: (projectId: string, chapterId: string) => Promise<{ success: boolean, data?: any, error?: string }>
      lockState: (characterId: string, locked: boolean) => Promise<{ success: boolean, error?: string }>
      saveSummary: (data: { projectId: string, chapterId: string, summary: { plot_summary: string, additions: Array<{type: string, content: string}> } }) => Promise<{ success: boolean, data?: { id: string }, error?: string }>
      saveMeta: (data: { projectId: string, chapterIndex: number, meta: { foreshadowing?: string[], items?: Array<{ name: string, owner?: string }>, powerUpdates?: Array<{ name: string, realm?: string, stage?: string }> } }) => Promise<{ success: boolean, error?: string }>
      getMemory: (projectId: string) => Promise<{ success: boolean, data?: unknown, error?: string }>
    }
    settings: {
      get: (key: string) => Promise<{ success: boolean, data?: unknown, error?: string }>
      set: (key: string, value: unknown) => Promise<{ success: boolean, error?: string }>
      getAll: () => Promise<{ success: boolean, data?: Record<string, unknown>, error?: string }>
      clearCache: () => Promise<{ success: boolean, data?: unknown, error?: string }>
      getCacheSize: () => Promise<number>
      getDbPath: () => Promise<{ success: boolean, data?: string, error?: string }>
      getKbPaths: () => Promise<Record<string, string>>
      setKbPath: (key: string, value: string) => Promise<{ success: boolean }>
    }
    app: {
      getMeta: () => Promise<{ success: boolean, data?: { version: string }, error?: string }>
    }
    menu: {
      onNewProject: (callback: () => void) => () => void
      onImportFile: (callback: () => void) => () => void
      onViewStage: (callback: (stage: string) => void) => () => void
      onExportChapters: (callback: () => void) => () => void
      onExportMerged: (callback: () => void) => () => void
    }
  }
}