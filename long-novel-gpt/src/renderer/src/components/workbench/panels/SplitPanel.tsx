import { useProjectStore } from '../../../stores/useProjectStore'

export default function SplitPanel() {
  const { chapters, setCurrentStage } = useProjectStore()
  const totalWords = chapters.reduce((s, c) => s + c.originalText.length, 0)

  return (
    <div className="flex-1 flex flex-col p-4">
      <h2 className="font-semibold text-gray-700 mb-4 text-sm">分章统计</h2>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">章节数</span>
          <span className="font-medium">{chapters.length}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">总字数</span>
          <span className="font-medium">{totalWords.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">平均字数</span>
          <span className="font-medium">
            {chapters.length > 0 ? Math.round(totalWords / chapters.length).toLocaleString() : 0}
          </span>
        </div>
      </div>

      <div className="mt-auto pt-4 border-t border-gray-200">
        <p className="text-xs text-gray-400 mb-3">确认分章无误后进入下一步</p>
        <button
          onClick={() => setCurrentStage('summary')}
          className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
        >
          下一步：摘要
        </button>
      </div>
    </div>
  )
}
