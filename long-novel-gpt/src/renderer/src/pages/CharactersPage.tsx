import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { useProjectStore } from '../stores/useProjectStore'
import { useContextStore, CharacterState } from '../stores/useContextStore'

export default function CharactersPage() {
  const { setPage } = useAppStore()
  const { currentProject } = useProjectStore()
  const { characters, setCharacters, updateCharacter, removeCharacter } = useContextStore()
  const [editingChar, setEditingChar] = useState<CharacterState | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)

  useEffect(() => {
    if (!currentProject) return

    const loadCharacters = async () => {
      const result = await window.api.context.getStates(currentProject.id)
      if (result.success && result.data) {
        const mapped = (result.data as any[]).map((c: any) => ({
          id: c.id,
          name: c.name,
          alias: c.alias,
          description: c.description,
          stateSnapshot: JSON.parse(c.state_snapshot || '{}'),
          source: c.source as 'auto' | 'manual',
          locked: c.locked === 1,
          updatedAt: c.updated_at,
          updatedFromChapter: c.updated_from_chapter
        }))
        setCharacters(mapped)
      }
    }

    loadCharacters()
  }, [currentProject])

  const handleLock = async (char: CharacterState) => {
    await window.api.context.lockState(char.id, !char.locked)
    updateCharacter(char.id, { locked: !char.locked })
  }

  const handleDelete = async (charId: string) => {
    if (!confirm('确定要删除这个角色吗？')) return
    await window.api.db.mutation('character_state', 'delete', {}, 'id = ?', [charId])
    removeCharacter(charId)
  }

  const handleEdit = (char: CharacterState) => {
    setEditingChar({ ...char })
    setIsModalOpen(true)
  }

  const handleSave = async () => {
    if (!editingChar || !currentProject) return

    const data = {
      name: editingChar.name,
      alias: editingChar.alias,
      description: editingChar.description,
      state_snapshot: JSON.stringify(editingChar.stateSnapshot),
      source: 'manual' as const,
      locked: editingChar.locked ? 1 : 0
    }

    await window.api.db.mutation('character_state', 'update', data, 'id = ?', [editingChar.id])
    updateCharacter(editingChar.id, editingChar)
    setIsModalOpen(false)
    setEditingChar(null)
  }

  if (!currentProject) {
    return (
      <div className="p-8 text-center text-gray-500">
        请先创建一个项目
      </div>
    )
  }

  return (
    <div className="p-8">
      <button
        onClick={() => setPage('workbench')}
        className="mb-4 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg"
      >
        &larr; 返回工作台
      </button>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">角色管理</h1>

      <div className="space-y-4">
        {characters.map((char) => (
          <div key={char.id} className="bg-white rounded-lg shadow p-6">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="font-semibold text-lg">{char.name}</h3>
                  {char.alias && <span className="text-gray-500">({char.alias})</span>}
                  {char.locked && (
                    <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded text-xs">已锁定</span>
                  )}
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    char.source === 'auto' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                  }`}>
                    {char.source === 'auto' ? 'AI' : '手动'}
                  </span>
                </div>

                {char.description && (
                  <p className="text-sm text-gray-600 mb-3">{char.description}</p>
                )}

                <div className="bg-gray-50 rounded-lg p-3 text-sm">
                  <h4 className="font-medium text-gray-700 mb-2">状态快照</h4>
                  <div className="grid grid-cols-2 gap-2 text-gray-600">
                    {typeof char.stateSnapshot === 'object' && char.stateSnapshot !== null ? (
                      <>
                        {char.stateSnapshot.appearance && (
                          <div><span className="text-gray-500">外观:</span> {char.stateSnapshot.appearance}</div>
                        )}
                        {char.stateSnapshot.emotion && (
                          <div><span className="text-gray-500">情绪:</span> {char.stateSnapshot.emotion}</div>
                        )}
                        {char.stateSnapshot.location && (
                          <div><span className="text-gray-500">位置:</span> {char.stateSnapshot.location}</div>
                        )}
                        {char.stateSnapshot.status && (
                          <div><span className="text-gray-500">状态:</span> {char.stateSnapshot.status}</div>
                        )}
                        {char.stateSnapshot.relationships && (
                          <div className="col-span-2">
                            <span className="text-gray-500">关系:</span> {JSON.stringify(char.stateSnapshot.relationships)}
                          </div>
                        )}
                      </>
                    ) : (
                      <div>{String(char.stateSnapshot)}</div>
                    )}
                  </div>
                </div>

                {char.updatedFromChapter !== null && (
                  <p className="text-xs text-gray-400 mt-2">
                    来源: 第{char.updatedFromChapter}章 | 更新于: {new Date(char.updatedAt).toLocaleString()}
                  </p>
                )}
              </div>

              <div className="flex gap-2 ml-4">
                <button
                  onClick={() => handleLock(char)}
                  className={`px-3 py-1.5 text-sm rounded ${
                    char.locked
                      ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {char.locked ? '解锁' : '锁定'}
                </button>
                <button
                  onClick={() => handleEdit(char)}
                  className="px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded"
                >
                  编辑
                </button>
                <button
                  onClick={() => handleDelete(char.id)}
                  className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {characters.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <p>暂无角色</p>
          <p className="text-sm text-gray-400 mt-2">开始改写后，AI 会自动发现并记录角色</p>
        </div>
      )}

      {isModalOpen && editingChar && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
            <h2 className="text-xl font-semibold mb-4">编辑角色</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">名称</label>
                <input
                  type="text"
                  value={editingChar.name}
                  onChange={(e) => setEditingChar({ ...editingChar, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">别名</label>
                <input
                  type="text"
                  value={editingChar.alias || ''}
                  onChange={(e) => setEditingChar({ ...editingChar, alias: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">描述</label>
                <textarea
                  value={editingChar.description || ''}
                  onChange={(e) => setEditingChar({ ...editingChar, description: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">外观</label>
                <input
                  type="text"
                  value={editingChar.stateSnapshot.appearance || ''}
                  onChange={(e) => setEditingChar({
                    ...editingChar,
                    stateSnapshot: { ...editingChar.stateSnapshot, appearance: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">情绪</label>
                <input
                  type="text"
                  value={editingChar.stateSnapshot.emotion || ''}
                  onChange={(e) => setEditingChar({
                    ...editingChar,
                    stateSnapshot: { ...editingChar.stateSnapshot, emotion: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">位置</label>
                <input
                  type="text"
                  value={editingChar.stateSnapshot.location || ''}
                  onChange={(e) => setEditingChar({
                    ...editingChar,
                    stateSnapshot: { ...editingChar.stateSnapshot, location: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                <input
                  type="text"
                  value={editingChar.stateSnapshot.status || ''}
                  onChange={(e) => setEditingChar({
                    ...editingChar,
                    stateSnapshot: { ...editingChar.stateSnapshot, status: e.target.value }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editingChar.locked}
                  onChange={(e) => setEditingChar({ ...editingChar, locked: e.target.checked })}
                />
                <span>锁定（AI 不再覆盖此角色）</span>
              </label>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setIsModalOpen(false)
                  setEditingChar(null)
                }}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}