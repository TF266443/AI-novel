import { useState, useEffect, useCallback, useMemo } from 'react'
import { useProjectStore } from '../../stores/useProjectStore'
import { useBatchStore } from '../../stores/useBatchStore'
import { useBatchPipeline, type PipelineStage } from '../../hooks/useBatchPipeline'

interface Category {
  id: string
  name: string
  conditions: string
  synonyms?: string[]
  examples?: Array<{ text: string; label: string }>
  confidence_threshold?: number
}

interface Model {
  id: string
  name: string
  model_id: string
  base_url: string
  api_key_encrypted: string
}

type ChapterRange = 'all' | 'from-current' | string

const STAGE_LABELS: Record<PipelineStage, string> = {
  summary: '摘要',
  scan: '识别',
  rewrite: '扩写',
}

const STAGE_ORDER: PipelineStage[] = ['summary', 'scan', 'rewrite']

const STATUS_ICON: Record<string, string> = {
  pending: '\u25CB',  // ○
  processing: '\u23F3', // ⏳
  done: '\u2713',      // ✓
  error: '\u2717',     // ✗
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-gray-400',
  processing: 'text-blue-500',
  done: 'text-green-500',
  error: 'text-red-500',
}

export default function BatchToolbar() {
  const { chapters, currentChapterIndex, currentProject, templateVersion } = useProjectStore()
  const { isPaused, setPaused } = useBatchStore()
  const pipeline = useBatchPipeline()

  const [models, setModels] = useState<Model[]>([])
  const [categories, setCategories] = useState<Category[]>([])

  // UI state
  const [range, setRange] = useState<ChapterRange>('all')
  const [showRangeDropdown, setShowRangeDropdown] = useState(false)
  const [stages, setStages] = useState<Set<PipelineStage>>(new Set(STAGE_ORDER))

  // ── Load models (one-shot) ──
  useEffect(() => {
    let cancelled = false
    window.api.db.query('models').then((r: any) => {
      if (cancelled || !r.success || !r.data) return
      const m = r.data.filter(
        (x: any) => !/embed|nomic/i.test(x.model_id || '') && !/embed|nomic/i.test(x.name || ''),
      )
      setModels(m)
    })
    return () => { cancelled = true }
  }, [])

  // ── Load categories from template ──
  useEffect(() => {
    if (!currentProject?.templateId) return
    let cancelled = false
    window.api.db.query('templates', 'id = ?', [currentProject.templateId]).then((r: any) => {
      if (cancelled || !r.success || !r.data?.length) return
      try {
        const tpl = JSON.parse(r.data[0].template_json)
        const identifyTemplate = typeof tpl.identifyTemplate === 'string' ? JSON.parse(tpl.identifyTemplate) : tpl.identifyTemplate
        if (!cancelled && identifyTemplate?.categories) {
          setCategories(identifyTemplate.categories)
        }
      } catch {
        /* ignore parse errors */
      }
    })
    return () => { cancelled = true }
  }, [currentProject?.templateId, templateVersion])

  // ── Compute chapter IDs based on selected range ──
  const chapterIds = useMemo<string[]>(() => {
    if (range === 'all') {
      return chapters.map((c) => c.id)
    }
    if (range === 'from-current') {
      return chapters.slice(currentChapterIndex).map((c) => c.id)
    }
    // Single chapter
    return [range]
  }, [range, chapters, currentChapterIndex])

  // ── Active stages as ordered array ──
  const activeStages = useMemo<PipelineStage[]>(
    () => STAGE_ORDER.filter((s) => stages.has(s)),
    [stages],
  )

  // ── Toggle a stage checkbox ──
  const toggleStage = useCallback((stage: PipelineStage) => {
    setStages((prev) => {
      const next = new Set(prev)
      if (next.has(stage)) {
        next.delete(stage)
      } else {
        next.add(stage)
      }
      return next
    })
  }, [])

  // ── Start batch ──
  const handleStart = useCallback(async () => {
    if (!currentProject || activeStages.length === 0 || chapterIds.length === 0) return

    const nonEmbedModel = models[0]
    if (!nonEmbedModel) return

    setPaused(false)

    await pipeline.start({
      projectId: currentProject.id,
      stages: activeStages,
      chapterIds,
      concurrency: 2,
      delayMs: 500,
      maxRetries: 1,
      modelConfig: {
        baseUrl: nonEmbedModel.base_url,
        modelId: nonEmbedModel.model_id,
        apiKey: nonEmbedModel.api_key_encrypted,
      },
      categories,
    })
  }, [currentProject, activeStages, chapterIds, models, categories, pipeline, setPaused])

  // ── Pause handler ──
  const handlePause = useCallback(() => {
    pipeline.pause()
    setPaused(true)
  }, [pipeline, setPaused])

  // ── Resume handler ──
  const handleResume = useCallback(() => {
    pipeline.resume()
    setPaused(false)
  }, [pipeline, setPaused])

  // ── Stop handler ──
  const handleStop = useCallback(() => {
    pipeline.stop()
    setPaused(false)
  }, [pipeline, setPaused])

  // ── Retry a single chapter ──
  const handleRetryChapter = useCallback(
    async (chapterId: string) => {
      if (!currentProject || activeStages.length === 0) return
      const nonEmbedModel = models[0]
      if (!nonEmbedModel) return

      setPaused(false)

      await pipeline.start({
        projectId: currentProject.id,
        stages: activeStages,
        chapterIds: [chapterId],
        concurrency: 1,
        delayMs: 0,
        maxRetries: 1,
        modelConfig: {
          baseUrl: nonEmbedModel.base_url,
          modelId: nonEmbedModel.model_id,
          apiKey: nonEmbedModel.api_key_encrypted,
        },
        categories,
      })
    },
    [currentProject, activeStages, models, categories, pipeline, setPaused],
  )

  // ── Stage-specific progress text ──
  const stageProgressText = useMemo(() => {
    if (!pipeline.currentStage) return null
    return `${STAGE_LABELS[pipeline.currentStage]}: ${pipeline.progress.done}/${pipeline.progress.total}`
  }, [pipeline.currentStage, pipeline.progress])

  // ── Overall progress percent ──
  const progressPercent = useMemo(() => {
    if (pipeline.progress.total === 0) return 0
    return Math.round((pipeline.progress.done / pipeline.progress.total) * 100)
  }, [pipeline.progress])

  // ── Chapter display list (up to 20 visible) ──
  const visibleChapters = useMemo(() => {
    return chapters.filter((c) => chapterIds.includes(c.id)).slice(0, 20)
  }, [chapters, chapterIds])

  const hasMoreChapters = chapters.filter((c) => chapterIds.includes(c.id)).length > 20

  return (
    <div className="border-b border-gray-200 bg-gray-50">
      {/* ── Row 1: Controls ── */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Chapter range dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowRangeDropdown((v) => !v)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded hover:bg-gray-100 transition"
          >
            <span>{range === 'all' ? '全部章节' : range === 'from-current' ? '当前及之后' : '单章'}</span>
            <svg className="w-3 h-3" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 1l4 4 4-4" />
            </svg>
          </button>
          {showRangeDropdown && (
            <div
              className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded shadow-lg z-20 min-w-[160px]"
              onMouseLeave={() => setShowRangeDropdown(false)}
            >
              <button
                onClick={() => { setRange('all'); setShowRangeDropdown(false) }}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 ${range === 'all' ? 'text-indigo-600 font-medium' : ''}`}
              >
                全部章节
              </button>
              <button
                onClick={() => { setRange('from-current'); setShowRangeDropdown(false) }}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 ${range === 'from-current' ? 'text-indigo-600 font-medium' : ''}`}
              >
                当前及之后
              </button>
              <div className="border-t border-gray-100 max-h-32 overflow-y-auto">
                {chapters.map((c, i) => (
                  <button
                    key={c.id}
                    onClick={() => { setRange(c.id); setShowRangeDropdown(false) }}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 truncate ${range === c.id ? 'text-indigo-600 font-medium' : ''}`}
                  >
                    第{i + 1}章: {c.title || '(无标题)'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Stage checkboxes */}
        {STAGE_ORDER.map((stage) => (
          <label
            key={stage}
            className={`flex items-center gap-1 px-2 py-1.5 text-sm rounded cursor-pointer select-none transition ${
              stages.has(stage) ? 'bg-indigo-100 text-indigo-700' : 'bg-white text-gray-500 border border-gray-300'
            } ${pipeline.running ? 'opacity-60 cursor-not-allowed' : 'hover:bg-indigo-50'}`}
          >
            <input
              type="checkbox"
              checked={stages.has(stage)}
              onChange={() => toggleStage(stage)}
              disabled={pipeline.running}
              className="sr-only"
            />
            <span>{stages.has(stage) ? '\u2611' : '\u2610'}</span>
            <span>{STAGE_LABELS[stage]}</span>
          </label>
        ))}

        {/* Start / action buttons */}
        {!pipeline.running && (
          <button
            onClick={handleStart}
            disabled={activeStages.length === 0 || chapterIds.length === 0 || models.length === 0}
            className="ml-auto px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {'\u25B6'} 开始
          </button>
        )}

        {pipeline.running && (
          <div className="ml-auto flex items-center gap-1.5">
            {isPaused ? (
              <button
                onClick={handleResume}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 transition"
              >
                {'\u25B6'} 继续
              </button>
            ) : (
              <button
                onClick={handlePause}
                className="px-3 py-1.5 text-sm bg-yellow-500 text-white rounded hover:bg-yellow-600 transition"
              >
                {'\u23F8'} 暂停
              </button>
            )}
            <button
              onClick={handleStop}
              className="px-3 py-1.5 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition"
            >
              {'\u23F9'} 停止
            </button>
          </div>
        )}
      </div>

      {/* ── Row 2: Progress bar + stage info (only when running or has completed) ── */}
      {pipeline.running && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-3 text-xs text-gray-600 mb-1">
            <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="whitespace-nowrap font-mono">
              {pipeline.progress.done}/{pipeline.progress.total}
              {pipeline.progress.errors > 0 && (
                <span className="text-red-500 ml-1">({pipeline.progress.errors}错)</span>
              )}
            </span>
          </div>
          {stageProgressText && (
            <div className="text-xs text-gray-500">{stageProgressText}</div>
          )}
        </div>
      )}

      {/* ── Row 3: Chapter status dots ── */}
      <div className="px-3 pb-2 flex flex-wrap items-center gap-1 text-xs">
        {visibleChapters.map((c) => {
          const status = pipeline.chapterStatuses.get(c.id) || 'pending'
          return (
            <button
              key={c.id}
              onClick={status === 'error' ? () => handleRetryChapter(c.id) : undefined}
              title={`第${c.chapterIndex + 1}章: ${c.title || ''} (${status})`}
              disabled={pipeline.running && status !== 'error'}
              className={`${STATUS_COLOR[status]} hover:opacity-80 transition ${
                status === 'error' ? 'cursor-pointer hover:scale-110' : pipeline.running ? 'cursor-default' : ''
              }`}
            >
              {STATUS_ICON[status]}
            </button>
          )
        })}
        {hasMoreChapters && (
          <span className="text-gray-400">+{chapters.filter((c) => chapterIds.includes(c.id)).length - 20}</span>
        )}

        {/* Legend */}
        <div className="ml-auto flex items-center gap-2 text-gray-400">
          <span title="待处理">{STATUS_ICON.pending} 待</span>
          <span title="处理中">{STATUS_ICON.processing} 中</span>
          <span title="完成" className="text-green-500">{STATUS_ICON.done} 成</span>
          <span title="错误(点击重试)" className="text-red-500">{STATUS_ICON.error} 错</span>
        </div>
      </div>
    </div>
  )
}
