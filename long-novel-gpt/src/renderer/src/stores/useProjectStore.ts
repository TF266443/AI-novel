import { create } from 'zustand'

export interface SceneTag {
  categoryId: string
  name: string
  start: number
  end: number
  source: 'ai' | 'manual' | 'corrected'
  confidence?: number
}

export interface ScanMetrics {
  chunks: number
  recallCount: number
  classifyCalls: number
  failedChunks: Array<{ chunkIndex: number; reason: string }>
  avgConfidence: number
  durationMs: number
  debugLog?: string[]
}

export interface Chapter {
  id: string
  chapterIndex: number
  title: string
  originalText: string
  rewrittenText: string | null
  status: 'pending' | 'processing' | 'done' | 'error'
  errorMessage: string | null
  sceneTags: SceneTag[]
  expandedSceneTags: SceneTag[] | null
  scanMetrics?: ScanMetrics
}

export interface Project {
  id: string
  name: string
  filePath: string | null
  savePath: string | null
  templateId: string | null
  highModelId: string | null
  lowModelId: string | null
  shareModels: boolean
  createdAt: string
  updatedAt: string
}

interface ProjectState {
  currentProject: Project | null
  chapters: Chapter[]
  currentChapterIndex: number
  currentStage: 'split' | 'summary' | 'scan' | 'rewrite' | 'quality' | 'preview' | 'export'
  isLoading: boolean
  activeChapterIds: string[]
  scannedChapterIds: Set<string>
  templateVersion: number

  setCurrentProject: (project: Project | null) => void
  bumpTemplateVersion: () => void
  setChapters: (chapters: Chapter[]) => void
  setCurrentChapterIndex: (index: number) => void
  setCurrentStage: (stage: ProjectState['currentStage']) => void
  updateChapterStatus: (chapterId: string, status: Chapter['status'], errorMessage?: string) => void
  updateChapterRewrittenText: (chapterId: string, text: string) => void
  updateChapterSceneTags: (chapterId: string, tags: SceneTag[], metrics?: ScanMetrics) => void
  updateProjectModel: (highModelId: string | null, lowModelId: string | null) => void
  setActiveChapterIds: (updater: string[] | ((prev: string[]) => string[])) => void
  setIsLoading: (loading: boolean) => void
  setScannedChapterIds: (ids: string[]) => void
  loadChapterText: (chapterId: string) => Promise<void>
  loadSceneData: (chapterId: string) => Promise<void>
  reset: () => void
}

const _loadingText = new Set<string>()
const _loadingScene = new Set<string>()

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentProject: null,
  chapters: [],
  currentChapterIndex: 0,
  currentStage: 'split',
  activeChapterIds: [],
  scannedChapterIds: new Set<string>(),
  templateVersion: 0,
  isLoading: false,

  setCurrentProject: (project) => set({ currentProject: project }),
  bumpTemplateVersion: () => set(s => ({ templateVersion: s.templateVersion + 1 })),

  setChapters: (chapters) => set({ chapters }),

  setCurrentChapterIndex: (index) => set({ currentChapterIndex: index }),

  setCurrentStage: (stage) => set({ currentStage: stage }),

  updateChapterStatus: (chapterId, status, errorMessage) => set((state) => ({
    chapters: state.chapters.map((ch) =>
      ch.id === chapterId ? { ...ch, status, errorMessage: errorMessage || null } : ch
    )
  })),

  updateChapterRewrittenText: (chapterId, text) => set((state) => ({
    chapters: state.chapters.map((ch) =>
      ch.id === chapterId ? { ...ch, rewrittenText: text } : ch
    )
  })),

  updateChapterSceneTags: (chapterId, tags, metrics) => set((state) => {
    return {
      chapters: state.chapters.map((ch) =>
        ch.id === chapterId ? { ...ch, sceneTags: tags, scanMetrics: metrics } : ch
      ),
      scannedChapterIds: new Set([...state.scannedChapterIds, chapterId]),
    }
  }),

  setIsLoading: (loading) => set({ isLoading: loading }),

  setActiveChapterIds: (updater) => set((state) => ({
    activeChapterIds: typeof updater === 'function' ? updater(state.activeChapterIds) : [...updater as string[]]
  })),

  updateProjectModel: (highModelId, lowModelId) => set((state) => ({
    currentProject: state.currentProject ? { ...state.currentProject, highModelId, lowModelId, shareModels: !lowModelId } : null
  })),

  setScannedChapterIds: (ids) => set({ scannedChapterIds: new Set(ids) }),

  loadChapterText: async (chapterId) => {
    if (get().chapters.find(c => c.id === chapterId)?.originalText) return
    if (_loadingText.has(chapterId)) return
    _loadingText.add(chapterId)
    try {
      const r = await window.api.db.query('chapters', 'id = ?', [chapterId], 'original_text, rewritten_text, expanded_scene_tags')
      if (r.success && r.data?.length) {
        const row = (r.data as any[])[0]
        let expandedTags: SceneTag[] | null = null
        if (row.expanded_scene_tags) {
          try { expandedTags = JSON.parse(row.expanded_scene_tags) } catch { /* ignore parse errors */ }
        }
        set((state) => ({
          chapters: state.chapters.map(c =>
            c.id === chapterId ? { ...c, originalText: row.original_text || '', rewrittenText: row.rewritten_text || null, expandedSceneTags: expandedTags } : c
          )
        }))
      }
    } catch (err) {
      console.error('loadChapterText failed:', err)
    } finally {
      _loadingText.delete(chapterId)
    }
  },

  loadSceneData: async (chapterId) => {
    if (get().chapters.find(c => c.id === chapterId)?.sceneTags.length) return
    if (_loadingScene.has(chapterId)) return
    _loadingScene.add(chapterId)
    try {
      const r = await window.api.db.query('chapters', 'id = ?', [chapterId], 'scene_tags, scan_metrics')
      if (r.success && r.data?.length) {
        const row = (r.data as any[])[0]
        set((state) => ({
          chapters: state.chapters.map(c =>
            c.id === chapterId ? {
              ...c,
              sceneTags: row.scene_tags ? JSON.parse(row.scene_tags) : [],
              scanMetrics: row.scan_metrics ? JSON.parse(row.scan_metrics) : undefined,
            } : c
          )
        }))
      }
    } catch (err) {
      console.error('loadSceneData failed:', err)
    } finally {
      _loadingScene.delete(chapterId)
    }
  },

  reset: () => set({
    currentProject: null,
    chapters: [],
    currentChapterIndex: 0,
    currentStage: 'split',
    isLoading: false,
    activeChapterIds: [],
    scannedChapterIds: new Set<string>(),
    templateVersion: 0,
  })
}))
