import { useContextStore, CharacterState } from '../../stores/useContextStore'
import { useProjectStore } from '../../stores/useProjectStore'

export default function SceneMarkers() {
  const { characters } = useContextStore()
  const { currentProject } = useProjectStore()

  if (!currentProject) return null

  return (
    <div className="p-4">
      <h3 className="font-medium text-gray-700 mb-3">场景标记</h3>
      {characters.length === 0 ? (
        <p className="text-sm text-gray-500">暂无场景标记</p>
      ) : (
        <div className="space-y-2">
          {characters.map((char) => (
            <div key={char.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
              <span className={`w-2 h-2 rounded-full ${char.locked ? 'bg-yellow-500' : 'bg-blue-500'}`} />
              <span className="font-medium">{char.name}</span>
              {char.locked && <span className="text-xs text-yellow-600">已锁定</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}