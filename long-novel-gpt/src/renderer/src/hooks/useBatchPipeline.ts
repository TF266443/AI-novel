import { useCallback, useRef, useState } from 'react'
import { useSummaryGeneration, createSaveAndStore } from './useSummaryGeneration'
import { useScanAnalysis } from './useScanAnalysis'
import { useRewriteChapter } from './useRewriteChapter'
import { useProjectStore } from '../stores/useProjectStore'
import { useContextStore } from '../stores/useContextStore'
import type { SceneTag } from '../stores/useProjectStore'

// ── Types ──

export interface PipelineProgress {
  done: number
  total: number
  errors: number
}

export type PipelineStage = 'summary' | 'scan' | 'rewrite'

interface Category {
  id: string
  name: string
  conditions: string
  synonyms?: string[]
  examples?: Array<{ text: string; label: string }>
  confidence_threshold?: number
}

interface StartOptions {
  projectId: string
  stages: PipelineStage[]
  chapterIds: string[]
  concurrency?: number
  delayMs?: number
  maxRetries?: number
  modelConfig: { baseUrl: string; modelId: string; apiKey: string }
  categories: Category[]
  onProgress?: (stage: string, done: number, total: number) => void
}

interface PipelineState {
  running: boolean
  currentStage: PipelineStage | null
  progress: PipelineProgress
  chapterStatuses: Map<string, 'pending' | 'processing' | 'done' | 'error'>
}

const INITIAL_STATE: PipelineState = {
  running: false,
  currentStage: null,
  progress: { done: 0, total: 0, errors: 0 },
  chapterStatuses: new Map(),
}

// ── Hook ──

export function useBatchPipeline() {
  const [state, setState] = useState<PipelineState>(INITIAL_STATE)

  const { generateSummary } = useSummaryGeneration()
  const { analyze } = useScanAnalysis()
  const { rewriteChapter: doRewrite } = useRewriteChapter()

  const pipelineRef = useRef({
    running: false,
    paused: false,
    stopped: false,
  })

  // ── Promise pool: run max N tasks concurrently ──
  const runWithConcurrency = useCallback(
    async <T, R>(
      items: T[],
      concurrency: number,
      delayMs: number,
      worker: (item: T) => Promise<R>,
    ): Promise<Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }>> => {
      const results: Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }> =
        new Array(items.length)
      let nextIndex = 0

      const run = async () => {
        while (nextIndex < items.length) {
          if (pipelineRef.current.stopped || pipelineRef.current.paused) {
            return
          }
          const i = nextIndex
          nextIndex++

          try {
            const value = await worker(items[i])
            results[i] = { status: 'fulfilled', value }
          } catch (err: unknown) {
            results[i] = { status: 'rejected', reason: err }
          }

          if (delayMs > 0) {
            await new Promise<void>((r) => setTimeout(r, delayMs))
          }
        }
      }

      const workers = Array.from({ length: concurrency }, () => run())
      await Promise.all(workers)

      return results
    },
    [],
  )

  // ── Wait helper with pause/stop checks ──
  const waitWhilePaused = useCallback(async () => {
    while (pipelineRef.current.paused && !pipelineRef.current.stopped) {
      await new Promise<void>((r) => setTimeout(r, 100))
    }
  }, [])

  // ── Run summary stage ──
  const runSummaryStage = useCallback(
    async (
      projectId: string,
      chapterIds: string[],
      modelConfig: { baseUrl: string; modelId: string; apiKey: string },
      concurrency: number,
      delayMs: number,
      maxRetries: number,
      onChapterDone?: () => void,
    ): Promise<number> => {
      const projectStore = useProjectStore.getState()
      const contextStore = useContextStore.getState()
      const saveAndStore = createSaveAndStore(generateSummary, contextStore.addChapterSummary, projectId)

      let errors = 0

      await runWithConcurrency(
        chapterIds,
        concurrency,
        delayMs,
        async (chapterId: string) => {
          await waitWhilePaused()

          const chapter = projectStore.chapters.find((c) => c.id === chapterId)
          if (!chapter) {
            errors++
            return
          }

          // Skip if already has summary
          const hasSummary = contextStore.hasSummaryIds.has(chapterId)
          if (hasSummary) {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'done'),
            }))
            return
          }

          // Load text if needed
          if (!chapter.originalText) {
            await projectStore.loadChapterText(chapterId)
          }

          const currentChapter = useProjectStore.getState().chapters.find((c) => c.id === chapterId)
          if (!currentChapter?.originalText) {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1, errors: prev.progress.errors + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'error'),
            }))
            errors++
            return
          }

          setState((prev) => ({
            ...prev,
            chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'processing'),
          }))
          // Signal active processing for UI spinner
          useProjectStore.getState().setActiveChapterIds(prev => [...prev, chapterId])
          useProjectStore.getState().updateChapterStatus(chapterId, 'processing')

          let lastErr: unknown = null
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              await saveAndStore(
                {
                  chapterId: currentChapter.id,
                  title: currentChapter.title,
                  content: currentChapter.originalText,
                },
                modelConfig,
              )
              lastErr = null
              break
            } catch (err: unknown) {
              lastErr = err
              if (attempt < maxRetries) {
                await new Promise<void>((r) => setTimeout(r, 1000 * (attempt + 1)))
              }
            }
          }

          if (lastErr) {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1, errors: prev.progress.errors + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'error'),
            }))
            errors++
          } else {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'done'),
            }))
          }
          // Clear active processing indicator
          useProjectStore.getState().setActiveChapterIds(prev => prev.filter(id => id !== chapterId))
          onChapterDone?.()
        },
      )

      return errors
    },
    [generateSummary, runWithConcurrency, waitWhilePaused],
  )

  // ── Run scan stage ──
  const runScanStage = useCallback(
    async (
      projectId: string,
      chapterIds: string[],
      modelConfig: { baseUrl: string; modelId: string; apiKey: string },
      categories: Category[],
      concurrency: number,
      delayMs: number,
      maxRetries: number,
      onChapterDone?: () => void,
    ): Promise<number> => {
      const projectStore = useProjectStore.getState()

      let errors = 0

      await runWithConcurrency(
        chapterIds,
        concurrency,
        delayMs,
        async (chapterId: string) => {
          await waitWhilePaused()

          const chapter = projectStore.chapters.find((c) => c.id === chapterId)
          if (!chapter) {
            errors++
            return
          }

          // Skip if already has scene tags
          if (chapter.sceneTags && chapter.sceneTags.length > 0) {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'done'),
            }))
            return
          }

          // Load text and scene data if needed
          if (!chapter.originalText) {
            await projectStore.loadChapterText(chapterId)
          }
          await projectStore.loadSceneData(chapterId)

          const currentChapter = useProjectStore.getState().chapters.find((c) => c.id === chapterId)
          if (!currentChapter?.originalText) {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1, errors: prev.progress.errors + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'error'),
            }))
            errors++
            return
          }

          setState((prev) => ({
            ...prev,
            chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'processing'),
          }))
          useProjectStore.getState().setActiveChapterIds(prev => [...prev, chapterId])
          useProjectStore.getState().updateChapterStatus(chapterId, 'processing')

          let tags: SceneTag[] = []
          let lastErr: unknown = null
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              tags = await analyze(
                currentChapter.originalText,
                chapterId,
                categories,
                modelConfig,
                currentChapter.sceneTags.filter((t) => t.source === 'manual') || [],
                {
                  projectId,
                  enableEmbeddingRecall: true,
                  embeddingModel: modelConfig,
                },
              )
              lastErr = null
              break
            } catch (err: unknown) {
              lastErr = err
              if (attempt < maxRetries) {
                await new Promise<void>((r) => setTimeout(r, 1000 * (attempt + 1)))
              }
            }
          }

          if (lastErr) {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1, errors: prev.progress.errors + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'error'),
            }))
            errors++
          } else {
            useProjectStore.getState().updateChapterSceneTags(chapterId, tags)
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'done'),
            }))
          }
          useProjectStore.getState().setActiveChapterIds(prev => prev.filter(id => id !== chapterId))
          onChapterDone?.()
        },
      )

      return errors
    },
    [analyze, runWithConcurrency, waitWhilePaused],
  )

  // ── Run rewrite stage ──
  const runRewriteStage = useCallback(
    async (
      projectId: string,
      chapterIds: string[],
      concurrency: number,
      delayMs: number,
      maxRetries: number,
      onChapterDone?: () => void,
    ): Promise<number> => {
      const projectStore = useProjectStore.getState()

      let errors = 0

      await runWithConcurrency(
        chapterIds,
        concurrency,
        delayMs,
        async (chapterId: string) => {
          await waitWhilePaused()

          const chapter = projectStore.chapters.find((c) => c.id === chapterId)
          if (!chapter) {
            errors++
            return
          }

          // Skip if already done
          if (chapter.status === 'done' && chapter.rewrittenText) {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'done'),
            }))
            return
          }

          // Load text and scene data if needed
          if (!chapter.originalText) {
            await projectStore.loadChapterText(chapterId)
          }
          if (!chapter.sceneTags || chapter.sceneTags.length === 0) {
            await projectStore.loadSceneData(chapterId)
          }

          const currentChapter = useProjectStore.getState().chapters.find((c) => c.id === chapterId)
          if (!currentChapter?.originalText) {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1, errors: prev.progress.errors + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'error'),
            }))
            errors++
            return
          }

          setState((prev) => ({
            ...prev,
            chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'processing'),
          }))
          useProjectStore.getState().updateChapterStatus(chapterId, 'processing')
          useProjectStore.getState().setActiveChapterIds(prev => [...prev, chapterId])

          let lastErr: unknown = null
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const result = await doRewrite(
                {
                  id: currentChapter.id,
                  chapterIndex: currentChapter.chapterIndex,
                  originalText: currentChapter.originalText,
                  sceneTags: currentChapter.sceneTags || [],
                },
                {},
              )

              if (result.error) {
                lastErr = new Error(result.error)
              } else {
                useProjectStore.getState().updateChapterRewrittenText(chapterId, result.rewrittenText)
                useProjectStore.getState().updateChapterStatus(chapterId, 'done')
                lastErr = null
                break
              }
            } catch (err: unknown) {
              lastErr = err
            }

            if (lastErr && attempt < maxRetries) {
              await new Promise<void>((r) => setTimeout(r, 2000 * (attempt + 1)))
            }
          }

          if (lastErr) {
            useProjectStore.getState().updateChapterStatus(chapterId, 'error')
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1, errors: prev.progress.errors + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'error'),
            }))
            errors++
          } else {
            setState((prev) => ({
              ...prev,
              progress: { ...prev.progress, done: prev.progress.done + 1 },
              chapterStatuses: new Map(prev.chapterStatuses).set(chapterId, 'done'),
            }))
          }
          useProjectStore.getState().setActiveChapterIds(prev => prev.filter(id => id !== chapterId))
          onChapterDone?.()
        },
      )

      return errors
    },
    [doRewrite, runWithConcurrency, waitWhilePaused],
  )

  // ── Start: run stages sequentially, each as a wave ──
  const start = useCallback(
    async (options: StartOptions) => {
      const {
        projectId,
        stages,
        chapterIds,
        concurrency = 2,
        delayMs = 500,
        maxRetries = 1,
        modelConfig,
        categories,
        onProgress,
      } = options

      pipelineRef.current = { running: true, paused: false, stopped: false }

      const initialStatuses = new Map<string, 'pending' | 'processing' | 'done' | 'error'>()
      for (const id of chapterIds) {
        initialStatuses.set(id, 'pending')
      }

      setState({
        running: true,
        currentStage: stages[0] || null,
        progress: { done: 0, total: chapterIds.length * stages.length, errors: 0 },
        chapterStatuses: initialStatuses,
      })

      let cumulativeErrors = 0
      let cumulativeDone = 0

      for (const stage of stages) {
        if (pipelineRef.current.stopped) break

        setState((prev) => ({
          ...prev,
          currentStage: stage,
          progress: { done: cumulativeDone, total: chapterIds.length * stages.length, errors: cumulativeErrors },
        }))

        onProgress?.(stage, 0, chapterIds.length)

        const stageTotal = chapterIds.length
        const beforeErrors = cumulativeErrors

        let stageErrors = 0
        let stageDone = 0
        const reportProgress = () => {
          stageDone++
          onProgress?.(stage, stageDone, stageTotal)
          setState((prev) => ({
            ...prev,
            progress: { ...prev.progress, done: cumulativeDone + stageDone },
          }))
        }

        switch (stage) {
          case 'summary':
            stageErrors = await runSummaryStage(projectId, chapterIds, modelConfig, concurrency, delayMs, maxRetries, reportProgress)
            break
          case 'scan':
            stageErrors = await runScanStage(projectId, chapterIds, modelConfig, categories, concurrency, delayMs, maxRetries, reportProgress)
            break
          case 'rewrite':
            stageErrors = await runRewriteStage(projectId, chapterIds, concurrency, delayMs, maxRetries, reportProgress)
            break
        }

        if (pipelineRef.current.stopped) break

        cumulativeErrors += stageErrors
        cumulativeDone += chapterIds.length

        onProgress?.(stage, chapterIds.length, stageTotal)
      }

      if (!pipelineRef.current.stopped) {
        setState((prev) => ({
          ...prev,
          running: false,
          currentStage: null,
          progress: {
            done: cumulativeDone,
            total: chapterIds.length * stages.length,
            errors: cumulativeErrors,
          },
        }))
      }

      pipelineRef.current.running = false
    },
    [runSummaryStage, runScanStage, runRewriteStage],
  )

  // ── Pause ──
  const pause = useCallback(() => {
    pipelineRef.current.paused = true
  }, [])

  // ── Resume ──
  const resume = useCallback(() => {
    pipelineRef.current.paused = false
  }, [])

  // ── Stop ──
  const stop = useCallback(() => {
    pipelineRef.current.stopped = true
    pipelineRef.current.paused = false
    setState((prev) => ({
      ...prev,
      running: false,
      currentStage: null,
    }))
  }, [])

  return {
    start,
    pause,
    resume,
    stop,
    running: state.running,
    currentStage: state.currentStage,
    progress: state.progress,
    chapterStatuses: state.chapterStatuses,
  }
}
