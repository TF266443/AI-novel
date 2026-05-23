import { useBatchStore } from '../../stores/useBatchStore'

interface StatsPanelProps {
  queue: Array<{ chapterId: string, status: string }>
  isPaused: boolean
  concurrency: number
  onConcurrencyChange: (n: number) => void
  onStart: () => void
  onPause: () => void
  onStop: () => void
}

export default function StatsPanel({
  queue,
  isPaused,
  concurrency,
  onConcurrencyChange,
  onStart,
  onPause,
  onStop
}: StatsPanelProps) {
  const done = queue.filter(q => q.status === 'done').length
  const processing = queue.filter(q => q.status === 'processing').length
  const pending = queue.filter(q => q.status === 'pending').length
  const error = queue.filter(q => q.status === 'error').length
  const total = queue.length || 1
  const progress = Math.round((done / total) * 100)

  return (
    <div className="flex-1 flex flex-col p-4">
      <h2 className="font-semibold text-gray-700 mb-4">统计</h2>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">已完成</span>
          <span className="font-medium text-green-600">{done}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">进行中</span>
          <span className="font-medium text-blue-600">{processing}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">未处理</span>
          <span className="font-medium text-gray-500">{pending}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">失败</span>
          <span className="font-medium text-red-500">{error}</span>
        </div>

        <div className="border-t border-gray-200 pt-3 mt-3">
          <div className="flex justify-between text-xs text-gray-500">
            <span>进度</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded mt-1 overflow-hidden">
            <div
              className="h-full bg-indigo-600 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-2">
        <div className="text-xs text-gray-500">并发数</div>
        <input
          type="range"
          min="1"
          max="5"
          value={concurrency}
          onChange={(e) => onConcurrencyChange(parseInt(e.target.value))}
          className="w-full"
        />
        <div className="text-center text-sm text-gray-600">{concurrency}</div>
      </div>

      <div className="mt-auto space-y-2">
        <button
          onClick={onStart}
          disabled={isPaused}
          className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium"
        >
          全部开始
        </button>
        <button
          onClick={onPause}
          disabled={!isPaused}
          className="w-full px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50 text-sm font-medium"
        >
          {isPaused ? '已暂停' : '全部暂停'}
        </button>
        <button
          onClick={onStop}
          className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm font-medium"
        >
          全部停止
        </button>
      </div>
    </div>
  )
}