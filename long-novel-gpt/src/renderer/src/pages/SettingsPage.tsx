import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { useProjectStore } from '../stores/useProjectStore'
import { exportPromptKB, importPromptKB, exportExpansionKB, importExpansionKB } from '../lib/knowledgeBase'

export default function SettingsPage() {
  const { setPage } = useAppStore()
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [autoSave, setAutoSave] = useState(true)
  const [autoSaveInterval, setAutoSaveInterval] = useState(30)
  const [dbPath, setDbPath] = useState('')
  const [promptKbPath, setPromptKbPath] = useState('')
  const [expansionKbPath, setExpansionKbPath] = useState('')
  const [kbExporting, setKbExporting] = useState('')
  const [kbImporting, setKbImporting] = useState('')
  const [cacheSize, setCacheSize] = useState<number | null>(null)
  const currentProjectId = useProjectStore(s => s.currentProject?.id || '')
  const bumpTemplateVersion = useProjectStore(s => s.bumpTemplateVersion)

  // Resolve project ID: use current project, or auto-find first available
  const getProjectId = async (): Promise<string | null> => {
    if (currentProjectId) return currentProjectId
    const r = await window.api.db.query('projects', '1=1')
    if (r.success && r.data && (r.data as any[]).length > 0) {
      return (r.data as any[])[0].id
    }
    return null
  }

  useEffect(() => {
    const loadSettings = async () => {
      const themeVal = await window.api.settings.get('theme')
      if (themeVal.success && themeVal.data) setTheme(themeVal.data as 'light' | 'dark')

      const autoSaveVal = await window.api.settings.get('autoSave')
      if (autoSaveVal.success && autoSaveVal.data !== undefined) setAutoSave(autoSaveVal.data as boolean)

      const intervalVal = await window.api.settings.get('autoSaveInterval')
      if (intervalVal.success && intervalVal.data) setAutoSaveInterval(intervalVal.data as number)

      const dbPathResult = await window.api.settings.getDbPath()
      if (dbPathResult.success && dbPathResult.data) setDbPath(dbPathResult.data as string)

      const kbPaths = await window.api.settings.getKbPaths().catch(() => ({} as Record<string, string>))
      if (kbPaths.prompt_kb_path) setPromptKbPath(kbPaths.prompt_kb_path)
      if (kbPaths.expansion_kb_path) setExpansionKbPath(kbPaths.expansion_kb_path)

      const size = await window.api.settings.getCacheSize().catch(() => 0)
      setCacheSize(size)
    }
    loadSettings()
  }, [])

  const handleThemeChange = async (newTheme: 'light' | 'dark') => {
    setTheme(newTheme)
    await window.api.settings.set('theme', newTheme)
  }

  const handleAutoSaveChange = async (value: boolean) => {
    setAutoSave(value)
    await window.api.settings.set('autoSave', value)
  }

  const handleIntervalChange = async (value: number) => {
    setAutoSaveInterval(value)
    await window.api.settings.set('autoSaveInterval', value)
  }

  // ── Prompt KB: select path + auto-export to create file ──
  const handleSelectPromptPath = async () => {
    const r = await window.api.fs.selectSaveFile({
      defaultPath: 'prompt_knowledge_base.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.success && r.data?.filePath) {
      const filePath = r.data.filePath
      setPromptKbPath(filePath)
      await window.api.settings.setKbPath('prompt_kb_path', filePath)
      // Create file immediately with minimal valid JSON
      const initData = JSON.stringify({ version: 1, exported_at: new Date().toISOString(), gold_labels: [], embeddings: [], categories: [] }, null, 2)
      const wr = await window.api.fs.saveFile(filePath, initData)
      if (!wr.success) { alert('创建提示词知识库文件失败：' + (wr.error || '未知错误')); return }
      // Then populate with actual data
      try { await exportPromptKB(filePath) } catch { /* actual data export can fail, file already created */ }
      alert('提示词知识库已创建：' + filePath)
    }
  }

  // ── Expansion KB: select path + auto-export to create file ──
  const handleSelectExpansionPath = async () => {
    const r = await window.api.fs.selectSaveFile({
      defaultPath: 'expansion_knowledge_base.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.success && r.data?.filePath) {
      const filePath = r.data.filePath
      setExpansionKbPath(filePath)
      await window.api.settings.setKbPath('expansion_kb_path', filePath)
      // Create file immediately with minimal valid JSON
      const initData = JSON.stringify({ version: 1, exported_at: new Date().toISOString(), rewrite_feedback: [], rewrite_template: {}, skills: [] }, null, 2)
      const wr = await window.api.fs.saveFile(filePath, initData)
      if (!wr.success) { alert('创建小说扩写知识库文件失败：' + (wr.error || '未知错误')); return }
      // Then populate with actual data
      try { await exportExpansionKB(filePath, currentProjectId) } catch { /* actual data export can fail, file already created */ }
      alert('小说扩写知识库已创建：' + filePath)
    }
  }

  // ── Prompt KB Export ──
  const handleExportPrompt = async () => {
    if (!promptKbPath) return
    setKbExporting('prompt')
    try {
      await exportPromptKB(promptKbPath)
      alert('提示词知识库已导出到：' + promptKbPath)
    } catch (e: unknown) {
      alert('导出失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setKbExporting('')
    }
  }

  // ── Prompt KB Import ──
  const handleImportPrompt = async () => {
    const r = await window.api.fs.selectFile({
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (!r.success || !r.data?.filePath) return
    const pid = await getProjectId()
    if (!pid) {
      alert('请先打开或创建一个项目')
      return
    }
    setKbImporting('prompt')
    try {
      await importPromptKB(r.data.filePath, pid)
      bumpTemplateVersion()
      alert('提示词知识库导入完成')
    } catch (e: unknown) {
      alert('导入失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setKbImporting('')
    }
  }

  // ── Expansion KB Export ──
  const handleExportExpansion = async () => {
    if (!expansionKbPath) return
    setKbExporting('expansion')
    try {
      await exportExpansionKB(expansionKbPath, currentProjectId)
      alert('小说扩写知识库已导出到：' + expansionKbPath)
    } catch (e: unknown) {
      alert('导出失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setKbExporting('')
    }
  }

  // ── Expansion KB Import ──
  const handleImportExpansion = async () => {
    const r = await window.api.fs.selectFile({
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (!r.success || !r.data?.filePath) return
    const pid = await getProjectId()
    if (!pid) {
      alert('请先打开或创建一个项目')
      return
    }
    setKbImporting('expansion')
    try {
      await importExpansionKB(r.data.filePath, pid)
      bumpTemplateVersion()
      alert('小说扩写知识库导入完成')
    } catch (e: unknown) {
      alert('导入失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setKbImporting('')
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => setPage('home')}
          className="mb-4 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg"
        >
          &larr; 返回主页
        </button>
        <h1 className="text-2xl font-bold text-gray-900 mb-8">设置</h1>

        <div className="bg-white rounded-lg shadow divide-y divide-gray-200">
          <div className="p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">外观</h2>
            <div className="flex gap-4">
              <button
                onClick={() => handleThemeChange('light')}
                className={`flex-1 p-4 rounded-lg border-2 ${
                  theme === 'light' ? 'border-indigo-600 bg-indigo-50' : 'border-gray-200'
                }`}
              >
                <div className="text-center">
                  <div className="text-3xl mb-2">☀️</div>
                  <div className="text-sm font-medium">浅色</div>
                </div>
              </button>
              <button
                onClick={() => handleThemeChange('dark')}
                className={`flex-1 p-4 rounded-lg border-2 ${
                  theme === 'dark' ? 'border-indigo-600 bg-indigo-50' : 'border-gray-200'
                }`}
              >
                <div className="text-center">
                  <div className="text-3xl mb-2">🌙</div>
                  <div className="text-sm font-medium">深色</div>
                </div>
              </button>
            </div>
          </div>

          <div className="p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">自动保存</h2>
            <div className="space-y-4">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={autoSave}
                  onChange={(e) => handleAutoSaveChange(e.target.checked)}
                  className="w-5 h-5 text-indigo-600 rounded focus:ring-indigo-500"
                />
                <span className="text-gray-700">启用自动保存</span>
              </label>

              {autoSave && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    保存间隔（秒）
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="300"
                    value={autoSaveInterval}
                    onChange={(e) => handleIntervalChange(parseInt(e.target.value))}
                    className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              )}
            </div>
          </div>

          {/* ── Database Path ── */}
          <div className="p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">数据库</h2>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500 bg-gray-100 px-3 py-1.5 rounded font-mono text-xs break-all">
                {dbPath || '加载中...'}
              </span>
            </div>
          </div>

          {/* ── Prompt Knowledge Base Section ── */}
          <div className="p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-2">提示词知识库</h2>
            <p className="text-sm text-gray-500 mb-1">
              存储场景识别的标注数据、关键词库、置信度阈值等。
            </p>
            <p className="text-sm text-gray-500 mb-4">
              供AI识别场景时使用。
            </p>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-gray-700 whitespace-nowrap">存储位置：</span>
                <span className="text-sm text-gray-500 bg-gray-100 px-3 py-1.5 rounded font-mono text-xs truncate max-w-md">
                  {promptKbPath || '未设置'}
                </span>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleSelectPromptPath}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 text-sm font-medium"
                >
                  选择路径
                </button>
                <button
                  onClick={handleExportPrompt}
                  disabled={!promptKbPath || kbExporting !== ''}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {kbExporting === 'prompt' ? '导出中...' : '导出'}
                </button>
                <button
                  onClick={handleImportPrompt}
                  disabled={kbImporting !== ''}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {kbImporting === 'prompt' ? '导入中...' : '导入'}
                </button>
              </div>
            </div>
          </div>

          {/* ── Expansion Knowledge Base Section ── */}
          <div className="p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-2">小说扩写知识库</h2>
            <p className="text-sm text-gray-500 mb-1">
              存储扩写反馈、风格偏好、改写规则等。
            </p>
            <p className="text-sm text-gray-500 mb-4">
              供AI扩写小说时使用。
            </p>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-gray-700 whitespace-nowrap">存储位置：</span>
                <span className="text-sm text-gray-500 bg-gray-100 px-3 py-1.5 rounded font-mono text-xs truncate max-w-md">
                  {expansionKbPath || '未设置'}
                </span>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleSelectExpansionPath}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 text-sm font-medium"
                >
                  选择路径
                </button>
                <button
                  onClick={handleExportExpansion}
                  disabled={!expansionKbPath || kbExporting !== ''}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {kbExporting === 'expansion' ? '导出中...' : '导出'}
                </button>
                <button
                  onClick={handleImportExpansion}
                  disabled={kbImporting !== ''}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {kbImporting === 'expansion' ? '导入中...' : '导入'}
                </button>
              </div>
            </div>
          </div>

          <div className="p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">清理缓存</h2>
            <p className="text-sm text-gray-500 mb-3">清理应用缓存（Cache、GPU Cache 等），释放磁盘空间。不会影响项目数据。</p>
            <div className="flex items-center gap-4">
              {cacheSize !== null && (
                <span className="text-sm text-gray-600">
                  当前缓存：<span className="font-medium">{(cacheSize / 1024 / 1024).toFixed(1)} MB</span>
                </span>
              )}
              <button
                onClick={async () => {
                  const r = await window.api.settings.clearCache()
                  if (r.success) {
                    alert((r.data as any).message || `已清理 ${(r.data as any).removed} 个缓存`)
                    // Refresh cache size
                    window.api.settings.getCacheSize().then(size => setCacheSize(size)).catch(() => {})
                  } else {
                    alert('清理失败：' + r.error)
                  }
                }}
                className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm font-medium"
              >
                清理缓存
              </button>
            </div>
          </div>

          <div className="p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">关于</h2>
            <div className="space-y-2 text-sm text-gray-600">
              <p>Novel Mate v1.0.0</p>
              <p>AI 小说改写工具</p>
              <p className="text-gray-400">基于 Electron + React + TypeScript 构建</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
