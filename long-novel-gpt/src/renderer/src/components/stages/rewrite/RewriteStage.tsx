import { useState, useEffect, useRef, useCallback } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useContextStore } from '../../../stores/useContextStore'
import { useRewriteChapter } from '../../../hooks/useRewriteChapter'
import { nanoid } from 'nanoid'

export default function RewriteStage() {
  const { chapters, currentChapterIndex, currentProject, updateChapterStatus, updateChapterRewrittenText } = useProjectStore()
  const { characters, chapterSummaries, setCharacters, setChapterSummaries } = useContextStore()
  const currentChapter = chapters[currentChapterIndex]

  const [isRewriting, setIsRewriting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [streamOutput, setStreamOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<Array<{ id: string; name: string; model_id: string; base_url: string; api_key_encrypted: string }>>([])
  const [selModelId, setSelModelId] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const { rewriteChapter } = useRewriteChapter()

  useEffect(() => {
    window.api.db.query('models').then(r => {
      if (r.success && r.data) {
        const m = r.data as any[]
        setModels(m)
        setSelModelId(m[0]?.id ?? '')
      }
    })
  }, [])

  useEffect(() => {
    if (!currentProject) return

    const loadContext = async () => {
      const statesResult = await window.api.context.getStates(currentProject.id)
      if (statesResult.success && statesResult.data) {
        setCharacters(statesResult.data as any[])
      }

      const chainResult = await window.api.context.getChain(currentProject.id, currentChapter?.chapterIndex ?? 0)
      if (chainResult.success && chainResult.data) {
        setChapterSummaries(chainResult.data as any[])
      }
    }

    loadContext()
  }, [currentProject, currentChapterIndex])

  const handleRewrite = useCallback(async () => {
    if (!currentChapter || !currentProject) return

    setIsRewriting(true)
    setProgress(0)
    setStreamOutput('')
    setError(null)
    updateChapterStatus(currentChapter.id, 'processing')

    const controller = new AbortController()
    abortRef.current = controller

    const result = await rewriteChapter(
      {
        id: currentChapter.id,
        chapterIndex: currentChapter.chapterIndex,
        originalText: currentChapter.originalText,
        sceneTags: currentChapter.sceneTags,
      },
      {
        signal: controller.signal,
        onProgress: (text, pct) => {
          if (text.length > 100) {
            setStreamOutput(text)
          }
          setProgress(pct)
        },
        onStreamChunk: () => {
          // Stream output is handled via onProgress with accumulated text
        },
      },
    )

    if (result.error) {
      setError(result.error)
      setIsRewriting(false)
      updateChapterStatus(currentChapter.id, 'error', result.error)
      await window.api.db.mutation('chapters', 'update', {
        error_message: result.error,
        status: 'error',
      }, 'id = ?', [currentChapter.id])
      return
    }

    updateChapterRewrittenText(currentChapter.id, result.rewrittenText)
    updateChapterStatus(currentChapter.id, 'done')
    setProgress(100)
    setStreamOutput(result.rewrittenText)

    // Refresh character states if they were updated
    if (result.characterUpdates.length > 0 && currentProject) {
      const statesResult = await window.api.context.getStates(currentProject.id)
      if (statesResult.success && statesResult.data) {
        setCharacters(statesResult.data as any[])
      }
    }

    setIsRewriting(false)
  }, [currentChapter, currentProject, rewriteChapter, updateChapterStatus, updateChapterRewrittenText, setCharacters])

  const handleAbort = useCallback(async () => {
    abortRef.current?.abort()
    await window.api.ai.abort(nanoid()) // Fallback abort for any residual stream
    setIsRewriting(false)
  }, [])

  return (
    <div className="p-6">
      <h2 className="text-xl font-semibold text-gray-800 mb-4">改写阶段</h2>

      <div className="flex gap-4 mb-6">
        <select value={selModelId} onChange={e => setSelModelId(e.target.value)}
          className="text-xs border border-gray-300 rounded px-2 py-1.5 text-gray-600 min-w-[140px]">
          {models.length === 0 ? <option value="">无模型</option> : models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button
          onClick={handleRewrite}
          disabled={isRewriting || !selModelId}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
        >
          {isRewriting ? '改写中...' : '开始改写'}
        </button>
        {isRewriting && (
          <button
            onClick={handleAbort}
            className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
          >
            停止
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {isRewriting && (
        <div className="mb-6">
          <div className="flex justify-between text-sm text-gray-600 mb-1">
            <span>进度</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded overflow-hidden">
            <div
              className="h-full bg-indigo-600 transition-all duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {currentChapter && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="font-medium text-gray-700 mb-2">原文</h3>
            <div className="border border-gray-200 rounded-lg p-4 h-64 overflow-auto">
              <pre className="whitespace-pre-wrap text-sm">{currentChapter.originalText.slice(0, 500)}...</pre>
            </div>
          </div>
          <div>
            <h3 className="font-medium text-gray-700 mb-2">改写后</h3>
            <div className="border border-gray-200 rounded-lg p-4 h-64 overflow-auto">
              {streamOutput ? (
                <pre className="whitespace-pre-wrap text-sm">{streamOutput}</pre>
              ) : currentChapter.rewrittenText ? (
                <pre className="whitespace-pre-wrap text-sm">{currentChapter.rewrittenText}</pre>
              ) : (
                <p className="text-gray-400 italic">暂无改写内容</p>
              )}
            </div>
          </div>
        </div>
      )}

      {characters.length > 0 && (
        <div className="mt-6">
          <h4 className="font-medium text-gray-700 mb-2">当前角色状态</h4>
          <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
            {characters.map((char) => (
              <div key={char.id} className="text-gray-600">
                <span className="font-medium">{char.name}:</span> {typeof char.stateSnapshot === 'string' ? char.stateSnapshot : JSON.stringify(char.stateSnapshot)}
              </div>
            ))}
          </div>
        </div>
      )}

      {chapterSummaries.length > 0 && (
        <div className="mt-4">
          <h4 className="font-medium text-gray-700 mb-2">前文章节摘要</h4>
          <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1 max-h-32 overflow-auto">
            {chapterSummaries.slice(-3).map((sum) => (
              <div key={sum.id} className="text-gray-600">
                章节 {sum.id}: {sum.plotSummary?.slice(0, 50)}...
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
