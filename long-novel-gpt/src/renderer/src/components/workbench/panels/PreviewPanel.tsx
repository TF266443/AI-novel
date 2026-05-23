import { useProjectStore } from '../../../stores/useProjectStore'

export default function PreviewPanel() {
  const { chapters, setCurrentStage } = useProjectStore()

  const rewritten = chapters.filter(ch => ch.status === 'done' || ch.rewrittenText).length
  const total = chapters.length
  const pct = total > 0 ? Math.round((rewritten / total) * 100) : 0
  const totalRewritten = chapters.reduce((s, c) => s + (c.rewrittenText?.length || 0), 0)

  return (
    <div className="flex-1 flex flex-col p-4">
      <h2 className="font-semibold text-gray-700 mb-4 text-sm">预览统计</h2>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">已改写</span>
          <span className="font-medium text-green-600">{rewritten}/{total}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">改写总字数</span>
          <span className="font-medium">{totalRewritten.toLocaleString()}</span>
        </div>

        <div className="border-t border-gray-200 pt-3 mt-3">
          <div className="flex justify-between text-xs text-gray-500"><span>进度</span><span>{pct}%</span></div>
          <div className="w-full h-2 bg-gray-200 rounded mt-1 overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <div className="mt-auto pt-4 border-t border-gray-200">
        <p className="text-xs text-gray-400 mb-3">在中间区域检查改写结果</p>
        <button
          onClick={() => setCurrentStage('export')}
          className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
        >
          下一步：导出
        </button>
      </div>
    </div>
  )
}
