import { useEffect } from 'react'
import { FixedSizeList as List } from 'react-window'
import { useProjectStore } from '../../stores/useProjectStore'
import { useContextStore } from '../../stores/useContextStore'

interface Props { stage: string }

type StageStatus = 'split' | 'summary' | 'scan' | 'rewrite' | 'preview' | 'export'

type Chapter = ReturnType<typeof useProjectStore.getState>['chapters'][number]

function getStageIcon(stage: StageStatus, ch: Chapter, hasSummary: boolean): { icon: string; color: string } {
  switch (stage) {
    case 'split':
      return { icon: '\u{1F4C4}', color: '#9ca3af' }
    case 'summary':
      return hasSummary ? { icon: '\u25CF', color: '#16a34a' } : { icon: '\u25CF', color: '#d1d5db' }
    case 'scan':
      return ch.sceneTags.length > 0 ? { icon: '\u25CF', color: '#16a34a' } : { icon: '\u25CF', color: '#d1d5db' }
    case 'rewrite': {
      const s = ch.status
      if (s === 'done') return { icon: '\u2705', color: '#16a34a' }
      if (s === 'processing') return { icon: '\u{1F504}', color: '#22c55e' }
      if (s === 'error') return { icon: '\u274C', color: '#ef4444' }
      return { icon: '\u23F3', color: '#9ca3af' }
    }
    case 'preview':
      return ch.status === 'done' || ch.rewrittenText ? { icon: '\u2705', color: '#16a34a' } : { icon: '\u23F3', color: '#9ca3af' }
    case 'export':
      return ch.status === 'done' || ch.rewrittenText ? { icon: '\u2705', color: '#16a34a' } : { icon: '\u23F3', color: '#9ca3af' }
    default:
      return { icon: '\u{1F4C4}', color: '#9ca3af' }
  }
}

function getStageSubtext(stage: StageStatus, ch: Chapter): string {
  switch (stage) {
    case 'split':
      return ch.originalText.length > 0 ? `${ch.originalText.length} \u5B57` : ''
    case 'summary':
      return ch.originalText.length > 0 ? `${ch.originalText.length} \u5B57` : ''
    case 'scan':
      return ch.sceneTags.length > 0 ? `${ch.sceneTags.length} \u4E2A\u573A\u666F` : ''
    case 'rewrite':
      if (ch.status === 'processing') return '\u5904\u7406\u4E2D...'
      if (ch.status === 'error' && ch.errorMessage) return ch.errorMessage.slice(0, 30)
      return ch.rewrittenText ? `${ch.rewrittenText.length} \u5B57` : ''
    case 'preview':
      return ch.rewrittenText ? `${ch.rewrittenText.length} \u5B57` : ch.status
    case 'export':
      return ch.rewrittenText ? `${ch.rewrittenText.length} \u5B57` : ''
    default:
      return ''
  }
}

export default function ChapterList({ stage }: Props) {
  const { chapters, currentChapterIndex, setCurrentChapterIndex, activeChapterIds, scannedChapterIds, loadChapterText, loadSceneData } = useProjectStore()
  const { hasSummaryIds } = useContextStore()

  // Load text for current chapter on initial load & navigation
  useEffect(() => {
    const ch = chapters[currentChapterIndex]
    if (ch) loadChapterText(ch.id)
    // No cleanup needed: loadChapterText has built-in dedup (_loadingText Set)
  }, [currentChapterIndex])

  // Preload scene data in scan stage so green dots and badges show for all chapters
  useEffect(() => {
    if (stage !== 'scan') return
    for (const ch of chapters) {
      if (!ch.sceneTags || ch.sceneTags.length === 0) {
        loadSceneData(ch.id)
      }
    }
  }, [chapters.length, stage])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-3 border-b border-gray-200">
        <h2 className="font-semibold text-gray-700 text-sm">{'\u7AE0\u8282\u5217\u8868'}</h2>
        <p className="text-xs text-gray-500 mt-1">{chapters.length} {'\u7AE0'}</p>
      </div>

      <div className="flex-1 overflow-hidden">
        <List
          height={600}
          itemCount={chapters.length}
          itemSize={56}
          width="100%"
          className="scrollbar-thin"
          itemData={{ chapters, activeChapterIds, stage, currentChapterIndex }}
        >
          {({ index, style, data }) => {
            const chapter = data.chapters[index]
            const hasSummary = hasSummaryIds.has(chapter.id)
            const isScanned = scannedChapterIds.has(chapter.id)
            const st = getStageIcon(data.stage as StageStatus, chapter, hasSummary)
            const sub = getStageSubtext(data.stage as StageStatus, chapter)
            const isActive = index === data.currentChapterIndex
            const isProcessing = data.activeChapterIds.includes(chapter.id)

            return (
              <div
                style={style}
                className={`px-3 py-2 cursor-pointer border-b border-gray-100 transition ${
                  isProcessing ? 'bg-green-50 animate-pulse' :
                  isActive ? 'bg-indigo-50' : 'hover:bg-gray-50'
                }`}
                onClick={() => setCurrentChapterIndex(index)}
              >
                <div className="flex items-center gap-2">
                  {isProcessing ? (
                    <span className="animate-spin text-xs">{'\u27F3'}</span>
                  ) : (
                    <span style={{ color: st.color, fontSize: 12 }}>{st.icon}</span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      {data.stage === 'scan' && isScanned && (
                        <span className="text-green-500 text-lg leading-none">{'\u25CF'}</span>
                      )}
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {chapter.title || `\u7B2C${index + 1}\u7AE0`}
                      </span>
                    </div>
                    {data.stage === 'scan' && chapter.sceneTags && chapter.sceneTags.length > 0 && (
                      <span className="inline-block mt-0.5 px-1 py-0 text-[10px] bg-yellow-100 text-yellow-700 rounded">
                        {'\u53EF\u6269\u5199'}
                      </span>
                    )}
                    {isProcessing ? (
                      <div className="text-xs text-green-600 truncate mt-0.5 animate-pulse">{'\u5904\u7406\u4E2D...'}</div>
                    ) : sub ? (
                      <div className="text-xs text-gray-400 truncate mt-0.5">{sub}</div>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          }}
        </List>
      </div>
    </div>
  )
}
