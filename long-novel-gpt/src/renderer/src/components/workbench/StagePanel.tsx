import { useProjectStore } from '../../stores/useProjectStore'
import SplitPanel from './panels/SplitPanel'
import SummaryPanel from './panels/SummaryPanel'
import ScanPanel from './panels/ScanPanel'
import RewritePanel from './panels/RewritePanel'
import QualityPanel from './panels/QualityPanel'
import PreviewPanel from './panels/PreviewPanel'
import ExportPanel from './panels/ExportPanel'

export default function StagePanel() {
  const { currentStage } = useProjectStore()

  switch (currentStage) {
    case 'split':    return <SplitPanel />
    case 'summary':  return <SummaryPanel />
    case 'scan':     return <ScanPanel />
    case 'rewrite':  return <RewritePanel />
    case 'quality':  return <QualityPanel />
    case 'preview':  return <PreviewPanel />
    case 'export':   return <ExportPanel />
    default:         return <SplitPanel />
  }
}
