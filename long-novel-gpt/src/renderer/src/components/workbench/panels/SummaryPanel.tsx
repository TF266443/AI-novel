import { useState, useRef, useEffect } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useContextStore } from '../../../stores/useContextStore'
import { nanoid } from 'nanoid'

export default function SummaryPanel() {
  const { chapters, currentProject, setCurrentChapterIndex, setActiveChapterIds } = useProjectStore()
  const { chapterSummaries, hasSummaryIds, addChapterSummary, setChapterSummaries } = useContextStore()
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [concurrency, setConcurrency] = useState(3)
  const runningRef = useRef(false)
  const pausedRef = useRef(false)
  const [models, setModels] = useState<Array<{ id: string; name: string; model_id: string; base_url: string; api_key_encrypted: string }>>([])
  const [selModelId, setSelModelId] = useState('')
  const selModelIdRef = useRef('')

  useEffect(() => {
    let cancelled = false
    window.api.db.query('models').then(r => {
      if (cancelled || !r.success || !r.data) return
      const m = r.data as any[];
      setModels(m)
      const firstId = m.length > 0 ? m[0].id : ''
      setSelModelId(firstId)
      selModelIdRef.current = firstId
    })
    return () => { cancelled = true; runningRef.current = false; pausedRef.current = false }
  }, [])

  const total = chapters.length
  const done = hasSummaryIds.size
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const generateOne = async (chapterId: string): Promise<boolean> => {
    const ch = chapters.find(c => c.id === chapterId)
    if (!ch || !currentProject) return false

    // Load chapter text on demand
    let text = ch.originalText
    if (!text) {
      const tr = await window.api.db.query('chapters', 'id = ?', [ch.id], 'original_text')
      text = (tr.success && tr.data?.length) ? ((tr.data as any[])[0].original_text || '') : ''
    }

    try {
      const mr = await window.api.db.query('models', 'id = ?', [selModelIdRef.current || selModelId])
      if (!mr.success || !mr.data?.length) {
        alert('请先在「模型管理」页面添加 AI 模型，并在右侧面板选择')
        return false
      }
      const model = mr.data[0] as any

      const prompt = `围绕主角视角，为以下章节生成内容总结。主角是戏份最多、推动剧情的核心人物。\n\n【章节标题】${ch.title}\n【章节内容】\n${text.slice(0, 4000)}\n\n以主角为中心返回JSON：\n{\n  "plot_summary": "以主角为主线，200-400字概括：主角做了什么、遇到谁、什么变化、做了什么决定",\n  "characters": [{"name": "角色名", "description": "与主角的关系及本章作用（主角排第一）"}],\n  "key_events": [{"event": "以主角视角描述关键事件：主动行为、遭遇的转折、情感变化"}]\n}`

      const msgs = [{ role: 'user', content: prompt }]
      const sid = nanoid()
      let resp = ''

      await new Promise<void>((resolve, reject) => {
        const u1 = window.api.ai.onToken(({ id, token }) => { if (id === sid) resp += token })
        const u2 = window.api.ai.onDone(({ id }) => { if (id === sid) { u1(); u2(); u3(); resolve() } })
        const u3 = window.api.ai.onError(({ id, error }) => { if (id === sid) { u1(); u2(); u3(); reject(new Error(error)) } })
        window.api.ai.stream({ id: sid, modelId: model.model_id, baseUrl: model.base_url, apiKey: model.api_key_encrypted, messages: msgs, temperature: 0.5, maxTokens: 2000 })
          .then(r => { if (!r.success) reject(new Error(r.error || 'AI failed')) })
      })

      const parsed = await window.api.ai.safeParseJson(resp)
      let data: any
      if (parsed.data && typeof parsed.data === 'object' && (parsed.data as any).plot_summary) {
        data = parsed.data
      } else {
        data = { plot_summary: resp.slice(0, 300), characters: [], key_events: [], environment: {}, clothing: [] }
      }

      const additions = [
        ...(data.characters || []).filter((c: any) => c.name).map((c: any) => ({ type: '人物', content: c.description || `${c.name}: ${c.role || ''}` })),
        ...(data.key_events || []).filter((e: any) => e.event).map((e: any) => ({ type: '关键事件', content: e.event + (e.significance ? ' — ' + e.significance : '') })),
      ]

      const r = await window.api.context.saveSummary({
        projectId: currentProject.id, chapterId,
        summary: { plot_summary: data.plot_summary, additions }
      })
      if (r.success && r.data) {
        addChapterSummary({ id: (r.data as any).id, chapterId, plotSummary: data.plot_summary, additions, createdAt: new Date().toISOString() })
      }
      return true
    } catch { return false }
  }

  const handleStart = async () => {
    if (runningRef.current && !pausedRef.current) return
    // Resume from pause
    if (pausedRef.current) {
      pausedRef.current = false
      setPaused(false)
      setRunning(true)
      return
    }
    // Fresh start
    runningRef.current = true
    pausedRef.current = false
    setRunning(true)
    setPaused(false)
    setProgress(0)

    const pending = chapters.filter(c => !hasSummaryIds.has(c.id))
    const CONCURRENT = concurrency
    let d = done
    let cursor = 0

    const processNext = async (): Promise<void> => {
      while (cursor < pending.length) {
        if (pausedRef.current) {
          await new Promise<void>(resolve => {
            const check = setInterval(() => { if (!pausedRef.current) { clearInterval(check); resolve() } }, 200)
          })
        }
        if (!runningRef.current) return

        const idx = cursor++
        const chId = pending[idx].id
        setActiveChapterIds(prev => [...prev, chId])
        setStatus(`${pending[idx].title} (${idx + 1}/${pending.length})`)
        const ok = await generateOne(chId)
        if (ok) d++
        setProgress(Math.round((d / total) * 100))
        setActiveChapterIds(prev => prev.filter(id => id !== chId))
      }
    }

    // Launch concurrent workers
    const pool = Array(Math.min(CONCURRENT, pending.length)).fill(null).map(() => processNext())
    await Promise.all(pool)

    if (!pausedRef.current) {
      setStatus('完成')
      setRunning(false)
    }
    runningRef.current = false
  }

  const handlePause = () => {
    if (!runningRef.current) return
    pausedRef.current = true
    setPaused(true)
    setRunning(false)
    setStatus('已暂停 — 点击"全部生成"继续')
  }

  const handleStop = () => {
    runningRef.current = false
    pausedRef.current = false
    setRunning(false)
    setPaused(false)
    setStatus('已停止')
  }

  const handleReset = async () => {
    runningRef.current = false
    pausedRef.current = false
    setRunning(false)
    setPaused(false)
    // Clear all summaries from DB
    for (const ch of chapters) {
      await window.api.db.mutation('chapter_summaries', 'delete', {}, 'chapter_id = ?', [ch.id])
    }
    // Clear store and local state
    setChapterSummaries([])
    setChapterSummaries([])
    setProgress(0)
    setStatus('')
    // Jump to chapter 1
    setCurrentChapterIndex(0)
  }

  return (
    <div className="flex-1 flex flex-col p-4">
      <select value={selModelId} onChange={e => { setSelModelId(e.target.value); selModelIdRef.current = e.target.value }}
        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 mb-3 text-gray-600">
        {models.length === 0 ? <option value="">无可用模型</option> : models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <h2 className="font-semibold text-gray-700 mb-4 text-sm">摘要统计</h2>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">已完成</span>
          <span className="font-medium text-green-600">{done}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">待处理</span>
          <span className="font-medium text-gray-400">{total - done}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">总章节数</span>
          <span className="font-medium">{total}</span>
        </div>

        <div className="border-t border-gray-200 pt-3 mt-3">
          <div className="flex justify-between text-xs text-gray-500">
            <span>进度</span>
            <span>{pct}%</span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded mt-1 overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {(running || paused) && (
          <div className="text-xs text-indigo-600 animate-pulse">{status}</div>
        )}
      </div>

      <div className="mt-4">
        <div className="flex justify-between text-xs text-gray-500"><span>并发数</span><span>{concurrency}</span></div>
        <input type="range" min="1" max="5" value={concurrency} disabled={running}
          onChange={e => setConcurrency(parseInt(e.target.value))} className="w-full" />
      </div>

      <div className="mt-auto space-y-2 pt-4 border-t border-gray-200">
        <button onClick={handleReset} disabled={running}
          className="w-full px-3 py-1.5 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded border border-gray-200">
          ⟳ 重新开始（清除所有摘要）
        </button>
        <button
          onClick={handleStart}
          disabled={running && !paused}
          className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium"
        >
          {paused ? '继续生成' : running ? `生成中 ${progress}%` : '全部生成'}
        </button>
        <button
          onClick={handlePause}
          disabled={!running || paused}
          className="w-full px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50 text-sm"
        >
          暂停
        </button>
        <button disabled={done === 0 || running}
          onClick={async () => {
            const r = await window.api.fs.selectDirectory({ title: '选择导出目录' })
            if (!r.success || !r.data) return
            let md = `# ${currentProject?.name || 'novel'} — 章节摘要\n\n> 生成时间：${new Date().toLocaleString()}\n\n---\n\n`
            for (const ch of chapters) {
              const s = chapterSummaries.find(x => x.chapterId === ch.id)
              md += `## ${ch.title}\n\n`
              md += s ? `**内容总结**\n${s.plotSummary}\n\n` : '*未生成*\n\n'
              if (s?.additions) {
                for (const a of s.additions) { md += `- **${a.type}**: ${a.content}\n` }
                md += '\n'
              }
              md += '---\n\n'
            }
            const fn = `${currentProject?.name || 'novel'}_summary.md`
            await window.api.fs.saveFile(`${r.data.dirPath}/${fn}`, md)
            alert(`导出完成：${fn}`)
          }}
          className="w-full px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium">
          📄 导出 .md
        </button>
        <button
          onClick={handleStop}
          disabled={!running && !paused}
          className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 disabled:opacity-50 text-sm"
        >
          停止
        </button>
      </div>
    </div>
  )
}
