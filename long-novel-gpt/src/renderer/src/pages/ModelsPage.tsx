import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { nanoid } from 'nanoid'

interface Model {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  modelId: string
  temperature: number
  maxTokens: number
  timeoutSec: number
  tier: 'high' | 'low'
  isDefault: boolean
}

export default function ModelsPage() {
  const { setPage } = useAppStore()
  const [models, setModels] = useState<Model[]>([])
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean, message: string } | null>(null)

  const loadModels = async () => {
    const result = await window.api.db.query('models')
    if (result.success && result.data) {
      setModels(result.data.map((m: Record<string, unknown>) => ({
        id: m.id as string,
        name: m.name as string,
        provider: m.provider as string,
        baseUrl: m.base_url as string,
        apiKey: m.api_key_encrypted as string,
        modelId: m.model_id as string,
        temperature: m.temperature as number,
        maxTokens: m.max_tokens as number,
        timeoutSec: m.timeout_sec as number,
        tier: m.tier as 'high' | 'low',
        isDefault: m.is_default === 1
      })))
    }
  }

  useEffect(() => {
    loadModels()
  }, [])

  const handleAdd = () => {
    setEditingModel({
      id: '',
      name: '',
      provider: 'openai-compatible',
      baseUrl: '',
      apiKey: '',
      modelId: '',
      temperature: 0.7,
      maxTokens: 16000,
      timeoutSec: 120,
      tier: 'high',
      isDefault: false
    })
    setTestResult(null)
    setIsModalOpen(true)
  }

  const handleEdit = (model: Model) => {
    setEditingModel(model)
    setTestResult(null)
    setIsModalOpen(true)
  }

  const handleSave = async () => {
    if (!editingModel) return

    const data = {
      name: editingModel.name,
      provider: editingModel.provider,
      base_url: editingModel.baseUrl,
      api_key_encrypted: editingModel.apiKey,
      model_id: editingModel.modelId,
      temperature: editingModel.temperature,
      max_tokens: editingModel.maxTokens,
      timeout_sec: editingModel.timeoutSec,
      tier: editingModel.tier,
      is_default: editingModel.isDefault ? 1 : 0
    }

    if (editingModel.id) {
      await window.api.db.mutation('models', 'update', data, 'id = ?', [editingModel.id])
    } else {
      await window.api.db.mutation('models', 'insert', data)
    }

    setIsModalOpen(false)
    loadModels()
  }

  const handleTest = async () => {
    if (!editingModel) return
    setIsTesting(true)
    setTestResult(null)

    const result = await window.api.ai.connectionTest({
      baseUrl: editingModel.baseUrl,
      apiKey: editingModel.apiKey,
      modelId: editingModel.modelId
    })

    setIsTesting(false)
    setTestResult(result.success
      ? { success: true, message: '连接成功！' }
      : { success: false, message: result.error || '连接失败' }
    )
  }

  const handleDelete = async (id: string) => {
    await window.api.db.mutation('models', 'delete', {}, 'id = ?', [id])
    loadModels()
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
          <h1 className="text-2xl font-bold text-gray-900">模型管理</h1>
          <button
            onClick={handleAdd}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium"
          >
            添加模型
          </button>
        </div>

        <div className="grid gap-4">
          {models.map((model) => (
            <div key={model.id} className="bg-white rounded-lg shadow p-6 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold text-gray-900">{model.name}</h3>
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    model.tier === 'high' ? 'bg-purple-100 text-purple-700' : 'bg-green-100 text-green-700'
                  }`}>
                    {model.tier === 'high' ? '高级' : '低级'}
                  </span>
                  {model.isDefault && (
                    <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">默认</span>
                  )}
                </div>
                <p className="text-sm text-gray-500 mt-1">{model.baseUrl}</p>
                <p className="text-sm text-gray-500">模型: {model.modelId}</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleEdit(model)}
                  className="px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded"
                >
                  编辑
                </button>
                <button
                  onClick={() => handleDelete(model.id)}
                  className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>

        {models.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            暂无模型，请添加
          </div>
        )}
      </div>

      {isModalOpen && editingModel && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
            <h2 className="text-xl font-semibold mb-4">{editingModel.id ? '编辑模型' : '添加模型'}</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">名称</label>
                <input
                  type="text"
                  value={editingModel.name}
                  onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API 地址</label>
                <input
                  type="text"
                  value={editingModel.baseUrl}
                  onChange={(e) => setEditingModel({ ...editingModel, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                <input
                  type="password"
                  value={editingModel.apiKey}
                  onChange={(e) => setEditingModel({ ...editingModel, apiKey: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">模型 ID</label>
                <input
                  type="text"
                  value={editingModel.modelId}
                  onChange={(e) => setEditingModel({ ...editingModel, modelId: e.target.value })}
                  placeholder="gpt-4o"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">温度</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={editingModel.temperature}
                    onChange={(e) => setEditingModel({ ...editingModel, temperature: parseFloat(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">最大 Token</label>
                  <input
                    type="number"
                    value={editingModel.maxTokens}
                    onChange={(e) => setEditingModel({ ...editingModel, maxTokens: parseInt(e.target.value) })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">等级</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={editingModel.tier === 'high'}
                      onChange={() => setEditingModel({ ...editingModel, tier: 'high' })}
                    />
                    <span>高级模型</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={editingModel.tier === 'low'}
                      onChange={() => setEditingModel({ ...editingModel, tier: 'low' })}
                    />
                    <span>低级模型</span>
                  </label>
                </div>
              </div>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editingModel.isDefault}
                  onChange={(e) => setEditingModel({ ...editingModel, isDefault: e.target.checked })}
                />
                <span>设为默认模型</span>
              </label>
            </div>

            {testResult && (
              <div className={`mt-4 p-3 rounded-lg ${testResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                {testResult.message}
              </div>
            )}

            <div className="flex justify-between mt-6">
              <button
                onClick={handleTest}
                disabled={isTesting || !editingModel.baseUrl || !editingModel.apiKey}
                className="px-4 py-2 text-indigo-600 border border-indigo-600 rounded-lg hover:bg-indigo-50 disabled:opacity-50"
              >
                {isTesting ? '测试中...' : '连接测试'}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}