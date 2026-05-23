import { useState, useRef, useCallback, useEffect } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useContextStore } from '../../../stores/useContextStore'
import { useSummaryGeneration, createSaveAndStore } from '../../../hooks/useSummaryGeneration'
import type { SummaryGenerationInput, ModelConfig } from '../../../hooks/useSummaryGeneration'

export default function SummaryStage() {
  const { chapters, currentChapterIndex, setCurrentChapterIndex, currentProject, setActiveChapterIds } = useProjectStore()
  const { chapterSummaries, hasSummaryIds, addChapterSummary, loadChapterSummary } = useContextStore()
  const currentChapter = chapters[currentChapterIndex]

  const { generateSummary, error: genError } = useSummaryGeneration()

  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [selModelId, setSelModelId] = useState('')
  const selModelIdRef = useRef('')

  useEffect(() => {
    let cancelled = false
    window.api.db.query('models').then(r => {
      if (!cancelled && r.success && r.data) {
        const m = r.data as any[]
        setModels(m)
        if (m.length > 0) {
          setSelModelId(m[0].id)
          selModelIdRef.current = m[0].id
        }
      }
    })
    return () => { cancelled = true; isGeneratingRef.current = false }
  }, [])

  const [activeTab, setActiveTab] = useState<'plot' | 'characters' | 'events'>('plot')
  const isGeneratingRef = useRef(false)

  // Load summary for current chapter on demand
  useEffect(() => {
    if (currentChapter && currentProject) {
      loadChapterSummary(currentProject.id, currentChapter.id)
    }
  }, [currentChapter?.id, currentProject?.id])

  const currentSummary = chapterSummaries.find(s => s.chapterId === currentChapter?.id)

  // Resolve the model config from the store
  const getModelConfig = useCallback(async (): Promise<ModelConfig | null> => {
    const modelResult = await window.api.db.query('models', 'id = ?', [selModelIdRef.current || selModelId])
    if (!modelResult.success || !modelResult.data?.length) {
      alert('请先在「模型管理」页面添加至少一个 AI 模型')
      return null
    }
    const model = modelResult.data[0] as any
    return {
      baseUrl: model.base_url,
      modelId: model.model_id,
      apiKey: model.api_key_encrypted,
    }
  }, [selModelId])

  // Build the input from a chapter
  const buildInput = useCallback(async (chapter: typeof chapters[number]): Promise<SummaryGenerationInput> => {
    let text = (chapter as any).originalText || ''
    if (!text) {
      const tr = await window.api.db.query('chapters', 'id = ?', [chapter.id], 'original_text')
      text = (tr.success && tr.data?.length) ? ((tr.data as any[])[0].original_text || '') : ''
    }
    return {
      chapterId: chapter.id,
      title: chapter.title,
      content: text,
      sceneTags: (chapter as any).sceneTags as SummaryGenerationInput['sceneTags'] | undefined,
    }
  }, [])

  const saveAndStore = useCallback(
    createSaveAndStore(generateSummary, addChapterSummary, currentProject?.id || ''),
    [generateSummary, addChapterSummary, currentProject?.id],
  )

  // Generate summary for a single chapter
  const generateOne = useCallback(async (chapterId: string, _chapterIdx: number, forceRegen = false): Promise<boolean> => {
    const ch = chapters.find(c => c.id === chapterId)
    if (!ch || !currentProject) return false

    // Skip if already has summary (unless force re-gen)
    if (!forceRegen && hasSummaryIds.has(chapterId)) return true

    try {
      setActiveChapterIds(prev => [...prev, chapterId])
      const modelConfig = await getModelConfig()
      if (!modelConfig) return false

      const input = await buildInput(ch)
      await saveAndStore(input, modelConfig)
      return true
    } catch {
      return false
    } finally {
      setActiveChapterIds(prev => prev.filter(id => id !== chapterId))
    }
  }, [chapters, currentProject, hasSummaryIds, getModelConfig, buildInput, saveAndStore])

  // Batch generate all
  const handleBatchGenerate = async () => {
    if (isGeneratingRef.current) return
    isGeneratingRef.current = true
    setGenerating(true)
    setProgress(0)

    const pending = chapters.filter(ch => !hasSummaryIds.has(ch.id))

    if (pending.length === 0) {
      setProgressText('所有章节已有摘要')
      setGenerating(false)
      isGeneratingRef.current = false
      return
    }

    let done = 0
    for (const ch of pending) {
      setProgressText(`正在生成：${ch.title} (${done + 1}/${pending.length})`)
      const ok = await generateOne(ch.id, ch.chapterIndex)
      done++
      setProgress(Math.round((done / pending.length) * 100))
      // Small delay between chapters to avoid rate limiting
      if (done < pending.length && ok) {
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    setProgressText(`完成：${done}/${pending.length} 章`)
    setGenerating(false)
    isGeneratingRef.current = false
  }

  // Generate single current chapter
  const handleGenerateCurrent = async () => {
    if (!currentChapter || isGeneratingRef.current) return
    isGeneratingRef.current = true
    setGenerating(true)
    setProgressText(`正在生成：${currentChapter.title}`)
    // Delete old summary before regenerating
    await window.api.db.mutation('chapter_summaries', 'delete', {}, 'chapter_id = ?', [currentChapter.id])
    await generateOne(currentChapter.id, currentChapter.chapterIndex, true)
    setProgressText('完成')
    setGenerating(false)
    isGeneratingRef.current = false
  }

  // Export MD
  const handleExportMd = async () => {
    const r = await window.api.fs.selectDirectory({ title: '选择导出目录' })
    if (!r.success || !r.data) return

    const summaries = chapterSummaries || []
    let md = `# ${currentProject?.name || '小说'} — 章节摘要分析\n\n`
    md += `> 生成时间：${new Date().toLocaleString()}\n`
    md += `> 总章节数：${chapters.length} | 已分析：${summaries.length}\n\n---\n\n`

    for (const ch of chapters) {
      const s = summaries.find(x => x.chapterId === ch.id)
      md += `## ${ch.title || `第${ch.chapterIndex}章`}\n\n`
      if (s) {
        md += `### 情节概要\n${s.plotSummary}\n\n`
        const additions = s.additions || []
        const characters = additions.filter(a => a.type === '人物')
        const events = additions.filter(a => a.type === '关键事件')

        if (characters.length > 0) { md += `### 主要人物\n`; characters.forEach(c => md += `- ${c.content}\n`); md += '\n' }
        if (events.length > 0) { md += `### 关键事件\n`; events.forEach(e => md += `- ${e.content}\n`); md += '\n' }
      } else {
        md += `*（未生成摘要）*\n\n`
      }
      md += `---\n\n`
    }

    const fileName = `${currentProject?.name || 'novel'}_summary_${new Date().toISOString().slice(0, 10)}.md`
    await window.api.fs.saveFile(`${r.data.dirPath}/${fileName}`, md)
    alert(`导出完成：${fileName}`)
  }

  // Display helpers
  const renderSummaryContent = () => {
    if (!currentSummary) {
      return <p className="text-gray-400 italic text-sm">当前章节暂无摘要，点击"生成当前章摘要"或"全部生成"</p>
    }
    const additions = currentSummary.additions || []
    const characters = additions.filter(a => a.type === '人物')
    const events = additions.filter(a => a.type === '关键事件')

    switch (activeTab) {
      case 'plot':
        return <div className="whitespace-pre-wrap text-sm leading-relaxed prose prose-sm max-w-none">{currentSummary.plotSummary}</div>
      case 'characters':
        return characters.length > 0
          ? <ul className="space-y-1 text-sm">{characters.map((c, i) => <li key={i} className="text-gray-700">- {c.content}</li>)}</ul>
          : <p className="text-gray-400 italic text-sm">无人物信息</p>
      case 'events':
        return events.length > 0
          ? <ul className="space-y-1 text-sm">{events.map((e, i) => <li key={i} className="text-gray-700">- {e.content}</li>)}</ul>
          : <p className="text-gray-400 italic text-sm">无关键事件</p>
    }
  }

  const tabs = [
    { key: 'plot' as const, label: '内容总结', count: 0 },
    { key: 'characters' as const, label: '主要人物', count: currentSummary?.additions?.filter(a => a.type === '人物').length || 0 },
    { key: 'events' as const, label: '关键事件', count: currentSummary?.additions?.filter(a => a.type === '关键事件').length || 0 },
  ]

  const summaryCount = chapters.filter(ch => hasSummaryIds.has(ch.id)).length

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-gray-800">章节摘要</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{summaryCount}/{chapters.length} 章已完成</span>
          <button onClick={handleGenerateCurrent} disabled={generating}
            className="px-4 py-2 text-sm bg-white border border-indigo-600 text-indigo-600 rounded-lg hover:bg-indigo-50 disabled:opacity-50">
            生成当前章摘要
          </button>
          <button onClick={handleBatchGenerate} disabled={generating}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
            {generating ? `生成中 ${progress}%` : '全部生成'}
          </button>
          <button onClick={handleExportMd} disabled={summaryCount === 0}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">
            导出 .md
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {generating && (
        <div className="mb-4">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{progressText}</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {/* Error display */}
      {genError && (
        <div className="mb-4 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {genError}
        </div>
      )}

      {/* Content: chapter list + summary detail */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Chapter list */}
        <div className="w-56 flex-shrink-0 border border-gray-200 rounded-lg overflow-auto bg-white">
          <div className="p-2 border-b border-gray-100 text-xs text-gray-500 font-medium">章节列表</div>
          {chapters.map((ch, i) => {
            const hasSummary = hasSummaryIds.has(ch.id)
            return (
              <div key={ch.id}
                onClick={() => setCurrentChapterIndex(i)}
                className={`px-3 py-2 cursor-pointer text-sm border-b border-gray-50 transition ${
                  i === currentChapterIndex ? 'bg-indigo-50 border-l-2 border-l-indigo-500' : 'hover:bg-gray-50'
                }`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${hasSummary ? 'bg-green-400' : 'bg-gray-300'}`} />
                  <span className="truncate text-gray-700">{ch.title}</span>
                </div>
              </div>
            )
          })}
        </div>

        {/* Summary detail */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tabs */}
          <div className="flex gap-1 mb-3">
            {tabs.map(t => (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                className={`px-3 py-1.5 text-xs rounded-lg transition ${
                  activeTab === t.key ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                }`}>
                {t.label}{t.count > 0 ? ` (${t.count})` : ''}
              </button>
            ))}
          </div>

          {/* Content area */}
          <div className="flex-1 bg-white border border-gray-200 rounded-lg p-4 overflow-auto">
            <h3 className="font-medium text-gray-800 text-sm mb-3">
              {currentChapter?.title || '选择章节'}
            </h3>
            {renderSummaryContent()}
          </div>
        </div>
      </div>
    </div>
  )
}
