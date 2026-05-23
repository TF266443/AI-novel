import { create } from 'zustand'

export interface CharacterState {
  id: string
  name: string
  alias: string | null
  description: string | null
  stateSnapshot: {
    appearance: string
    emotion: string
    location: string
    status: string
    relationships: Record<string, string>
  }
  source: 'auto' | 'manual'
  locked: boolean
  updatedAt: string
  updatedFromChapter: number | null
}

export interface ChapterSummary {
  id: string
  chapterId: string
  plotSummary: string
  sceneSummary?: string
  additions: Array<{ type: string, content: string }>
  createdAt: string
}

interface ContextState {
  characters: CharacterState[]
  chapterSummaries: ChapterSummary[]
  hasSummaryIds: Set<string>
  isLoading: boolean

  setCharacters: (characters: CharacterState[]) => void
  addCharacter: (character: CharacterState) => void
  updateCharacter: (id: string, updates: Partial<CharacterState>) => void
  removeCharacter: (id: string) => void

  setChapterSummaries: (summaries: ChapterSummary[]) => void
  addChapterSummary: (summary: ChapterSummary) => void
  setHasSummaryIds: (ids: string[]) => void
  loadChapterSummary: (projectId: string, chapterId: string) => Promise<ChapterSummary | null>

  setIsLoading: (loading: boolean) => void
  reset: () => void
}

const _loadingSummary = new Set<string>()

export const useContextStore = create<ContextState>((set, get) => ({
  characters: [],
  chapterSummaries: [],
  hasSummaryIds: new Set<string>(),
  isLoading: false,

  setCharacters: (characters) => set({ characters }),

  addCharacter: (character) => set((state) => ({
    characters: [...state.characters, character]
  })),

  updateCharacter: (id, updates) => set((state) => ({
    characters: state.characters.map((c) =>
      c.id === id ? { ...c, ...updates } : c
    )
  })),

  removeCharacter: (id) => set((state) => ({
    characters: state.characters.filter((c) => c.id !== id)
  })),

  setChapterSummaries: (summaries) => set({ chapterSummaries: summaries }),

  addChapterSummary: (summary) => set((state) => ({
    chapterSummaries: [...state.chapterSummaries, summary],
    hasSummaryIds: new Set([...state.hasSummaryIds, summary.chapterId]),
  })),

  setHasSummaryIds: (ids) => set({ hasSummaryIds: new Set(ids) }),

  loadChapterSummary: async (projectId, chapterId) => {
    if (get().chapterSummaries.find(s => s.chapterId === chapterId)) return null
    if (_loadingSummary.has(chapterId)) return null
    _loadingSummary.add(chapterId)
    try {
      const r = await window.api.context.getSummary(projectId, chapterId)
      if (r.success && r.data) {
        const s = r.data
        const summary: ChapterSummary = {
          id: s.id,
          chapterId: s.chapter_id,
          plotSummary: s.plot_summary || '',
          sceneSummary: s.scene_summary || '',
          additions: s.additions ? JSON.parse(s.additions) : [],
          createdAt: s.created_at || '',
        }
        set((state) => ({
          chapterSummaries: [...state.chapterSummaries, summary],
          hasSummaryIds: new Set([...state.hasSummaryIds, chapterId]),
        }))
        return summary
      }
    } catch (err) { console.error('loadChapterSummary failed:', err) }
    finally { _loadingSummary.delete(chapterId) }
    return null
  },

  setIsLoading: (loading) => set({ isLoading: loading }),

  reset: () => set({
    characters: [],
    chapterSummaries: [],
    hasSummaryIds: new Set<string>(),
    isLoading: false
  })
}))
