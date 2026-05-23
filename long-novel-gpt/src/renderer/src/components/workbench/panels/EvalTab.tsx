import { useState, useEffect } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { evaluateAll, saveEvalRun, type EvalResult } from '../../../lib/evaluation'

interface Props { categories: Array<{ id: string; name: string }> }

export default function EvalTab({ categories }: Props) {
  const { chapters, currentProject } = useProjectStore()
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null)
  const [running, setRunning] = useState(false)
  const [goldCount, setGoldCount] = useState(0)

  useEffect(() => {
    if (!currentProject) return
    window.api.db.query('gold_labels', 'project_id = ?', [currentProject.id]).then(r => {
      if (r.success && r.data) setGoldCount((r.data as any[]).length)
    })
  }, [currentProject?.id])

  const handleEvaluate = async () => {
    if (!currentProject || running) return
    setRunning(true)
    try {
      // Collect AI tags from all scanned chapters
      const aiTagsByChapter = new Map<string, import('../../../stores/useProjectStore').SceneTag[]>()
      for (const ch of chapters) {
        const aiTags = ch.sceneTags.filter(t => t.source === 'ai')
        if (aiTags.length > 0) aiTagsByChapter.set(ch.id, aiTags)
      }

      const result = await evaluateAll(
        currentProject.id,
        chapters.map(c => c.id),
        aiTagsByChapter,
      )
      setEvalResult(result)

      // Persist
      const tpl = await window.api.db.query('templates', 'id = ?', [currentProject.templateId])
      const tplJson = tpl.success && tpl.data?.length ? JSON.stringify((tpl.data[0] as any).template_json) : '{}'
      await saveEvalRun(currentProject.id, 'current', tplJson, result)
    } catch (err) {
      console.error('Evaluation failed:', err)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col p-4">
      <h2 className="font-semibold text-gray-700 mb-4 text-sm">{'\u91D1\u6807\u8BC4\u4F30'}</h2>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">{'\u91D1\u6807\u6570\u91CF'}</span>
          <span className="font-medium">{goldCount}</span>
        </div>
        {evalResult && (
          <>
            <div className="border-t border-gray-200 pt-3 mt-3 space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-500">Precision</span>
                <span className="font-medium text-blue-600">{(evalResult.precision * 100).toFixed(1)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Recall</span>
                <span className="font-medium text-green-600">{(evalResult.recall * 100).toFixed(1)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">F1</span>
                <span className="font-medium text-indigo-600 font-bold">{(evalResult.f1 * 100).toFixed(1)}%</span>
              </div>
              <div className="flex justify-between text-xs text-gray-400">
                <span>TP:{evalResult.totalTP} FP:{evalResult.totalFP} FN:{evalResult.totalFN}</span>
                <span>{(evalResult.durationMs / 1000).toFixed(1)}s</span>
              </div>
            </div>

            {evalResult.perCategory.length > 0 && (
              <div className="border-t border-gray-200 pt-3 mt-3">
                <p className="text-xs text-gray-500 mb-2">{'\u5404\u5206\u7C7B\u8BE6\u60C5'}</p>
                {evalResult.perCategory.map(cat => {
                  const name = categories.find(c => c.id === cat.categoryId)?.name || cat.categoryId
                  return (
                    <div key={cat.categoryId} className="flex justify-between text-xs py-1 border-b border-gray-100">
                      <span className="text-gray-600 truncate flex-1">{name}</span>
                      <span className="text-indigo-600 ml-2">F1:{(cat.f1 * 100).toFixed(0)}%</span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-auto pt-4 border-t border-gray-200">
        <button onClick={handleEvaluate} disabled={running || goldCount === 0}
          className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium">
          {running ? '\u8BC4\u4F30\u4E2D...' : '\u8FD0\u884C\u91D1\u6807\u8BC4\u4F30'}
        </button>
      </div>
    </div>
  )
}
