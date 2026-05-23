import { useState } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useContextStore } from '../../../stores/useContextStore'

export default function ExportStage() {
  const { chapters, currentProject } = useProjectStore()
  const { chapterSummaries } = useContextStore()
  const [isExporting, setIsExporting] = useState(false)
  const [exportOptions, setExportOptions] = useState({
    format: 'txt',
    includeOriginal: false,
    includeSummary: false
  })
  const [exportStatus, setExportStatus] = useState<string>('')

  const rewrittenChapters = chapters.filter(ch => ch.rewrittenText)
  const canExport = rewrittenChapters.length > 0

  const getSummaryText = (chapterId: string): string => {
    const s = chapterSummaries.find(x => x.chapterId === chapterId)
    if (!s) return ''
    let text = `【情节概要】\n${s.plotSummary}\n`
    if (s.additions && s.additions.length > 0) {
      const byType: Record<string, string[]> = {}
      for (const a of s.additions) {
        if (!byType[a.type]) byType[a.type] = []
        byType[a.type].push(a.content)
      }
      for (const [type, items] of Object.entries(byType)) {
        text += `\n【${type}】\n${items.join('\n')}\n`
      }
    }
    return text
  }

  const handleExport = async () => {
    if (!canExport) return

    setIsExporting(true)
    setExportStatus('正在选择导出目录...')

    const result = await window.api.fs.selectDirectory({ title: '选择导出目录' })
    if (!result.success || !result.data) {
      setIsExporting(false)
      return
    }

    const dirPath = result.data.dirPath
    const timestamp = new Date().toISOString().slice(0, 10)

    if (exportOptions.format === 'txt') {
      setExportStatus(`正在导出 ${rewrittenChapters.length} 个章节...`)

      for (let i = 0; i < rewrittenChapters.length; i++) {
        const chapter = rewrittenChapters[i]
        const fileName = `${chapter.title || `Chapter_${chapter.chapterIndex + 1}`}_${timestamp}.txt`
        const filePath = `${dirPath}/${fileName}`

        let content = ''
        if (exportOptions.includeOriginal && chapter.originalText) {
          content += `=== 原文 ===\n${chapter.originalText}\n\n`
        }
        content += `=== 改写后 ===\n${chapter.rewrittenText || ''}`
        if (exportOptions.includeSummary) {
          const summary = getSummaryText(chapter.id)
          if (summary) content += `\n\n=== 章节摘要 ===\n${summary}`
        }

        await window.api.fs.saveFile(filePath, content)
        setExportStatus(`已导出 ${i + 1}/${rewrittenChapters.length}`)
      }
    }

    setExportStatus(`导出完成！共 ${rewrittenChapters.length} 章`)
    setIsExporting(false)
  }

  const handleExportAll = async () => {
    if (!canExport) return

    setIsExporting(true)
    setExportStatus('正在合并所有章节...')

    const result = await window.api.fs.selectDirectory({ title: '选择导出目录' })
    if (!result.success || !result.data) {
      setIsExporting(false)
      return
    }

    const dirPath = result.data.dirPath
    const timestamp = new Date().toISOString().slice(0, 10)
    const fileName = `${currentProject?.name || 'novel'}_merged_${timestamp}.txt`
    const filePath = `${dirPath}/${fileName}`

    let mergedContent = ''
    for (const chapter of rewrittenChapters) {
      mergedContent += `\n\n=== ${chapter.title || `第${chapter.chapterIndex + 1}章`} ===\n\n`
      if (exportOptions.includeOriginal && chapter.originalText) {
        mergedContent += `【原文】\n${chapter.originalText}\n\n`
      }
      mergedContent += `【改写】\n${chapter.rewrittenText || ''}`
      if (exportOptions.includeSummary) {
        const summary = getSummaryText(chapter.id)
        if (summary) mergedContent += `\n\n【章节摘要】\n${summary}`
      }
    }

    await window.api.fs.saveFile(filePath, mergedContent)
    setExportStatus('合并导出完成！')
    setIsExporting(false)
  }

  return (
    <div className="p-6">
      <h2 className="text-xl font-semibold text-gray-800 mb-4">导出阶段</h2>

      <div className="mb-6">
        <p className="text-gray-600 mb-2">
          可导出章节: <span className="font-medium text-indigo-600">{rewrittenChapters.length}</span> / {chapters.length}
        </p>
        {!canExport && (
          <p className="text-sm text-gray-500">请先完成至少一章的改写</p>
        )}
      </div>

      <div className="bg-gray-50 rounded-lg p-4 mb-6">
        <h3 className="font-medium text-gray-700 mb-3">导出选项</h3>
        <div className="space-y-3">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={exportOptions.includeOriginal}
              onChange={(e) => setExportOptions({ ...exportOptions, includeOriginal: e.target.checked })}
              className="w-4 h-4 text-indigo-600 rounded"
            />
            <span className="text-sm text-gray-700">包含原文</span>
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={exportOptions.includeSummary}
              onChange={(e) => setExportOptions({ ...exportOptions, includeSummary: e.target.checked })}
              className="w-4 h-4 text-indigo-600 rounded"
            />
            <span className="text-sm text-gray-700">包含摘要</span>
          </label>
        </div>
      </div>

      {isExporting && (
        <div className="mb-6">
          <div className="flex items-center gap-2 text-indigo-600">
            <span className="animate-spin">⟳</span>
            <span>{exportStatus}</span>
          </div>
        </div>
      )}

      <div className="flex gap-4 mb-6">
        <button
          onClick={handleExport}
          disabled={!canExport || isExporting}
          className="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium"
        >
          {isExporting ? '导出中...' : '逐章导出'}
        </button>
        <button
          onClick={handleExportAll}
          disabled={!canExport || isExporting}
          className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium"
        >
          合并导出
        </button>
      </div>

      {rewrittenChapters.length > 0 && (
        <div>
          <h3 className="font-medium text-gray-700 mb-3">可导出章节列表</h3>
          <div className="space-y-2 max-h-64 overflow-auto">
            {rewrittenChapters.map((ch) => (
              <div key={ch.id} className="flex items-center gap-3 p-2 bg-white border border-gray-200 rounded">
                <span className="text-green-600">✓</span>
                <span className="font-medium">{ch.title || `第${ch.chapterIndex + 1}章`}</span>
                <span className="text-xs text-gray-500">
                  {ch.rewrittenText?.length || 0} 字
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}