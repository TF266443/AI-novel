import { useEffect } from 'react'
import { useProjectStore } from '../stores/useProjectStore'
import ChapterList from '../components/workbench/ChapterList'
import MainStage from '../components/workbench/MainStage'
import StageNavigation from '../components/stepper/StageNavigation'
import StagePanel from '../components/workbench/StagePanel'
import { useAppStore } from '../stores/useAppStore'

export default function WorkbenchPage() {
  const { currentProject, currentStage, setCurrentStage, reset } = useProjectStore()
  const { setPage } = useAppStore()

  useEffect(() => {
    const unsub1 = window.api.menu.onNewProject(() => { reset(); setPage('home') })
    const unsub2 = window.api.menu.onViewStage((stage: string) => { setCurrentStage(stage as any) })
    return () => { unsub1(); unsub2() }
  }, [reset, setPage, setCurrentStage])

  if (!currentProject) return null

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => { reset(); setPage('home') }} className="text-gray-600 hover:text-gray-900 text-sm">
            ← 返回项目
          </button>
          <span className="text-gray-300">|</span>
          <h1 className="font-semibold text-gray-900 text-sm">{currentProject.name}</h1>
        </div>

        <StageNavigation />

        <div className="flex items-center gap-2">
          <button onClick={() => setPage('characters')} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">
            角色管理
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        <aside className="w-60 bg-white border-r border-gray-200 flex flex-col">
          <ChapterList stage={currentStage} />
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden">
          <MainStage />
        </main>

        <aside className="w-56 bg-white border-l border-gray-200 flex flex-col">
          <StagePanel />
        </aside>
      </div>
    </div>
  )
}
