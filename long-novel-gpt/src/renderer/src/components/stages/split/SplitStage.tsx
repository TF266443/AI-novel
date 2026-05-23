import { useState } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'

export default function SplitStage() {
  const { chapters, currentChapterIndex, setCurrentChapterIndex, setChapters } = useProjectStore()
  const currentChapter = chapters[currentChapterIndex]

  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const handleTitleEdit = (index: number, title: string) => {
    setEditingIndex(index)
    setEditTitle(title)
  }

  const handleTitleSave = (index: number) => {
    if (editingIndex === index) {
      const newChapters = [...chapters]
      newChapters[index] = { ...newChapters[index], title: editTitle }
      setChapters(newChapters)
      setEditingIndex(null)
    }
  }

  const handleMerge = (index: number) => {
    if (index < chapters.length - 1) {
      const newChapters = [...chapters]
      newChapters[index] = {
        ...newChapters[index],
        title: `${newChapters[index].title} + ${newChapters[index + 1].title}`,
        originalText: newChapters[index].originalText + '\n\n' + newChapters[index + 1].originalText
      }
      newChapters.splice(index + 1, 1)
      setChapters(newChapters)
    }
  }

  const handleSplit = (index: number) => {
    const chapter = chapters[index]
    const midpoint = Math.floor(chapter.originalText.length / 2)

    const firstHalf = chapter.originalText.slice(0, midpoint)
    const secondHalf = chapter.originalText.slice(midpoint)

    const newChapters = [...chapters]
    newChapters[index] = { ...newChapters[index], originalText: firstHalf }
    newChapters.splice(index + 1, 0, {
      ...chapter,
      id: Date.now().toString(),
      chapterIndex: index + 1,
      originalText: secondHalf,
      title: `${chapter.title} (后半)`
    })

    for (let i = index + 2; i < newChapters.length; i++) {
      newChapters[i].chapterIndex = i
    }

    setChapters(newChapters)
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800">分章预览</h2>
        <p className="text-sm text-gray-500">
          共 {chapters.length} 章 | 当前第 {currentChapterIndex + 1} 章
        </p>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-1">
          <h3 className="font-medium text-gray-700 mb-3">章节列表</h3>
          <div className="space-y-2 max-h-96 overflow-auto">
            {chapters.map((ch, index) => (
              <div
                key={ch.id}
                className={`p-3 rounded-lg cursor-pointer transition ${
                  index === currentChapterIndex ? 'bg-indigo-100 border-2 border-indigo-500' : 'bg-gray-50 hover:bg-gray-100'
                }`}
                onClick={() => setCurrentChapterIndex(index)}
              >
                {editingIndex === index ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="flex-1 px-2 py-1 text-sm border rounded"
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => handleTitleSave(index)}
                      onKeyDown={(e) => e.key === 'Enter' && handleTitleSave(index)}
                    />
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{ch.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleTitleEdit(index, ch.title)
                      }}
                      className="text-gray-400 hover:text-indigo-600 text-xs"
                    >
                      ✎
                    </button>
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  {ch.originalText.length} 字 | {ch.status}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-gray-700">
              {currentChapter?.title || '选择章节'}
            </h3>
            {currentChapter && (
              <div className="flex gap-2">
                <button
                  onClick={() => handleSplit(currentChapterIndex)}
                  className="px-3 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                >
                  拆分
                </button>
                <button
                  onClick={() => handleMerge(currentChapterIndex)}
                  className="px-3 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                >
                  合并下一章
                </button>
              </div>
            )}
          </div>

          {currentChapter ? (
            <div className="border border-gray-200 rounded-lg p-4 h-96 overflow-auto">
              <pre className="whitespace-pre-wrap text-sm">{currentChapter.originalText}</pre>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg p-4 h-96 flex items-center justify-center">
              <p className="text-gray-400">点击左侧章节查看内容</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}