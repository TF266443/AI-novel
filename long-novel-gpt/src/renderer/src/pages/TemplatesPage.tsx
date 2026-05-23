import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { nanoid } from 'nanoid'
import { hashText, packVector } from '../lib/embedding'

interface Template {
  id: string
  name: string
  version: string
  description: string
  templateJson: string
  categoryCount: number
  isDefault: boolean
}

export default function TemplatesPage() {
  const { setPage } = useAppStore()
  const [templates, setTemplates] = useState<Template[]>([])
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const loadTemplates = async () => {
    const result = await window.api.db.query('templates')
    if (result.success && result.data) {
      setTemplates(result.data.map((t: Record<string, unknown>) => ({
        id: t.id as string,
        name: t.name as string,
        version: t.version as string,
        description: t.description as string || '',
        templateJson: t.template_json as string,
        categoryCount: t.category_count as number,
        isDefault: t.is_default === 1
      })))
    }
  }

  useEffect(() => {
    loadTemplates()
  }, [])

  const handleImport = async (file: File) => {
    try {
      setImportError(null)
      const text = await file.text()
      const json = JSON.parse(text)

      if (!json.name || !json.breakthroughTemplate) {
        setImportError('模板格式无效：缺少 name 或 breakthroughTemplate')
        return
      }

      // Parse nested string fields if needed (templates may store these as JSON strings)
      let rewriteTemplate = typeof json.rewriteTemplate === 'string' ? JSON.parse(json.rewriteTemplate) : json.rewriteTemplate
      let identifyTemplate = typeof json.identifyTemplate === 'string' ? JSON.parse(json.identifyTemplate) : json.identifyTemplate

      if (!identifyTemplate?.categories || identifyTemplate.categories.length === 0) {
        setImportError('模板格式无效：缺少场景分类')
        return
      }

      if (!rewriteTemplate?.commonPrompt) {
        setImportError('模板格式无效：缺少通用改写规则')
        return
      }

      // Normalize: store parsed objects in the saved JSON
      const normalized = {
        name: json.name,
        version: json.version || '1.0',
        description: json.description || '',
        breakthroughTemplate: json.breakthroughTemplate,
        rewriteTemplate,
        identifyTemplate,
      }

      const template = {
        id: nanoid(),
        name: json.name,
        version: json.version || '1.0',
        description: json.description || '',
        templateJson: JSON.stringify(normalized, null, 2),
        categoryCount: identifyTemplate.categories.length,
        isDefault: 0
      }

      await window.api.db.mutation('templates', 'insert', {
        name: template.name,
        version: template.version,
        description: template.description,
        template_json: template.templateJson,
        category_count: template.categoryCount,
        is_default: template.isDefault
      })

      // ── 方案5: Template Semantic Bootstrapping ──
      // For each category, use LLM to analyze its categoryPrompts and generate
      // recognition semantics: entry_conditions, confirm_signals, exclude_patterns.
      const categoryPrompts = rewriteTemplate?.categoryPrompts as Record<string, string> | undefined
      if (categoryPrompts) {
        const categories = identifyTemplate.categories as Array<{
          id: string; name: string; conditions: string; synonyms?: string[]
        }>
        const bootstrapped: Record<string, { entry_conditions: string; confirm_signals: string[]; exclude_patterns: string[]; expansion_brief: string }> = {}

        // Get first available non-embedding model for bootstrapping
        const modelsResult = await window.api.db.query('models')
        const model = modelsResult.success && modelsResult.data
          ? (modelsResult.data as any[]).find((m: any) => !/embed|nomic/i.test(m.model_id || '') && !/embed|nomic/i.test(m.name || ''))
          : null

        if (model) {
          for (const cat of categories) {
            const prompt = categoryPrompts[cat.id]
            if (!prompt) continue
            try {
              const r = await window.api.ai.classify({
                baseUrl: model.base_url,
                modelId: model.model_id,
                apiKey: model.api_key_encrypted,
                messages: [
                  { role: 'system', content: `你是场景识别规则分析助手。根据给定的场景规则文本，提取识别语义：
1. entry_conditions: 哪些原文描写可作为扩写入口（宽泛，≤40字，逗号分隔）
2. confirm_signals: 出现哪些词应提高置信度（3-8个精确词）
3. exclude_patterns: 哪些模式应排除（如"仅限主角"→排除非主角）
4. expansion_brief: 一句话说明扩写方向（≤30字）

输出严格 JSON：{"entry_conditions":"...","confirm_signals":["..."],"exclude_patterns":["..."],"expansion_brief":"..."}` },
                  { role: 'user', content: `场景名称：${cat.name}\n完整规则：\n${prompt.slice(0, 1200)}` },
                ],
                jsonSchema: {
                  type: 'object',
                  properties: {
                    entry_conditions: { type: 'string' },
                    confirm_signals: { type: 'array', items: { type: 'string' } },
                    exclude_patterns: { type: 'array', items: { type: 'string' } },
                    expansion_brief: { type: 'string' },
                  },
                  required: ['entry_conditions', 'confirm_signals', 'expansion_brief'],
                },
                schemaName: 'scene_bootstrap',
                maxTokens: 300,
              })
              if (r.success && r.data) {
                const d = r.data as any
                bootstrapped[cat.id] = {
                  entry_conditions: d.entry_conditions || '',
                  confirm_signals: (Array.isArray(d.confirm_signals) ? d.confirm_signals : []).filter((s: string) => s.length >= 2 && s.length <= 16).slice(0, 8),
                  exclude_patterns: (Array.isArray(d.exclude_patterns) ? d.exclude_patterns : []).filter((s: string) => s.length >= 2).slice(0, 4),
                  expansion_brief: d.expansion_brief || '',
                }
              }
            } catch { /* bootstrap failure for this category, skip */ }
          }

          // If any categories were bootstrapped, update the template
          if (Object.keys(bootstrapped).length > 0) {
            for (const cat of categories) {
              if (bootstrapped[cat.id]) {
                (cat as any).bootstrap = bootstrapped[cat.id]
              }
            }
            // Re-save with bootstrap data
            const updatedNormalized = {
              name: json.name,
              version: json.version || '1.0',
              description: json.description || '',
              breakthroughTemplate: json.breakthroughTemplate,
              rewriteTemplate,
              identifyTemplate,
            }
            await window.api.db.mutation('templates', 'update', {
              template_json: JSON.stringify(updatedNormalized, null, 2),
              category_count: identifyTemplate.categories.length,
            }, 'id = ?', [template.id])
          }
        }
      }

      // Pre-compute category embeddings if an embedding model is configured
      try {
        const modelsResult = await window.api.db.query('models')
        if (modelsResult.success && modelsResult.data) {
          const embedModel = (modelsResult.data as any[]).find(
            (m: any) => m.tier === 'embed' || m.model_id?.toLowerCase().includes('embed')
          )
          if (embedModel && embedModel.base_url && embedModel.model_id) {
            const categories = identifyTemplate.categories as Array<{
              id: string; name: string; conditions: string; synonyms?: string[]
            }>
            for (const cat of categories) {
              const textToEmbed = [
                cat.name,
                cat.conditions,
                ...(cat.synonyms || []).slice(0, 10)
              ].join('\n')
              const embedResult = await window.api.ai.embed({
                baseUrl: embedModel.base_url,
                model: embedModel.model_id,
                prompt: textToEmbed,
                apiKey: embedModel.api_key,
              })
              if (embedResult.success && embedResult.data) {
                await window.api.db.mutation('embeddings', 'insert', {
                  id: `category:${cat.id}`,
                  type: 'category',
                  ref_id: cat.id,
                  project_id: '', // template-level, no project yet
                  model_id: embedModel.model_id,
                  vector: packVector(embedResult.data),
                  text_hash: hashText(textToEmbed),
                })
              }
            }
          }
        }
      } catch (err) {
        console.warn('Failed to pre-compute category embeddings:', err)
        // Non-fatal — embeddings can be computed later during scan
      }

      setIsImportModalOpen(false)
      loadTemplates()
    } catch {
      setImportError('解析 JSON 文件失败，请检查文件格式')
    }
  }

  const handleExport = (template: Template) => {
    const blob = new Blob([template.templateJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${template.name}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDelete = async (id: string) => {
    await window.api.db.mutation('templates', 'delete', {}, 'id = ?', [id])
    loadTemplates()
  }

  const handlePreview = (template: Template) => {
    const json = JSON.parse(template.templateJson)
    alert(JSON.stringify(json, null, 2))
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto">
        <button
          onClick={() => setPage('home')}
          className="mb-4 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg"
        >
          &larr; 返回主页
        </button>
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-gray-900">提示词模板</h1>
          <button
            onClick={() => setIsImportModalOpen(true)}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium"
          >
            导入 JSON
          </button>
        </div>

        <div className="grid gap-4">
          {templates.map((template) => (
            <div key={template.id} className="bg-white rounded-lg shadow p-6">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-gray-900">{template.name}</h3>
                    <span className="text-sm text-gray-500">v{template.version}</span>
                    {template.isDefault && (
                      <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">默认</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    {template.categoryCount} 个场景分类
                  </p>
                  {template.description && (
                    <p className="text-sm text-gray-600 mt-2">{template.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handlePreview(template)}
                    className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
                  >
                    预览
                  </button>
                  <button
                    onClick={() => handleExport(template)}
                    className="px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded"
                  >
                    导出
                  </button>
                  <button
                    onClick={() => handleDelete(template.id)}
                    className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {templates.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">暂无模板</p>
            <p className="text-sm text-gray-400 mt-2">请导入 JSON 格式的提示词模板</p>
          </div>
        )}
      </div>

      {isImportModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h2 className="text-xl font-semibold mb-4">导入模板</h2>

            {importError && (
              <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg">
                {importError}
              </div>
            )}

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
              <input
                type="file"
                accept=".json"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImport(file)
                }}
                className="hidden"
                id="template-upload"
              />
              <label htmlFor="template-upload" className="cursor-pointer">
                <div className="text-gray-600 mb-2">点击选择 JSON 文件</div>
                <div className="text-sm text-gray-400">支持 .json 格式的提示词模板</div>
              </label>
            </div>

            <div className="mt-4 text-sm text-gray-500">
              <p>模板应包含以下结构：</p>
              <ul className="list-disc list-inside mt-2">
                <li>breakthroughTemplate - 破甲词</li>
                <li>identifyTemplate.categories - 识别分类</li>
                <li>rewriteTemplate - 改写规则</li>
              </ul>
            </div>

            <div className="flex justify-end mt-6">
              <button
                onClick={() => {
                  setIsImportModalOpen(false)
                  setImportError(null)
                }}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}