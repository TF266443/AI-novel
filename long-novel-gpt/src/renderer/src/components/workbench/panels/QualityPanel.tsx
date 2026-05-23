import { useState, useEffect, useRef } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'

export default function QualityPanel() {
  const { chapters, setCurrentStage } = useProjectStore()
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [selModelId, setSelModelId] = useState('');
  const selModelIdRef = useRef('')

  useEffect(() => {
    window.api.db.query('models').then(r => { if (r.success && r.data) { const m = r.data as any[]; setModels(m); if (!selModelId && m.length) setSelModelId(m[0].id) } })
  }, [])
  const rewritten = chapters.filter(ch => ch.status === 'done' || ch.rewrittenText).length
  const total = chapters.length
  const pct = total > 0 ? Math.round((rewritten / total) * 100) : 0

  return (
    <div className="flex-1 flex flex-col p-4">
      <h2 className="font-semibold text-gray-700 mb-4 text-sm">质量检查统计</h2>
      <div className="space-y-3 text-sm">
        <div className="flex justify-between"><span className="text-gray-500">可检查章节</span><span className="font-medium text-green-600">{rewritten}/{total}</span></div>
        <div className="border-t border-gray-200 pt-3 mt-3">
          <div className="flex justify-between text-xs text-gray-500"><span>改写进度</span><span>{pct}%</span></div>
          <div className="w-full h-2 bg-gray-200 rounded mt-1 overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      <div className="mt-4 p-3 bg-blue-50 rounded text-xs text-blue-700">
        <p>自检使用本地模型（Ollama），速度秒级。在中间区域逐章检查。</p>
      </div>
      <div className="mt-auto pt-4 border-t border-gray-200">
        <button onClick={() => setCurrentStage('preview')}
          className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
          下一步：预览
        </button>
      </div>
    </div>
  )
}
