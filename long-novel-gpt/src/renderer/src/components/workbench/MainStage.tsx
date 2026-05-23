import { useEffect } from 'react'
import { useProjectStore } from '../../stores/useProjectStore'
import SplitStage from '../stages/split/SplitStage'
import SummaryStage from '../stages/summary/SummaryStage'
import ScanStage from '../stages/scan/ScanStage'
import RewriteStage from '../stages/rewrite/RewriteStage'
import QualityStage from '../stages/quality/QualityStage'
import PreviewStage from '../stages/preview/PreviewStage'
import ExportStage from '../stages/export/ExportStage'
export default function MainStage() {
  const { currentStage, chapters, currentChapterIndex, setActiveChapterIds } = useProjectStore()
  const currentChapter = chapters[currentChapterIndex]

  // Clear processing indicators when switching stages
  useEffect(() => {
    setActiveChapterIds([])
  }, [currentStage])

  const renderStage = () => {
    switch (currentStage) {
      case 'split':
        return <SplitStage />
      case 'summary':
        return <SummaryStage />
      case 'scan':
        return <ScanStage />
      case 'rewrite':
        return <RewriteStage />
      case 'quality':
        return <QualityStage />
      case 'preview':
        return <PreviewStage />
      case 'export':
        return <ExportStage />
      default:
        return <SplitStage />
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-4">
      {currentChapter && (
        <div className="mb-4 text-sm text-gray-500">
          当前章节: {currentChapter.title || `第${currentChapterIndex + 1}章`}
        </div>
      )}
      <div className="flex-1 overflow-auto bg-white rounded-lg shadow">
        {renderStage()}
      </div>
    </div>
  )
}
