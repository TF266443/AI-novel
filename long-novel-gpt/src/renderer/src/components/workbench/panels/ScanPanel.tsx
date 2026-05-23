import { useState, useRef, useEffect } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useScanAnalysis } from '../../../hooks/useScanAnalysis'
import EvalTab from './EvalTab'

export default function ScanPanel() {
  const { chapters, currentProject, updateChapterSceneTags, scannedChapterIds } = useProjectStore()
  const { analyze } = useScanAnalysis()
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const runningRef = useRef(false)
  const pausedRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [activeTab, setActiveTab] = useState<'scan' | 'eval'>('scan')

  useEffect(() => {
    if (!currentProject?.templateId) return
    let cancelled = false
    window.api.db.query('templates', 'id = ?', [currentProject.templateId]).then(r => {
      if (cancelled || !r.success || !r.data?.length) return
      try {
        const tpl = JSON.parse((r.data[0] as any).template_json)
        const identifyTemplate = typeof tpl.identifyTemplate === 'string' ? JSON.parse(tpl.identifyTemplate) : tpl.identifyTemplate
        if (!cancelled && identifyTemplate?.categories) setCategories(identifyTemplate.categories)
      } catch { /* */ }
    })
    return () => { cancelled = true }
  }, [currentProject?.templateId])

  // Derive scanned count from both Set AND chapter data (robust against sync edge cases)
  const scannedFromChapters = chapters.filter(ch => (ch.sceneTags && ch.sceneTags.length > 0) || ch.scanMetrics !== undefined).length
  const scanned = Math.max(scannedChapterIds.size, scannedFromChapters)
  const total = chapters.length
  const pct = total > 0 ? Math.round((scanned / total) * 100) : 0

  const handleScanAll = async () => {
    if (running && !paused) return
    if (paused) { pausedRef.current = false; setPaused(false); return }

    if (!currentProject) return
    const controller = new AbortController()
    abortRef.current = controller
    runningRef.current = true; pausedRef.current = false
    setRunning(true); setPaused(false); setProgress(0)

    try {
      // Find AI model
      const modelsResult = await window.api.db.query('models')
      const models = (modelsResult.success && modelsResult.data) ? (modelsResult.data as any[]) : []
      const aiModel = models.find((m: any) => m.tier === 'high' || m.tier === 'low' || (!/embed/i.test(m.model_id || '')))
      if (!aiModel?.base_url || !aiModel?.model_id) { setStatus('\u672A\u627E\u5230\u53EF\u7528\u7684 AI \u6A21\u578B'); setRunning(false); runningRef.current = false; return }

      const embedModel = models.find((m: any) => /embed|nomic/i.test(m.model_id || '') || /embed|nomic/i.test(m.name || ''))

      const pending = chapters.filter(ch => !scannedChapterIds.has(ch.id))

      if (pending.length === 0) { setStatus('\u5168\u90E8\u5DF2\u5206\u6790'); setRunning(false); runningRef.current = false; return }

      const origScanned = chapters.length - pending.length
      let done = 0

      for (const ch of pending) {
        while (pausedRef.current && runningRef.current) await new Promise(r => setTimeout(r, 500))
        if (!runningRef.current) break

        setStatus(`AI \u5206\u6790\u4E2D... ${done + 1}/${pending.length}: ${ch.title || `\u7B2C${ch.chapterIndex + 1}\u7AE0`}`)

        // Load chapter text on demand
        let text = ch.originalText
        if (!text) {
          const tr = await window.api.db.query('chapters', 'id = ?', [ch.id], 'original_text')
          text = (tr.success && tr.data?.length) ? ((tr.data as any[])[0].original_text || '') : ''
          if (!text) { done++; continue }
        }

        // Load scene data before accessing tags (DB direct to avoid stale store ref)
        const sr = await window.api.db.query('chapters', 'id = ?', [ch.id], 'scene_tags')
        const sceneData: any[] = (sr.success && sr.data?.length)
          ? JSON.parse((sr.data as any[])[0].scene_tags || '[]') : []
        const manualTags = sceneData.filter((t: any) => t.source === 'manual')

        try {
          const merged = await analyze(text, ch.id, categories, {
            baseUrl: aiModel.base_url, modelId: aiModel.model_id, apiKey: aiModel.api_key_encrypted || '',
          }, manualTags, {
            signal: controller.signal,
            onProgress: (s) => setStatus(`${s} \u2014 ${ch.title || `\u7B2C${ch.chapterIndex + 1}\u7AE0`}`),
            enableEmbeddingRecall: !!embedModel,
            embeddingModel: embedModel ? { baseUrl: embedModel.base_url, modelId: embedModel.model_id!, apiKey: embedModel.api_key_encrypted } : undefined,
            projectId: currentProject.id,
          })
          updateChapterSceneTags(ch.id, merged)
        } catch (err) { console.error(`Failed chapter ${ch.chapterIndex}:`, err) }

        done++
        setProgress(Math.round(((origScanned + done) / total) * 100))
      }

      setStatus(done === pending.length ? '\u5168\u90E8\u5B8C\u6210' : `\u5DF2\u5904\u7406 ${done}/${pending.length}`)
    } finally {
      setRunning(false); setPaused(false)
      runningRef.current = false; pausedRef.current = false
    }
  }

  return (
    <div className="flex-1 flex flex-col">
      <div className="flex border-b shrink-0">
        <button className={`flex-1 py-1.5 text-xs font-medium ${activeTab === 'scan' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}
          onClick={() => setActiveTab('scan')}>{'\u6807\u8BB0'}</button>
        <button className={`flex-1 py-1.5 text-xs font-medium ${activeTab === 'eval' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}
          onClick={() => setActiveTab('eval')}>{'\u8BC4\u4F30'}</button>
      </div>

      {activeTab === 'scan' ? (
        <div className="flex-1 flex flex-col p-4">
          <h2 className="font-semibold text-gray-700 mb-4 text-sm">{'\u573A\u666F\u6807\u8BB0\u7EDF\u8BA1'}</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">{'\u5DF2\u5206\u6790'}</span><span className="font-medium text-green-600">{scanned}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">{'\u672A\u5206\u6790'}</span><span className="font-medium text-gray-400">{total - scanned}</span></div>
            <div className="border-t border-gray-200 pt-3 mt-3">
              <div className="flex justify-between text-xs text-gray-500"><span>{'\u8FDB\u5EA6'}</span><span>{pct}%</span></div>
              <div className="w-full h-2 bg-gray-200 rounded mt-1 overflow-hidden"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} /></div>
            </div>
            {running && <p className="text-xs text-indigo-600 mt-2">{status}</p>}
          </div>
          <div className="mt-auto space-y-2 pt-4 border-t border-gray-200">
            <button onClick={async () => {
              abortRef.current?.abort(); runningRef.current = false; pausedRef.current = false
              setRunning(false); setPaused(false)
              // Direct store update: clear tags, metrics, scannedChapterIds for all chapters
              useProjectStore.setState(state => ({
                chapters: state.chapters.map(ch => ({ ...ch, sceneTags: [] as any[], scanMetrics: undefined })),
                scannedChapterIds: new Set<string>(),
              }))
              // Clear DB for all chapters
              for (const ch of chapters) {
                await window.api.db.mutation('chapters', 'update', { scene_tags: '[]', scan_metrics: null }, 'id = ?', [ch.id])
              }
              setProgress(0); setStatus('')
            }} disabled={running}
              className="w-full px-3 py-1.5 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded border border-gray-200 disabled:opacity-50">
              {'\u6E05\u9664\u5168\u90E8\u6807\u8BB0'}
            </button>
            <button onClick={handleScanAll} disabled={(running && !paused) || categories.length === 0}
              className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium">
              {running && !paused ? `\u5206\u6790\u4E2D ${progress}%` : '\u5168\u90E8 AI \u5206\u6790'}
            </button>
            <button onClick={() => { pausedRef.current = true; setPaused(true); setStatus('\u5DF2\u6682\u505C') }} disabled={!running || paused}
              className="w-full px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50 text-sm">{'\u6682\u505C'}</button>
            <button onClick={() => { abortRef.current?.abort(); runningRef.current = false; pausedRef.current = false; setRunning(false); setPaused(false); setStatus('\u5DF2\u505C\u6B62') }} disabled={!running}
              className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 disabled:opacity-50 text-sm">{'\u505C\u6B62'}</button>
          </div>
        </div>
      ) : (
        <EvalTab categories={categories} />
      )}
    </div>
  )
}
