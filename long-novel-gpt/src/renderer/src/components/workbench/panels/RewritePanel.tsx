import { useCallback, useRef, useState, useEffect } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useBatchStore } from '../../../stores/useBatchStore'

export default function RewritePanel() {
  const { chapters, currentProject, updateChapterStatus, updateChapterRewrittenText, setCurrentChapterIndex } = useProjectStore()
  const { queue, isPaused, concurrency, setPaused, setConcurrency, clearQueue, enqueue, updateStatus } = useBatchStore()
  const processingRef = useRef(false)
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [selModelId, setSelModelId] = useState('');
  const selModelIdRef = useRef('')
  const [skills, setSkills] = useState<Array<{ id: string; name: string; type: string }>>([])
  const [projectSkills, setProjectSkills] = useState<Array<{ id: string; skill_id: string; enabled: number }>>([])
  const [skillsOpen, setSkillsOpen] = useState(false)

  useEffect(() => {
    window.api.db.query('models').then(r => {
      if (r.success && r.data) {
        const m = r.data as any[];
        setModels(m);
        setSelModelId(m[0].id); selModelIdRef.current = m[0].id
      }
    })
    window.api.db.query('skills').then(r => { if (r.success && r.data) setSkills(r.data as any[]) })
  }, [])

  useEffect(() => {
    if (!currentProject) return
    window.api.db.query('project_skills', 'project_id = ?', [currentProject.id])
      .then(r => { if (r.success && r.data) setProjectSkills(r.data as any[]) })
  }, [currentProject])

  const toggleSkill = async (skillId: string) => {
    const existing = projectSkills.find(ps => ps.skill_id === skillId)
    if (existing) {
      const newEnabled = existing.enabled ? 0 : 1
      await window.api.db.mutation('project_skills', 'update', { enabled: newEnabled }, 'id = ?', [existing.id])
      setProjectSkills(prev => prev.map(ps => ps.id === existing.id ? { ...ps, enabled: newEnabled } : ps))
    } else {
      const r = await window.api.db.mutation('project_skills', 'insert', {
        project_id: currentProject!.id, skill_id: skillId, enabled: 1, priority: 0,
      })
      if (r.success) {
        setProjectSkills(prev => [...prev, { id: (r.data as any).id, skill_id: skillId, enabled: 1 }])
      }
    }
  }

  const done = queue.filter(q => q.status === 'done').length
  const processing = queue.filter(q => q.status === 'processing').length
  const pending = queue.filter(q => q.status === 'pending').length
  const errors = queue.filter(q => q.status === 'error').length
  const total = queue.length || 1
  const progress = Math.round((done / total) * 100)

  const processChapter = useCallback(async (chapterId: string) => {
    const ch = chapters.find(c => c.id === chapterId)
    if (!ch) { updateStatus(chapterId, 'error'); return }
    try {
      updateChapterStatus(chapterId, 'processing')
      await new Promise(r => setTimeout(r, 2000))
      updateChapterRewrittenText(chapterId, `[改写后] ${ch.originalText.slice(0, 100)}...`)
      updateChapterStatus(chapterId, 'done')
      updateStatus(chapterId, 'done')
    } catch (e) {
      updateChapterStatus(chapterId, 'error', (e as Error).message)
      updateStatus(chapterId, 'error')
    }
  }, [chapters, updateChapterStatus, updateChapterRewrittenText, updateStatus])

  const processQueue = useCallback(async () => {
    if (processingRef.current) return
    processingRef.current = true
    try {
      const items = queue.filter(q => q.status === 'pending')
      if (items.length === 0) return
      const active = queue.filter(q => q.status === 'processing').length
      const slots = Math.max(1, concurrency - active)
      for (const item of items.slice(0, slots)) {
        updateStatus(item.chapterId, 'processing')
        processChapter(item.chapterId)
      }
    } finally { processingRef.current = false }
  }, [queue, concurrency, updateStatus, processChapter])

  useEffect(() => {
    if (!isPaused && queue.some(q => q.status === 'pending')) {
      const t = setTimeout(() => processQueue(), 100)
      return () => clearTimeout(t)
    }
  }, [queue, isPaused, processQueue])

  const handleStart = () => {
    if (queue.length === 0) {
      const ids = chapters.filter(c => c.status === 'pending' || c.status === 'error').map(c => c.id)
      if (ids.length === 0) return
      enqueue(ids)
    }
    setPaused(false)
  }

  const handleReset = async () => {
    clearQueue()
    setPaused(false)
    // Reset all chapters to pending status
    for (const ch of chapters) {
      if (ch.status !== 'pending' || ch.rewrittenText) {
        updateChapterStatus(ch.id, 'pending')
        updateChapterRewrittenText(ch.id, '')
        await window.api.db.mutation('chapters', 'update',
          { status: 'pending', rewritten_text: '' }, 'id = ?', [ch.id])
      }
    }
    setCurrentChapterIndex(0)
  }

  return (
    <div className="flex-1 flex flex-col p-4">
      <select value={selModelId} onChange={e => { setSelModelId(e.target.value); selModelIdRef.current = e.target.value }}
        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 mb-3 text-gray-600">
        {models.length === 0 ? <option value="">无可用模型</option> : models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>

      {/* Skills selection — only visible in rewrite step */}
      <div className="mb-3">
        <button onClick={() => setSkillsOpen(!skillsOpen)}
          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 text-gray-600 hover:bg-gray-50 text-left">
          写作技能 ({projectSkills.filter(s => s.enabled).length}/{skills.length})
        </button>
        {skillsOpen && (
          <div className="mt-1 border border-gray-200 rounded-lg max-h-48 overflow-auto">
            {skills.length === 0 ? (
              <div className="p-2 text-xs text-gray-400">暂无技能，请在首页导入</div>
            ) : skills.map(s => (
              <label key={s.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-xs">
                <input type="checkbox"
                  checked={projectSkills.some(ps => ps.skill_id === s.id && ps.enabled)}
                  onChange={() => toggleSkill(s.id)} className="rounded" />
                <span className="text-gray-700 truncate flex-1">{s.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <h2 className="font-semibold text-gray-700 mb-4 text-sm">改写统计</h2>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between"><span className="text-gray-500">已完成</span><span className="font-medium text-green-600">{done}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">进行中</span><span className="font-medium text-blue-600">{processing}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">未处理</span><span className="font-medium text-gray-400">{pending}</span></div>
        {errors > 0 && <div className="flex justify-between"><span className="text-gray-500">失败</span><span className="font-medium text-red-500">{errors}</span></div>}

        <div className="border-t border-gray-200 pt-3 mt-3">
          <div className="flex justify-between text-xs text-gray-500"><span>进度</span><span>{progress}%</span></div>
          <div className="w-full h-2 bg-gray-200 rounded mt-1 overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-2">
        <div className="text-xs text-gray-500">并发数</div>
        <input type="range" min="1" max="5" value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value))} className="w-full" />
        <div className="text-center text-sm text-gray-600">{concurrency}</div>
      </div>

      <div className="mt-auto space-y-2 pt-4 border-t border-gray-200">
        <button onClick={handleReset}
          className="w-full px-3 py-1.5 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded border border-gray-200">
          ⟳ 重新开始（重置所有改写状态）
        </button>
        <button onClick={handleStart} disabled={!isPaused && queue.length > 0 && pending === 0}
          className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium">
          全部开始
        </button>
        <button onClick={() => setPaused(true)} disabled={isPaused}
          className="w-full px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50 text-sm">
          {isPaused ? '已暂停' : '全部暂停'}
        </button>
        <button onClick={() => clearQueue()}
          className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm">
          全部停止
        </button>
      </div>
    </div>
  )
}
