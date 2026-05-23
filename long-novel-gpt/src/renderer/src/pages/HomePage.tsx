import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { useProjectStore, Project } from '../stores/useProjectStore'
import { useContextStore } from '../stores/useContextStore'
import { nanoid } from 'nanoid'

/* ── types ── */
interface TmplRow { id: string; name: string; category_count: number }
interface ModelRow { id: string; name: string; tier: string }
interface ProjRow {
  id: string; name: string; file_path: string | null; save_path: string | null; template_id: string | null
  high_model_id: string | null; low_model_id: string | null; share_models: number
  created_at: string; updated_at: string; chapter_count: number
}

/* ── component ── */
export default function HomePage() {
  const { setPage } = useAppStore()
  const { setCurrentProject, setChapters, setScannedChapterIds } = useProjectStore()
  const { setHasSummaryIds } = useContextStore()

  const [templates, setTemplates] = useState<TmplRow[]>([])
  const [models, setModels] = useState<ModelRow[]>([])
  const [projects, setProjects] = useState<ProjRow[]>([])
  const [busy, setBusy] = useState(false)
  const loadedRef = useRef(false)

  // Wizard key forces fresh Modal on every open
  const [wizardKey, setWizardKey] = useState(0)
  const [wizardOpen, setWizardOpen] = useState(false)

  const loadAll = useCallback(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    window.api.db.query('templates').then(r => { if (r.success && r.data) setTemplates(r.data as TmplRow[]) })
    window.api.db.query('models').then(r => { if (r.success && r.data) setModels(r.data as ModelRow[]) })
    refreshProjects()
  }, [])

  const refreshProjects = async () => {
    const r = await window.api.db.query('projects')
    if (!r.success || !r.data) { setProjects([]); return }
    const list = await Promise.all(
      (r.data as any[]).map(async (p: any) => {
        const ch = await window.api.db.query('chapters', 'project_id = ?', [p.id], 'id')
        return { ...p, chapter_count: (ch.success && ch.data) ? (ch.data as any[]).length : 0 }
      })
    )
    setProjects(list)
  }

  useEffect(() => { loadAll() }, [loadAll])

  /* ── actions ── */
  const openWizard = () => {
    setWizardKey(prev => prev + 1)
    setWizardOpen(true)
  }

  const handleOpen = async (proj: ProjRow) => {
    setBusy(true)
    try {
      // Load chapters metadata only (no heavy columns) to avoid OOM
      const r = await window.api.db.query(
        'chapters',
        'project_id = ? ORDER BY chapter_index ASC',
        [proj.id],
        'id,chapter_index,title,status,error_message'
      )
      if (!r.success) { alert('加载章节失败'); return }
      const chapters = (r.data as any[]).map((ch: any) => ({
        id: ch.id, chapterIndex: ch.chapter_index, title: ch.title || '',
        originalText: '', rewrittenText: null,
        status: (ch.status || 'pending') as any,
        errorMessage: ch.error_message || null,
        sceneTags: [],
        expandedSceneTags: null,
        scanMetrics: undefined,
      }))
      const project: Project = {
        id: proj.id, name: proj.name, filePath: proj.file_path,
        savePath: proj.save_path,
        templateId: proj.template_id, highModelId: proj.high_model_id,
        lowModelId: proj.low_model_id, shareModels: proj.share_models === 1,
        createdAt: proj.created_at, updatedAt: proj.updated_at,
      }
      setCurrentProject(project)
      setChapters(chapters)

      // Lightweight: which chapters already scanned?
      const scanR = await window.api.db.query(
        'chapters',
        "project_id = ? AND scene_tags IS NOT NULL AND scene_tags != '' AND scene_tags != '[]'",
        [proj.id],
        'id'
      )
      if (scanR.success && scanR.data) setScannedChapterIds((scanR.data as any[]).map((r: any) => r.id))

      // Lightweight: which chapters have summaries?
      const sumR = await window.api.db.query('chapter_summaries', 'project_id = ?', [proj.id], 'chapter_id')
      if (sumR.success && sumR.data) setHasSummaryIds((sumR.data as any[]).map((r: any) => r.chapter_id))

      setPage('workbench')
    } catch (err) {
      alert('打开项目失败：' + ((err as Error).message || '未知错误'))
    } finally { setBusy(false) }
  }

  const handleDelete = async (e: React.MouseEvent, pid: string) => {
    e.stopPropagation()
    if (!confirm('确定要删除这个项目及其所有章节吗？')) return
    setBusy(true)
    try {
      await window.api.db.mutation('chapters', 'delete', {}, 'project_id = ?', [pid])
      await window.api.db.mutation('projects', 'delete', {}, 'id = ?', [pid])
      refreshProjects()
    } catch (err) {
      alert('删除失败：' + ((err as Error).message || '未知错误'))
    } finally { setBusy(false) }
  }

  // ... rest of the JSX stays the same
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Long Novel GPT</h1>
          <div className="flex gap-3">
            <button onClick={() => setPage('models')} className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50">模型管理</button>
            <button onClick={() => setPage('templates')} className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50">模板管理</button>
            <button onClick={() => setPage('skills')} className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50">技能管理</button>
            <button onClick={() => setPage('settings')} className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50">设置</button>
          </div>
        </div>

        <div className="mb-8">
          <button onClick={openWizard} className="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">
            + 新建项目
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p className="text-lg mb-2">还没有项目</p>
            <p className="text-sm">点击"新建项目"开始</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => (
              <div
                key={p.id}
                onClick={() => handleOpen(p)}
                className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 cursor-pointer hover:shadow-md hover:border-indigo-300 transition"
              >
                <div className="flex items-start justify-between mb-3">
                  <h3 className="font-semibold text-gray-900">{p.name}</h3>
                  <button
                    onClick={(e) => handleDelete(e, p.id)}
                    className="text-gray-400 hover:text-red-500 text-sm"
                    title="删除项目"
                  >
                    ✕
                  </button>
                </div>
                <div className="text-sm text-gray-500 space-y-1">
                  <p>{p.chapter_count} 章</p>
                  {p.file_path && <p className="truncate">源文件: {p.file_path}</p>}
                  <p className="text-xs text-gray-400">更新于 {new Date(p.updated_at).toLocaleDateString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {busy && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-8 flex flex-col items-center">
            <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-gray-700 font-medium">加载中...</p>
          </div>
        </div>
      )}

      {wizardOpen && <NewProjectWizard key={wizardKey} onClose={() => setWizardOpen(false)} onCreated={() => { setWizardOpen(false); refreshProjects() }} />}
    </div>
  )
}

/* ── New Project Wizard (inline for simplicity) ── */
function NewProjectWizard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [filePath, setFilePath] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [templates, setTemplates] = useState<any[]>([])
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    window.api.db.query('templates').then(r => {
      if (r.success && r.data) setTemplates(r.data as any[])
    })
  }, [])

  const handleSelectFile = async () => {
    const r = await window.api.fs.selectFile({
      title: '选择 TXT 文件',
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    })
    if (r.success && r.data) setFilePath(r.data as string)
  }

  const handleCreate = async () => {
    if (!name.trim()) { setError('请输入项目名称'); return }
    if (!filePath) { setError('请选择 TXT 文件'); return }
    if (!templateId) { setError('请选择模板'); return }

    setImporting(true)
    setError('')

    try {
      const projectId = nanoid()
      const now = new Date().toISOString()

      await window.api.db.mutation('projects', 'insert', {
        id: projectId, name: name.trim(), file_path: filePath,
        template_id: templateId, created_at: now, updated_at: now
      })

      // Read and split the file
      const content = await window.api.fs.readFile(filePath)
      if (!content.success || !content.data) {
        setError('读取文件失败')
        setImporting(false)
        return
      }

      const chapters = await window.api.fs.splitTextIntoChapters(content.data as string)
      if (!chapters.success || !chapters.data) {
        setError('分章失败')
        setImporting(false)
        return
      }

      const chapterList = chapters.data as Array<{ title: string; content: string }>
      for (let i = 0; i < chapterList.length; i++) {
        await window.api.db.mutation('chapters', 'insert', {
          id: nanoid(),
          project_id: projectId,
          chapter_index: i,
          title: chapterList[i].title,
          original_text: chapterList[i].content,
          status: 'pending',
          created_at: now,
          updated_at: now,
        })
      }

      onCreated()
    } catch (err) {
      setError('创建项目失败：' + ((err as Error).message || '未知错误'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-8 max-w-lg w-full mx-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-bold text-gray-900 mb-6">新建项目</h2>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}

        {/* Step 1: Name & File */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">项目名称</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="输入项目名称"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">TXT 源文件</label>
              <button onClick={handleSelectFile} className="w-full px-4 py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-indigo-400 hover:text-indigo-600 transition">
                {filePath ? filePath.split(/[\\/]/).pop() : '点击选择文件...'}
              </button>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">模板</label>
              <select
                value={templateId}
                onChange={e => setTemplateId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">选择模板...</option>
                {templates.map((t: any) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-3 pt-4">
              <button onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">取消</button>
              <button onClick={handleCreate} disabled={importing} className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                {importing ? '创建中...' : '创建项目'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
