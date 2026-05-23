import { useState, useCallback, useRef } from 'react'
import { nanoid } from 'nanoid'
import type { ChapterSummary } from '../stores/useContextStore'

// ── Types ──

export interface SceneTag {
  categoryId: string
  name: string
  start: number
  end: number
  source: string
}

export interface SummaryGenerationInput {
  chapterId: string
  title: string
  content: string
  sceneTags?: SceneTag[]
}

export interface ModelConfig {
  baseUrl: string
  modelId: string
  apiKey: string
}

export interface SummaryGenerationOptions {
  signal?: AbortSignal
  onProgress?: (text: string) => void
}

export interface SummaryGenerationResult {
  plotSummary: string
  sceneSummary: string
  additions: Array<{ type: string; content: string }>
}

interface RawSummaryData {
  plot_summary: string
  characters: Array<{ name: string; role: string; appearance: string; emotion: string }>
  key_events: Array<{ event: string; significance: string }>
  environment: { location: string; time: string; atmosphere: string; color_tone: string }
  clothing: Array<{ character: string; outfit: string }>
  scene_summary?: string
}

// ── Hook ──

export function useSummaryGeneration() {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  const generateSummary = useCallback(async (
    input: SummaryGenerationInput,
    modelConfig: ModelConfig,
    options?: SummaryGenerationOptions
  ): Promise<SummaryGenerationResult> => {
    setGenerating(true)
    setError(null)

    try {
      // Build scene tags context if available
      let sceneTagsContext = ''
      if (input.sceneTags && input.sceneTags.length > 0) {
        const names = input.sceneTags.map(t => t.name)
        sceneTagsContext = `\n【本章已识别的场景】${names.join('、')}\n`
      }

      const prompt = `你是一个小说分析助手。请围绕主角的视角，为以下章节生成内容总结。主角通常是最早出场、戏份最多、推动剧情的核心人物。

【章节标题】${input.title}${sceneTagsContext}
【章节内容】
${input.content.slice(0, 4000)}

请以主角为中心，以 JSON 返回（不要markdown标记）：
{
  "plot_summary": "以主角为主线，用200-400字概括本章情节：主角做了什么、遇到了谁、发生了什么变化、做出了什么关键决定",
  "characters": [
    {"name": "角色名", "description": "这个角色与主角的关系，在本章中的作用（主角本人排第一）"}
  ],
  "key_events": [
    {"event": "以主角为视角描述关键事件：主角的主动行为、主角遭遇的转折、主角的情感变化"}
  ],
  "scene_summary": "统计本章各场景类别出现次数，格式如：丝袜足交(2处)|修炼双修(1处)|亲吻(1处)。如无场景标签，返回空字符串"
}`

      const messages = [
        { role: 'user' as const, content: prompt }
      ]

      const streamId = nanoid()
      let fullResponse = ''

      // Set up abort handler
      const abort = () => {
        window.api.ai.abort(streamId)
      }
      abortRef.current = abort

      // Check for abort signal
      if (options?.signal) {
        if (options.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        options.signal.addEventListener('abort', abort, { once: true })
      }

      await new Promise<void>((resolve, reject) => {
        const unsubToken = window.api.ai.onToken(({ id, token }) => {
          if (id === streamId) {
            fullResponse += token
          }
        })
        const unsubDone = window.api.ai.onDone(({ id }) => {
          if (id === streamId) {
            unsubToken()
            unsubDone()
            unsubErr()
            if (options?.signal) {
              options.signal.removeEventListener('abort', abort)
            }
            resolve()
          }
        })
        const unsubErr = window.api.ai.onError(({ id, error: errMsg }) => {
          if (id === streamId) {
            unsubToken()
            unsubDone()
            unsubErr()
            if (options?.signal) {
              options.signal.removeEventListener('abort', abort)
            }
            reject(new Error(errMsg))
          }
        })

        window.api.ai.stream({
          id: streamId,
          modelId: modelConfig.modelId,
          baseUrl: modelConfig.baseUrl,
          apiKey: modelConfig.apiKey,
          messages,
          temperature: 0.5,
          maxTokens: 2000,
        }).then(r => {
          if (!r.success) {
            unsubToken()
            unsubDone()
            unsubErr()
            if (options?.signal) {
              options.signal.removeEventListener('abort', abort)
            }
            reject(new Error(r.error || 'AI 请求失败'))
          }
        })
      })

      // Parse response
      const parsed = await window.api.ai.safeParseJson(fullResponse)

      let data: RawSummaryData
      let sceneSummary = ''

      if (parsed.data && typeof parsed.data === 'object' && (parsed.data as any).plot_summary) {
        const raw = parsed.data as any
        sceneSummary = (raw.scene_summary || '').trim()
        data = {
          plot_summary: raw.plot_summary || '',
          characters: (raw.characters || []).map((c: any) => ({
            name: c.name || '',
            role: c.description || c.role || '',
            appearance: c.appearance || '',
            emotion: c.emotion || '',
          })),
          key_events: (raw.key_events || []).map((e: any) => ({
            event: e.event || '',
            significance: e.significance || '',
          })),
          environment: {
            location: '',
            time: '',
            atmosphere: '',
            color_tone: raw.environment?.color_tone || '',
          },
          clothing: (raw.clothing || []).map((c: any) => ({
            character: c.character || '',
            outfit: c.outfit || '',
          })),
        }
      } else {
        data = {
          plot_summary: fullResponse.slice(0, 300),
          characters: [],
          key_events: [],
          environment: { location: '', time: '', atmosphere: '', color_tone: '' },
          clothing: [],
        }
      }

      const additions: Array<{ type: string; content: string }> = [
        ...data.characters
          .filter((c: RawSummaryData['characters'][number]) => c.name)
          .map((c) => ({
            type: '人物',
            content: c.role || `${c.name}: ${c.role} ${c.emotion}`.trim(),
          })),
        ...data.key_events
          .filter((e: RawSummaryData['key_events'][number]) => e.event)
          .map((e) => ({
            type: '关键事件',
            content: e.event + (e.significance ? ` — ${e.significance}` : ''),
          })),
        ...(data.environment.color_tone
          ? [{ type: '环境' as const, content: `色调: ${data.environment.color_tone}` }]
          : []),
        ...data.clothing
          .filter((c: RawSummaryData['clothing'][number]) => c.character)
          .map((c) => ({
            type: '着装',
            content: `${c.character}: ${c.outfit}`,
          })),
      ]

      return { plotSummary: data.plot_summary, sceneSummary, additions }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw err
    } finally {
      setGenerating(false)
      abortRef.current = null
    }
  }, [])

  const abort = useCallback(() => {
    abortRef.current?.()
  }, [])

  return { generateSummary, abort, generating, error }
}

/**
 * Convenience function that calls generateSummary and then persists via context store.
 * Uses the project's own context.saveSummary + addChapterSummary flow.
 */
export function createSaveAndStore(
  generateSummary: ReturnType<typeof useSummaryGeneration>['generateSummary'],
  addChapterSummary: (summary: ChapterSummary) => void,
  projectId: string,
) {
  return async (
    input: SummaryGenerationInput,
    modelConfig: ModelConfig,
    options?: SummaryGenerationOptions,
  ): Promise<SummaryGenerationResult> => {
    const result = await generateSummary(input, modelConfig, options)

    const saveResult = await window.api.context.saveSummary({
      projectId,
      chapterId: input.chapterId,
      summary: {
        plot_summary: result.plotSummary,
        additions: result.additions,
        scene_summary: result.sceneSummary as string | undefined,
      } as any,
    })

    if (saveResult.success && saveResult.data) {
      addChapterSummary({
        id: (saveResult.data as any).id,
        chapterId: input.chapterId,
        plotSummary: result.plotSummary,
        sceneSummary: result.sceneSummary || undefined,
        additions: result.additions,
        createdAt: new Date().toISOString(),
      })
    }

    return result
  }
}
