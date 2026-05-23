import { useProjectStore } from '../../stores/useProjectStore'

const stages = [
  { key: 'split', label: '分章', icon: '📑' },
  { key: 'summary', label: '\u6458\u8981', icon: '\u{1F4DD}' },
  { key: 'scan', label: '\u573A\u666F\u8BC6\u522B', icon: '\u{1F50D}' },
  { key: 'rewrite', label: '\u6539\u5199', icon: '\u270F\uFE0F' },
  { key: 'quality', label: '自检', icon: '✅' },
  { key: 'preview', label: '预览', icon: '👁️' },
  { key: 'export', label: '导出', icon: '📤' }
] as const

export default function StageNavigation() {
  const { currentStage, setCurrentStage } = useProjectStore()

  return (
    <div className="flex items-center gap-1">
      {stages.map((stage, index) => (
        <div key={stage.key} className="flex items-center">
          <button
            onClick={() => setCurrentStage(stage.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              currentStage === stage.key
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            <span>{stage.icon}</span>
            <span>{stage.label}</span>
          </button>
          {index < stages.length - 1 && (
            <span className="text-gray-300 mx-1">›</span>
          )}
        </div>
      ))}
    </div>
  )
}