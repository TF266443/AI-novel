import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { nanoid } from 'nanoid'

interface Skill {
  id: string; name: string; type: string; version: string
  description: string; skillJson: string
}

const typeLabels: Record<string, string> = {
  prompt_fragment: 'Prompt 片段',
  rewrite_rule: '改写规则',
  memory: '长篇记忆',
}

export default function SkillsPage() {
  const { setPage } = useAppStore()
  const [skills, setSkills] = useState<Skill[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)

  const load = async () => {
    const r = await window.api.db.query('skills')
    if (r.success && r.data) {
      setSkills((r.data as any[]).map((s: any) => ({
        id: s.id, name: s.name, type: s.type, version: s.version,
        description: s.description || '', skillJson: s.skill_json,
      })))
    }
  }

  useEffect(() => { load() }, [])

  const handleImport = async (file: File) => {
    try {
      setImportErr(null)
      const text = await file.text()
      const json = JSON.parse(text)
      if (!json.name || !json.type || !json.prompt) {
        setImportErr('Skill 格式无效：缺少 name、type 或 prompt')
        return
      }
      if (!['prompt_fragment', 'rewrite_rule', 'memory'].includes(json.type)) {
        setImportErr('type 必须是 prompt_fragment、rewrite_rule 或 memory')
        return
      }
      const r = await window.api.db.mutation('skills', 'insert', {
        name: json.name,
        type: json.type,
        version: json.version || '1.0',
        description: json.description || '',
        skill_json: JSON.stringify(json, null, 2),
      })
      if (!r.success) {
        setImportErr('保存失败：' + (r.error || '数据库错误'))
        return
      }
      setImportOpen(false)
      setImportErr(null)
      load()
    } catch {
      setImportErr('解析 JSON 失败，请检查文件格式')
    }
  }

  const handleBatchImport = async (files: FileList) => {
    setImportErr(null)
    let ok = 0; let fail = 0
    for (const file of Array.from(files)) {
      try {
        const text = await file.text()
        const json = JSON.parse(text)
        if (!json.name || !json.type || !json.prompt) { fail++; continue }
        if (!['prompt_fragment', 'rewrite_rule', 'memory'].includes(json.type)) { fail++; continue }
        const r = await window.api.db.mutation('skills', 'insert', {
          name: json.name, type: json.type,
          version: json.version || '1.0', description: json.description || '',
          skill_json: JSON.stringify(json, null, 2),
        })
        if (r.success) ok++; else fail++
      } catch { fail++ }
    }
    alert(`导入完成：成功 ${ok} 个，失败 ${fail} 个`)
    setImportOpen(false)
    load()
  }

  const handleExport = (skill: Skill) => {
    const blob = new Blob([skill.skillJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${skill.name}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const handleDelete = async (id: string) => {
    await window.api.db.mutation('skills', 'delete', {}, 'id = ?', [id])
    load()
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto">
        <button onClick={() => setPage('home')}
          className="mb-4 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg">
          &larr; 返回主页
        </button>
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-gray-900">写作技能</h1>
          <div className="flex gap-2">
            <button onClick={() => setImportOpen(true)}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium text-sm">
              导入 JSON
            </button>
            <label className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium text-sm cursor-pointer">
              批量导入
              <input type="file" accept=".json" multiple className="hidden"
                onChange={e => { const files = e.target.files; if (files?.length) handleBatchImport(files) }} />
            </label>
          </div>
        </div>

        <div className="grid gap-4">
          {skills.map(s => (
            <div key={s.id} className="bg-white rounded-lg shadow p-6">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-gray-900">{s.name}</h3>
                    <span className="px-2 py-0.5 rounded text-xs bg-indigo-100 text-indigo-700">
                      {typeLabels[s.type] || s.type}
                    </span>
                    <span className="text-sm text-gray-500">v{s.version}</span>
                  </div>
                  {s.description && (
                    <p className="text-sm text-gray-600 mt-2">{s.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => alert(JSON.stringify(JSON.parse(s.skillJson), null, 2))}
                    className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">预览</button>
                  <button onClick={() => handleExport(s)}
                    className="px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded">导出</button>
                  <button onClick={() => handleDelete(s.id)}
                    className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded">删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {skills.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">暂无写作技能</p>
            <p className="text-sm text-gray-400 mt-2">请导入 JSON 格式的写作技能，支持 Prompt 片段、改写规则、长篇记忆三种类型</p>
          </div>
        )}
      </div>

      {importOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-xl font-semibold mb-4">导入写作技能</h2>
            {importErr && (
              <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm">{importErr}</div>
            )}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
              <input type="file" accept=".json"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f) }}
                className="hidden" id="skill-upload" />
              <label htmlFor="skill-upload" className="cursor-pointer">
                <div className="text-gray-600 mb-2">点击选择 JSON 文件</div>
                <div className="text-sm text-gray-400">支持 .json 格式的写作技能</div>
              </label>
            </div>
            <div className="mt-4 text-sm text-gray-500">
              <p>Skill 应包含：</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li><code>name</code> — 技能名称</li>
                <li><code>type</code> — prompt_fragment / rewrite_rule / memory</li>
                <li><code>prompt</code> — 注入的 prompt 内容</li>
                <li><code>trigger.sceneCategories</code> —（可选）触发场景</li>
              </ul>
            </div>
            <div className="flex justify-end mt-6">
              <button onClick={() => { setImportOpen(false); setImportErr(null) }}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
