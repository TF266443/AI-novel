import { create } from 'zustand'

interface AppState {
  currentPage: 'home' | 'workbench' | 'models' | 'templates' | 'settings' | 'characters' | 'skills'
  sidebarCollapsed: boolean
  toasts: Array<{ id: string, message: string, type: 'success' | 'error' | 'info' }>
  isLoading: boolean
  setPage: (page: AppState['currentPage']) => void
  toggleSidebar: () => void
  addToast: (message: string, type: 'success' | 'error' | 'info') => void
  removeToast: (id: string) => void
  setLoading: (loading: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  currentPage: 'home',
  sidebarCollapsed: false,
  toasts: [],
  isLoading: false,

  setPage: (page) => set({ currentPage: page }),

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  addToast: (message, type) => {
    const id = Date.now().toString()
    set((state) => ({
      toasts: [...state.toasts, { id, message, type }]
    }))
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id)
      }))
    }, 4000)
  },

  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter((t) => t.id !== id)
  })),

  setLoading: (loading) => set({ isLoading: loading })
}))