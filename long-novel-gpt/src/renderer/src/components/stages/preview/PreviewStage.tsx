import { useState } from 'react'
import { useProjectStore, type SceneTag } from '../../../stores/useProjectStore'
import { nanoid } from 'nanoid'

export default function PreviewStage() {
  const { chapters, currentChapterIndex, updateChapterRewrittenText } = useProjectStore()
  const currentChapter = chapters[currentChapterIndex]

  const [showOriginal, setShowOriginal] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const handleEdit = () => {
    if (currentChapter?.rewrittenText) {
      setEditText(currentChapter.rewrittenText)
      setIsEditing(true)
    }
  }

  const handleSaveEdit = async () => {
    if (!currentChapter) return
    updateChapterRewrittenText(currentChapter.id, editText)

    await window.api.db.mutation('chapters', 'update', {
      rewritten_text: editText
    }, 'id = ?', [currentChapter.id])

    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditText('')
  }

  const handleRestore = () => {
    if (currentChapter?.originalText) {
      updateChapterRewrittenText(currentChapter.id, currentChapter.originalText)
    }
  }

  // ── Resolve tags to use on rewritten text ──
  // Prefer expanded_scene_tags (remapped to rewritten coordinates).
  // Fall back to scene_tags (original coordinates — may be misaligned).
  // If neither available, show no tags.
  const rewrittenTags: SceneTag[] = (() => {
    if (!currentChapter) return []
    if (currentChapter.expandedSceneTags && currentChapter.expandedSceneTags.length > 0) {
      return currentChapter.expandedSceneTags
    }
    return currentChapter.sceneTags
  })()
  const sortedRewrittenTags = [...rewrittenTags].sort((a, b) => a.start - b.start)
  const rewrittenText = currentChapter?.rewrittenText || currentChapter?.originalText || ''

  // ── Build pieces for the rewritten text with highlighted tag spans ──
  function buildTaggedPieces(text: string, tags: SceneTag[]) {
    const pieces: Array<{ text: string; tag?: SceneTag }> = []
    let pos = 0
    for (const t of tags) {
      // Skip tags that are out of bounds for rewritten text
      const start = Math.max(0, Math.min(t.start, text.length))
      const end = Math.max(0, Math.min(t.end, text.length))
      if (end <= start) continue
      if (start > pos) pieces.push({ text: text.slice(pos, start) })
      pieces.push({ text: text.slice(start, end), tag: t })
      pos = end
    }
    if (pos < text.length) pieces.push({ text: text.slice(pos) })
    return pieces
  }

  const rewrittenPieces = buildTaggedPieces(rewrittenText, sortedRewrittenTags)

  // ── Total tag count for the footer ──
  const effectiveTagCount = currentChapter
    ? (currentChapter.expandedSceneTags?.length ?? currentChapter.sceneTags.length)
    : 0

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800">预览阶段</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={showOriginal}
              onChange={(e) => setShowOriginal(e.target.checked)}
              className="w-4 h-4"
            />
            显示原文
          </label>
          {currentChapter?.rewrittenText && (
            <>
              <button
                onClick={handleEdit}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                编辑
              </button>
              <button
                onClick={handleRestore}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              >
                恢复原文
              </button>
            </>
          )}
        </div>
      </div>

      {currentChapter?.rewrittenText || currentChapter?.originalText ? (
        <div className="space-y-4">
          {showOriginal && currentChapter.originalText && (
            <div className="border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-500 mb-2">原文</h3>
              <pre className="whitespace-pre-wrap text-sm text-gray-600 max-h-64 overflow-auto">
                {currentChapter.originalText}
              </pre>
            </div>
          )}

          <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50">
            {isEditing ? (
              <div className="space-y-3">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full h-96 p-3 border border-gray-300 rounded-lg font-mono text-sm"
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={handleCancelEdit}
                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h3 className="text-sm font-medium text-indigo-600 mb-2">
                  改写后 {currentChapter.rewrittenText ? '' : '(已恢复原文)'}
                </h3>
                <div className="text-sm leading-relaxed whitespace-pre-wrap max-h-96 overflow-auto">
                  {rewrittenPieces.length > 0 ? (
                    rewrittenPieces.map((p, i) => {
                      if (!p.tag) return <span key={i}>{p.text}</span>
                      const t = p.tag
                      // Color by source — same palette as ScanStage
                      const bg = t.source === 'manual' ? 'rgba(34,197,94,0.18)' :
                                 t.source === 'corrected' ? 'rgba(245,158,11,0.18)' :
                                 'rgba(99,102,241,0.15)'
                      const border = t.source === 'manual' ? '#22c55e' :
                                     t.source === 'corrected' ? '#f59e0b' : '#6366f1'
                      return (
                        <span
                          key={i}
                          className="relative"
                          style={{
                            backgroundColor: bg,
                            borderBottom: `2px solid ${border}`,
                            borderRadius: '2px',
                          }}
                          title={`${t.name} (${t.source === 'ai' ? `AI ${((t.confidence ?? 0) * 100).toFixed(0)}%` : t.source === 'corrected' ? `已修正 AI ${((t.confidence ?? 0) * 100).toFixed(0)}%` : '手动'})`}
                        >
                          {p.text}
                        </span>
                      )
                    })
                  ) : (
                    <pre className="whitespace-pre-wrap">
                      {rewrittenText}
                    </pre>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex justify-between text-sm text-gray-500">
            <span>字数: {rewrittenText.length}</span>
            <span>
              场景标记: {effectiveTagCount}
              {currentChapter?.expandedSceneTags && currentChapter.expandedSceneTags.length > 0 && (
                <span className="text-indigo-500"> (已重映射)</span>
              )}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-gray-500">请先完成改写阶段</p>
          <p className="text-sm text-gray-400 mt-2">或者在分章阶段导入小说文本</p>
        </div>
      )}
    </div>
  )
}
