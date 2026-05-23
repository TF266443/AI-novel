import { useState } from 'react'
import { useProjectStore, Chapter } from '../../stores/useProjectStore'
import { useBatchStore } from '../../stores/useBatchStore'

export default function BatchController() {
  const { chapters, updateChapterStatus, updateChapterRewrittenText, currentProject } = useProjectStore()
  const { queue, isPaused, concurrency, enqueue, dequeue, updateStatus, setPaused, clearQueue } = useBatchStore()
  const [processingCount, setProcessingCount] = useState(0)

  const handleSelectAll = () => {
    const pendingChapterIds = chapters
      .filter(ch => ch.status === 'pending' || ch.status === 'error')
      .map(ch => ch.id)
    enqueue(pendingChapterIds)
  }

  const handleSelectChapter = (chapterId: string) => {
    const existing = queue.find(q => q.chapterId === chapterId)
    if (existing) {
      dequeue(chapterId)
    } else {
      enqueue([chapterId])
    }
  }

  const handleStartBatch = async () => {
    if (!currentProject) return
    setPaused(false)
    processQueue()
  }

  const processQueue = async () => {
    const pendingItems = queue.filter(q => q.status === 'pending')
    if (pendingItems.length === 0) return

    const itemsToProcess = pendingItems.slice(0, concurrency - processingCount)
    if (itemsToProcess.length === 0) return

    for (const item of itemsToProcess) {
      updateStatus(item.chapterId, 'processing')
      setProcessingCount(prev => prev + 1)
      processChapter(item.chapterId)
    }
  }

  const processChapter = async (chapterId: string) => {
    const chapter = chapters.find(ch => ch.id === chapterId)
    if (!chapter) {
      updateStatus(chapterId, 'error')
      setProcessingCount(prev => prev - 1)
      return
    }

    try {
      updateChapterStatus(chapterId, 'processing')

      // Simulate AI rewrite with delay
      await new Promise(resolve => setTimeout(resolve, 2000))

      // In real implementation, this would call AI API with context injection
      updateChapterRewrittenText(chapterId, `[改写后的内容] ${chapter.originalText.slice(0, 100)}...`)
      updateChapterStatus(chapterId, 'done')
    } catch (error) {
      updateChapterStatus(chapterId, 'error', (error as Error).message)
    } finally {
      setProcessingCount(prev => Math.max(0, prev - 1))
    }
  }

  const handlePause = () => {
    setPaused(true)
  }

  const handleStop = () => {
    clearQueue()
    setProcessingCount(0)
  }

  const handleRetryFailed = () => {
    const failedIds = queue.filter(q => q.status === 'error').map(q => q.chapterId)
    failedIds.forEach(id => updateStatus(id, 'pending'))
    if (!isPaused && failedIds.length > 0) {
      processQueue()
    }
  }

  return (
    <div className="p-4 border-t border-gray-200">
      <h3 className="font-medium text-gray-700 mb-3">批量控制</h3>

      <div className="space-y-2 mb-4">
        <button
          onClick={handleSelectAll}
          className="w-full px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded transition"
        >
          全选待处理章节
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={handleStartBatch}
          disabled={isPaused || queue.length === 0}
          className="flex-1 px-3 py-2 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700 disabled:opacity-50"
        >
          批量开始
        </button>
        <button
          onClick={handlePause}
          disabled={!isPaused}
          className="px-3 py-2 bg-yellow-500 text-white text-sm rounded hover:bg-yellow-600 disabled:opacity-50"
        >
          暂停
        </button>
      </div>

      <div className="text-sm text-gray-600 mb-2">
        并发数: {concurrency} | 进行中: {processingCount}
      </div>

      {queue.filter(q => q.status === 'error').length > 0 && (
        <button
          onClick={handleRetryFailed}
          className="w-full px-3 py-2 bg-red-500 text-white text-sm rounded hover:bg-red-600"
        >
          重试失败 ({queue.filter(q => q.status === 'error').length})
        </button>
      )}

      {queue.length > 0 && (
        <div className="mt-4 max-h-40 overflow-y-auto">
          <div className="text-xs text-gray-500 mb-2">
            已选择 {queue.length} 章
          </div>
        </div>
      )}
    </div>
  )
}