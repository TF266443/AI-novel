import { useProjectStore } from '../../../stores/useProjectStore'

export default function ExportPanel() {
  const { chapters } = useProjectStore()
  const rewritten = chapters.filter(ch => ch.status === 'done' || ch.rewrittenText).length
  const total = chapters.length

  return (
    <div className="flex-1 flex flex-col p-4">
      <h2 className="font-semibold text-gray-700 mb-4 text-sm">导出统计</h2>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">可导出章节</span>
          <span className="font-medium text-green-600">{rewritten}/{total}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">改写总字数</span>
          <span className="font-medium">
            {chapters.reduce((s, c) => s + (c.rewrittenText?.length || 0), 0).toLocaleString()}
          </span>
        </div>
      </div>

      <div className="mt-auto pt-4 border-t border-gray-200">
        <p className="text-xs text-gray-400">在中间区域选择导出方式</p>
      </div>
    </div>
  )
}
