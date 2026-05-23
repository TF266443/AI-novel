import { create } from 'zustand'

interface BatchState {
  queue: Array<{ chapterId: string, status: 'pending' | 'processing' | 'done' | 'error' }>
  isPaused: boolean
  concurrency: number

  enqueue: (chapterIds: string[]) => void
  dequeue: (chapterId: string) => void
  updateStatus: (chapterId: string, status: 'pending' | 'processing' | 'done' | 'error') => void
  setPaused: (paused: boolean) => void
  setConcurrency: (n: number) => void
  clearQueue: () => void
}

export const useBatchStore = create<BatchState>((set) => ({
  queue: [],
  isPaused: false,
  concurrency: 3,

  enqueue: (chapterIds) => set((state) => ({
    queue: [
      ...state.queue,
      ...chapterIds.map((id) => ({ chapterId: id, status: 'pending' as const }))
    ]
  })),

  dequeue: (chapterId) => set((state) => ({
    queue: state.queue.filter((item) => item.chapterId !== chapterId)
  })),

  updateStatus: (chapterId, status) => set((state) => ({
    queue: state.queue.map((item) =>
      item.chapterId === chapterId ? { ...item, status } : item
    )
  })),

  setPaused: (paused) => set({ isPaused: paused }),

  setConcurrency: (n) => set({ concurrency: n }),

  clearQueue: () => set({ queue: [] })
}))