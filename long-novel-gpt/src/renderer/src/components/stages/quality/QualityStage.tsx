import { useState, useEffect, useRef } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'

const rules = [
  { key: 'D', name: '世界自主生命', level: 'rollback' },
  { key: 'K', name: '段落多样性', level: 'rollback' },
  { key: 'M', name: '爽点链过饱和', level: 'rollback' },
  { key: 'N', name: '质量曲线', level: 'rollback' },
  { key: 'O', name: '灵魂缺失', level: 'rollback' },
  { key: 'P', name: '算法化情节', level: 'rollback' },
  { key: 'Q', name: '过渡粘性', level: 'rollback' },
  { key: 'R', name: '说明书句法', level: 'rollback' },
  { key: 'C', name: '单句瀑布', level: 'FAIL' },
  { key: 'E', name: '情绪标签', level: 'FAIL' },
  { key: 'B', name: '句式重复', level: 'FAIL' },
  { key: 'A', name: '节拍器', level: 'WARN' },
  { key: 'G', name: '设定讲解', level: 'WARN' },
  { key: 'I', name: '对话超载', level: 'WARN' },
  { key: 'J', name: '套路密度', level: 'WARN' },
]

export default function QualityStage() {
  const { chapters, currentChapterIndex, currentProject } = useProjectStore()
  const currentChapter = chapters[currentChapterIndex]
  const [checking, setChecking] = useState(false)
  const [results, setResults] = useState<Record<string, string> | null>(null)
  const [passed, setPassed] = useState(false)
  const [models, setModels] = useState<Array<{ id: string; name: string; model_id: string; base_url: string; api_key_encrypted: string }>>([])
  const [selModelId, setSelModelId] = useState('');
  const selModelIdRef = useRef('')

  useEffect(() => {
    window.api.db.query('models').then(r => { if (r.success && r.data) { const m = r.data as any[]; setModels(m); setSelModelId(m[0].id); selModelIdRef.current = m[0].id } })
  }, [])

  const handleCheck = async () => {
    if (!currentChapter || !currentProject) return
    setChecking(true)

    try {
      const mr = await window.api.db.query('models', 'id = ?', [selModelIdRef.current || selModelId])
      if (!mr.success || !mr.data?.length) { alert('请在右侧面板选择模型'); setChecking(false); return }
      const model = mr.data[0] as any

      const rulesText = rules.map(r => `${r.key}-${r.name}[${r.level}]`).join('\n')
      const prompt = `检查以下章节是否符合反AI检测规则。逐条判断PASS或FAIL，FAIL的需简要说明原因。\n\n规则：\n${rulesText}\n\n章节：\n${currentChapter.rewrittenText || currentChapter.originalText}\n\nJSON: {"rule_D":"PASS","rule_K":"FAIL(reason)","rule_C":"PASS",...}`

      let resp = ''
      const sid = Date.now().toString()
      await new Promise<void>((resolve, reject) => {
        const u1 = window.api.ai.onToken(({ id, token }) => { if (id === sid) resp += token })
        const u2 = window.api.ai.onDone(({ id }) => { if (id === sid) { u1(); u2(); u3(); resolve() } })
        const u3 = window.api.ai.onError(({ id }) => { if (id === sid) { u1(); u2(); u3(); reject() } })
        window.api.ai.stream({ id: sid, modelId: model.model_id, baseUrl: model.base_url, apiKey: model.api_key_encrypted, messages: [{ role: 'user', content: prompt }], temperature: 0.1, maxTokens: 500 })
      })

      const parsed = await window.api.ai.safeParseJson(resp)
      const checkResults: Record<string, string> = {}
      if (parsed.data) {
        for (const r of rules) {
          checkResults[r.key] = (parsed.data as any)[`rule_${r.key}`] || 'UNKNOWN'
        }
      }
      setResults(checkResults)

      const failCount = Object.values(checkResults).filter(v => v.startsWith('FAIL')).length
      setPassed(failCount === 0)

      // Save to DB
      await window.api.db.mutation('quality_checks', 'insert', {
        project_id: currentProject.id, chapter_id: currentChapter.id,
        results: JSON.stringify(checkResults), passed: failCount === 0 ? 1 : 0,
      })
    } catch { alert('检查失败') }
    setChecking(false)
  }

  const levelColor = (l: string) => l === 'rollback' ? 'text-red-600' : l === 'FAIL' ? 'text-orange-600' : 'text-yellow-600'
  const resultColor = (v: string) => v.startsWith('FAIL') ? 'text-red-600 bg-red-50' : v === 'PASS' ? 'text-green-600 bg-green-50' : 'text-gray-500 bg-gray-50'

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">质量检查</h2>
          <p className="text-xs text-gray-400 mt-1">
            {currentChapter?.title} · {results ? (passed ? '✅ 全部通过' : '❌ 有问题') : '未检查'}
          </p>
        </div>
        <select value={selModelId} onChange={e => { setSelModelId(e.target.value); selModelIdRef.current = e.target.value }}
          className="text-xs border border-gray-300 rounded px-2 py-1.5 text-gray-600 min-w-[140px]">
          {models.length === 0 ? <option value="">无模型</option> : models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button onClick={handleCheck} disabled={checking || !(selModelIdRef.current || selModelId)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm">
          {checking ? '检查中...' : '开始自检'}
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="grid gap-2">
          {rules.map(r => (
            <div key={r.key} className={`flex items-center gap-3 px-3 py-2 rounded text-sm ${results ? resultColor(results[r.key]) : 'bg-gray-50'}`}>
              <span className={`font-mono font-bold w-6 ${levelColor(r.level)}`}>{r.key}</span>
              <span className="flex-1">{r.name}</span>
              <span className="text-xs opacity-60">{r.level}</span>
              {results && (
                <span className="text-xs font-mono">{results[r.key]}</span>
              )}
            </div>
          ))}
        </div>
        {!results && !checking && (
          <p className="text-gray-400 text-sm mt-4 text-center">点击"开始自检"使用本地模型快速检查反AI检测规则</p>
        )}
      </div>
    </div>
  )
}
