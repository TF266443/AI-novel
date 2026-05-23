import { useCallback } from 'react'
import { remapSceneTags } from '../lib/remapTags'
import { nanoid } from 'nanoid'
import type { SceneTag } from '../stores/useProjectStore'

// ── Types ──

interface ChapterForRewrite {
  id: string
  chapterIndex: number
  originalText: string
  sceneTags: SceneTag[]
}

interface RewriteOptions {
  signal?: AbortSignal
  onProgress?: (text: string, progress: number) => void
  onStreamChunk?: (text: string) => void
}

interface RewriteResult {
  rewrittenText: string
  characterUpdates: Array<{ name: string; state_snapshot: unknown }>
  error?: string
}

// ── Sliding Window Rewrite Types & Algorithm ──

interface RewriteWindow {
  index: number
  start: number
  end: number
  text: string
  tagIds: Set<string>
  prevOverlap: string
}

interface SkipZone {
  start: number
  end: number
  text: string
}

const OVERLAP_CHARS = 150
const MAX_WINDOW_CHARS = 2000
const MIN_WINDOW_CHARS = 200
const MERGE_GAP_CHARS = 400
const SKIP_ZONE_THRESHOLD = 600
const MAX_CATEGORIES_PER_WINDOW = 4

export function splitChapterIntoWindows(
  sceneTags: SceneTag[],
  chapterText: string,
): { windows: RewriteWindow[]; skipZones: SkipZone[] } {
  const textLen = chapterText.length

  if (sceneTags.length === 0) {
    if (textLen <= MAX_WINDOW_CHARS) {
      return {
        windows: [{ index: 0, start: 0, end: textLen, text: chapterText, tagIds: new Set(), prevOverlap: '' }],
        skipZones: [],
      }
    }
    const windows: RewriteWindow[] = []
    let pos = 0
    let idx = 0
    while (pos < textLen) {
      const end = Math.min(pos + MAX_WINDOW_CHARS, textLen)
      windows.push({
        index: idx,
        start: pos,
        end,
        text: chapterText.slice(pos, end),
        tagIds: new Set(),
        prevOverlap: idx > 0 ? chapterText.slice(Math.max(0, pos - OVERLAP_CHARS), pos) : '',
      })
      pos = end
      idx++
    }
    return { windows, skipZones: [] }
  }

  const sorted = [...sceneTags].sort((a, b) => a.start - b.start)

  // Phase 1: Merge adjacent tags into window candidates based on gap
  const candidates: Array<{ tags: SceneTag[]; start: number; end: number }> = []
  let batch: SceneTag[] = [sorted[0]]
  let batchStart = sorted[0].start
  let batchEnd = sorted[0].end

  for (let i = 1; i < sorted.length; i++) {
    const tag = sorted[i]
    const gap = tag.start - batchEnd
    if (gap < 0) {
      batch.push(tag)
      batchEnd = Math.max(batchEnd, tag.end)
    } else if (gap <= MERGE_GAP_CHARS) {
      batch.push(tag)
      batchEnd = Math.max(batchEnd, tag.end)
    } else {
      candidates.push({ tags: [...batch], start: batchStart, end: batchEnd })
      batch = [tag]
      batchStart = tag.start
      batchEnd = tag.end
    }
  }
  if (batch.length > 0) {
    candidates.push({ tags: [...batch], start: batchStart, end: batchEnd })
  }

  // Phase 2: Split oversized candidates and merge undersized ones
  const finalCandidates: Array<{ start: number; end: number; tagIds: Set<string> }> = []

  for (const cand of candidates) {
    const candLen = cand.end - cand.start
    if (candLen > MAX_WINDOW_CHARS) {
      const tags = cand.tags.sort((a, b) => a.start - b.start)
      let segStart = cand.start
      let segEnd = cand.start
      const segmentTags: SceneTag[] = []

      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i]
        const tentativeEnd = tag.end
        const tentativeLen = tentativeEnd - segStart

        if (tentativeLen <= MAX_WINDOW_CHARS) {
          segEnd = tentativeEnd
          segmentTags.push(tag)
        } else {
          if (segmentTags.length === 0) {
            segEnd = Math.min(segStart + MAX_WINDOW_CHARS, cand.end)
            segmentTags.push(tag)
          }
          const catIds = new Set(segmentTags.map(t => t.categoryId))
          finalCandidates.push({ start: segStart, end: segEnd, tagIds: catIds })
          segStart = Math.max(segEnd, tag.start)
          segEnd = tag.end
          segmentTags.length = 0
          segmentTags.push(tag)
        }
      }
      if (segmentTags.length > 0) {
        const catIds = new Set(segmentTags.map(t => t.categoryId))
        finalCandidates.push({ start: segStart, end: Math.max(segEnd, cand.end), tagIds: catIds })
      }
    } else {
      const catIds = new Set(cand.tags.map(t => t.categoryId))
      finalCandidates.push({ start: cand.start, end: cand.end, tagIds: catIds })
    }
  }

  // Phase 3: Merge undersized candidates (< MIN_WINDOW_CHARS) into adjacent ones
  const merged: Array<{ start: number; end: number; tagIds: Set<string> }> = []
  for (let i = 0; i < finalCandidates.length; i++) {
    const curr = finalCandidates[i]
    const currLen = curr.end - curr.start
    if (currLen < MIN_WINDOW_CHARS) {
      if (merged.length > 0) {
        const prev = merged[merged.length - 1]
        const newLen = curr.end - prev.start
        const combinedCatIds = new Set([...prev.tagIds, ...curr.tagIds])
        if (newLen <= MAX_WINDOW_CHARS && combinedCatIds.size <= MAX_CATEGORIES_PER_WINDOW) {
          merged[merged.length - 1] = { start: prev.start, end: Math.max(prev.end, curr.end), tagIds: combinedCatIds }
          continue
        }
      }
      if (i + 1 < finalCandidates.length) {
        const next = finalCandidates[i + 1]
        const newLen = next.end - curr.start
        const combinedCatIds = new Set([...curr.tagIds, ...next.tagIds])
        if (newLen <= MAX_WINDOW_CHARS && combinedCatIds.size <= MAX_CATEGORIES_PER_WINDOW) {
          finalCandidates[i + 1] = { start: curr.start, end: next.end, tagIds: combinedCatIds }
          continue
        }
      }
    }
    merged.push(curr)
  }

  // Phase 4: Cap category count per window
  const capped = merged.map(m => {
    if (m.tagIds.size > MAX_CATEGORIES_PER_WINDOW) {
      const kept = [...m.tagIds].slice(0, MAX_CATEGORIES_PER_WINDOW)
      return { ...m, tagIds: new Set(kept) }
    }
    return m
  })

  // Phase 5: Identify skip zones
  const skipZones: SkipZone[] = []
  const windows: RewriteWindow[] = []

  let prevWindowEnd = 0
  for (let i = 0; i < capped.length; i++) {
    const cand = capped[i]
    const gapStart = prevWindowEnd
    const gapEnd = cand.start

    if (gapEnd - gapStart > SKIP_ZONE_THRESHOLD) {
      skipZones.push({ start: gapStart, end: gapEnd, text: chapterText.slice(gapStart, gapEnd) })
    }

    const prevOverlap = i > 0 ? chapterText.slice(Math.max(0, cand.start - OVERLAP_CHARS), cand.start) : ''
    windows.push({
      index: i,
      start: cand.start,
      end: cand.end,
      text: chapterText.slice(cand.start, cand.end),
      tagIds: cand.tagIds,
      prevOverlap,
    })

    prevWindowEnd = cand.end
  }

  if (textLen - prevWindowEnd > SKIP_ZONE_THRESHOLD) {
    skipZones.push({ start: prevWindowEnd, end: textLen, text: chapterText.slice(prevWindowEnd) })
  }

  return { windows, skipZones }
}

export function stitchWindows(
  windowOutputs: string[],
  windows: RewriteWindow[],
  skipZones: SkipZone[],
  originalText: string,
): string {
  let result = ''
  let originalPos = 0
  let skipIdx = 0

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi]

    while (skipIdx < skipZones.length && skipZones[skipIdx].start < win.start) {
      const sz = skipZones[skipIdx]
      if (sz.start > originalPos) {
        result += originalText.slice(originalPos, sz.start)
      }
      result += sz.text
      originalPos = sz.end
      skipIdx++
    }

    if (originalPos < win.start) {
      result += originalText.slice(originalPos, win.start)
    }

    let output = windowOutputs[wi] || win.text
    if (wi > 0 && output.length > OVERLAP_CHARS) {
      output = output.slice(OVERLAP_CHARS)
    }

    result += output
    originalPos = win.end
  }

  while (skipIdx < skipZones.length) {
    const sz = skipZones[skipIdx]
    if (sz.start > originalPos) {
      result += originalText.slice(originalPos, sz.start)
    }
    result += sz.text
    originalPos = sz.end
    skipIdx++
  }

  if (originalPos < originalText.length) {
    result += originalText.slice(originalPos)
  }

  return result
}

// ── Parse template category conditions into structured cues ──

export function extractCategoryMeta(cat: { conditions?: string; name?: string; synonyms?: string[] }): {
  keywords: string[]
  cues: string[]
  exclusivity: string
} {
  const keywords: string[] = []
  const cues: string[] = []
  let exclusivity = ''
  const text = cat.conditions || ''
  const SECTION_RE = /(识别点|触发点|触发条件|关键词|独占规则|排除规则)\s*[：:]/g
  const parts: Array<{ label: string; start: number; bodyStart: number }> = []
  let m: RegExpExecArray | null
  while ((m = SECTION_RE.exec(text)) !== null) {
    parts.push({ label: m[1], start: m.index, bodyStart: m.index + m[0].length })
  }
  const getBody = (i: number): string => {
    const end = i + 1 < parts.length ? parts[i + 1].start : text.length
    return text.slice(parts[i].bodyStart, end).trim().replace(/[。\n]+$/g, '').trim()
  }
  for (let i = 0; i < parts.length; i++) {
    const body = getBody(i)
    if (!body) continue
    const items = body.split(/[、,，;；\s]+/).map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 16)
    if (parts[i].label === '关键词') {
      keywords.push(...items)
    } else if (parts[i].label === '识别点' || parts[i].label === '触发点' || parts[i].label === '触发条件') {
      cues.push(...items.filter(s => s.length <= 30))
    } else if (parts[i].label === '独占规则' || parts[i].label === '排除规则') {
      exclusivity = body
    }
  }
  const quoted = text.match(/「(.+?)」/g)
  if (quoted) {
    for (const q of quoted) {
      const inner = q.replace(/[「」]/g, '')
      if (inner.length >= 2 && !keywords.includes(inner)) keywords.push(inner)
    }
  }
  if (keywords.length === 0 && cat.synonyms?.length) {
    keywords.push(...cat.synonyms.slice(0, 16))
  }
  return { keywords, cues, exclusivity }
}

// ── Build a structured scene map from tags + template data ──

interface SceneMapEntry {
  catId: string
  catName: string
  catIndex: number
  keywords: string[]
  cues: string[]
  exclusivity: string
  rewritePrompt: string
  regions: Array<{ start: number; end: number; excerpt: string; source: string; confidence?: number }>
}

export function buildSceneMap(
  tags: SceneTag[],
  chapterText: string,
  idCategories: Map<string, { name: string; conditions?: string; synonyms?: string[] }>,
  categoryPrompts: Record<string, string> | undefined,
): SceneMapEntry[] {
  const map = new Map<string, SceneMapEntry>()
  let idx = 0
  for (const tag of tags) {
    let entry = map.get(tag.categoryId)
    if (!entry) {
      const catMeta = idCategories.get(tag.categoryId)
      const { keywords, cues, exclusivity } = extractCategoryMeta(catMeta || {})
      entry = {
        catId: tag.categoryId,
        catName: tag.name || catMeta?.name || tag.categoryId,
        catIndex: idx++,
        keywords,
        cues,
        exclusivity,
        rewritePrompt: categoryPrompts?.[tag.categoryId] || '',
        regions: [],
      }
      map.set(tag.categoryId, entry)
    }
    const excerpt = chapterText.slice(tag.start, tag.end).replace(/\n/g, ' ').slice(0, 80)
    entry.regions.push({
      start: tag.start,
      end: tag.end,
      excerpt: excerpt + (tag.end - tag.start > 80 ? '…' : ''),
      source: tag.source,
      confidence: tag.confidence,
    })
  }
  return [...map.values()].sort((a, b) => (a.regions[0]?.start ?? 0) - (b.regions[0]?.start ?? 0))
}

export function formatSceneMap(entries: SceneMapEntry[]): string {
  if (entries.length === 0) return ''
  const lines: string[] = ['【场景地图 — 以下区域需要按对应场景规则扩写】', '']
  for (const entry of entries) {
    lines.push(`## ${entry.catIndex + 1}. ${entry.catName}`)
    if (entry.cues.length) lines.push(`识别点：${entry.cues.join('、')}`)
    if (entry.keywords.length) lines.push(`关键词：${entry.keywords.join('、')}`)
    if (entry.exclusivity) lines.push(`独占规则：${entry.exclusivity}`)
    lines.push('出现位置：')
    for (const r of entry.regions) {
      const srcLabel = r.source === 'manual' ? '手工标注' : r.source === 'corrected' ? '已修正' : 'AI识别'
      const confStr = r.confidence !== undefined ? ` | 置信度${(r.confidence * 100).toFixed(0)}%` : ''
      lines.push(`  - 第${r.start}-${r.end}字 [${srcLabel}${confStr}]: "${r.excerpt}"`)
    }
    if (entry.rewritePrompt) {
      const trimmed = entry.rewritePrompt.length > 600
        ? entry.rewritePrompt.slice(0, 600) + '\n…(规则较长已截断，请遵循上述要旨)'
        : entry.rewritePrompt
      lines.push(`扩写规则：${trimmed}`)
    }
    lines.push('')
  }
  lines.push('【扩写指令】')
  lines.push('1. 上述每个"出现位置"区域必须按对应场景的"扩写规则"进行加料扩写。')
  lines.push('2. 未标记的区域保持原文不变，仅做必要的衔接过渡。')
  lines.push('3. 多个场景区域之间的过渡要自然，保持叙事连贯。')
  lines.push('4. 遵守各场景的"独占规则"约束。')
  return lines.join('\n')
}

// ── Hook ──

export function useRewriteChapter() {
  const rewriteChapter = useCallback(async (
    chapter: ChapterForRewrite,
    options: RewriteOptions = {},
  ): Promise<RewriteResult> => {
    try {
      const { signal, onProgress, onStreamChunk } = options

      // ── 1. Load template ──
      let templateJson: any = null
      const prs = await window.api.db.query('projects')
      if (!prs.success || !prs.data) {
        return { rewrittenText: chapter.originalText, characterUpdates: [], error: 'No project found' }
      }
      const project = (prs.data as any[])[0] as { id: string; template_id?: string }
      if (project.template_id) {
        const templateResult = await window.api.db.query('templates', 'id = ?', [project.template_id])
        const tplData = templateResult.data as any[] | undefined
        if (templateResult.success && tplData?.length) {
          templateJson = JSON.parse(tplData[0].template_json)
          if (templateJson) {
            if (typeof templateJson.identifyTemplate === 'string') {
              templateJson.identifyTemplate = JSON.parse(templateJson.identifyTemplate)
            }
            if (typeof templateJson.rewriteTemplate === 'string') {
              templateJson.rewriteTemplate = JSON.parse(templateJson.rewriteTemplate)
            }
          }
        }
      }

      // ── 2. Load model (first available) ──
      const modelResult = await window.api.db.query('models')
      const modelData = modelResult.data as any[] | undefined
      if (!modelResult.success || !modelData?.length) {
        return { rewrittenText: chapter.originalText, characterUpdates: [], error: 'No AI model configured' }
      }
      const model = modelData[0]

      // ── 3. Load enabled skills ──
      const skillsResult = await window.api.db.query('project_skills', 'project_id = ? AND enabled = 1', [project.id])
      const enabledSkills: Array<{ skill_id: string }> = skillsResult.success && skillsResult.data ? (skillsResult.data as any[]) : []
      const skillRecords: any[] = []
      for (const ps of enabledSkills) {
        const sr = await window.api.db.query('skills', 'id = ?', [ps.skill_id])
        const srData = sr.data as any[] | undefined
        if (sr.success && srData?.length) { skillRecords.push(srData[0]) }
      }

      const promptFragments: string[] = []
      const rewriteRules: Array<{ categories: string[]; prompt: string }> = []
      const memories: string[] = []

      for (const sr of skillRecords) {
        const json = JSON.parse(sr.skill_json)
        switch (sr.type) {
          case 'prompt_fragment': promptFragments.push(json.prompt); break
          case 'rewrite_rule': rewriteRules.push({ categories: json.trigger?.sceneCategories || [], prompt: json.prompt }); break
          case 'memory': memories.push(json.prompt); break
        }
      }

      // ── 4. Load context (character states & chapter summaries) ──
      let characterStatesText = '(no character states)'
      let summariesText = '(no summaries)'
      let last5Summaries: any[] = []

      try {
        const statesResult = await window.api.context.getStates(project.id)
        if (statesResult.success && statesResult.data) {
          const characters = statesResult.data as any[]
          characterStatesText = characters.length > 0
            ? characters.map(c => `${c.name}: ${c.state_snapshot}`).join('\n')
            : '(no character states)'
        }
      } catch { /* non-critical */ }

      try {
        const chainResult = await window.api.context.getChain(project.id, chapter.chapterIndex)
        if (chainResult.success && chainResult.data) {
          const chapterSummaries = chainResult.data as any[]
          summariesText = chapterSummaries.length > 0
            ? chapterSummaries.map((s: any) => `${s.chapter_index}: ${s.plot_summary}`).join('\n')
            : '(no summaries)'
          last5Summaries = chapterSummaries.slice(-5)
        }
      } catch { /* non-critical */ }

      const summaries5Text = last5Summaries.length > 0
        ? last5Summaries.map((s: any) => `${s.chapter_index}: ${s.plot_summary}`).join('\n')
        : '(no summaries)'

      // ── 5. Build scene map ──
      const idCategories = new Map<string, { name: string; conditions?: string; synonyms?: string[] }>()
      if (templateJson?.identifyTemplate?.categories) {
        for (const cat of templateJson.identifyTemplate.categories) {
          idCategories.set(cat.id, { name: cat.name, conditions: cat.conditions, synonyms: cat.synonyms })
        }
      }
      const categoryPrompts: Record<string, string> = templateJson?.rewriteTemplate?.categoryPrompts || {}
      const sceneMapEntries = buildSceneMap(
        chapter.sceneTags,
        chapter.originalText,
        idCategories,
        categoryPrompts,
      )
      const sceneMapText = formatSceneMap(sceneMapEntries)

      // Collect skill-based scene prompts
      const chapterCatIds = new Set(chapter.sceneTags.map(t => t.categoryId))
      const skillScenePrompts = rewriteRules
        .filter(r => r.categories.some(c => chapterCatIds.has(c)))
        .map(r => r.prompt)
      const skillSceneText = skillScenePrompts.length > 0
        ? `\n\n[Skills Scene Rules]\n${skillScenePrompts.join('\n---\n')}`
        : ''

      const memoryText = memories.length > 0 ? `\n\n[Memory]\n${memories.join('\n---\n')}` : ''

      // Load persistent memory context
      let memoryContext = ''
      try {
        const mem = await window.api.context.getMemory(project.id)
        if (mem.success && mem.data) {
          const d = mem.data as any
          if (d.foreshadowing?.length) {
            memoryContext += `\n\n[Active Foreshadowing (pending)]\n${d.foreshadowing.map((f: any) => `- Ch${f.planted_in}: ${f.content}`).join('\n')}`
          }
          if (d.items?.length) {
            memoryContext += `\n\n[Character Items]\n${d.items.map((i: any) => `- ${i.owner || 'unknown'}: ${i.name} (${i.status})`).join('\n')}`
          }
          if (d.powerLevels?.length) {
            const latest: Record<string, any> = {}
            for (const p of d.powerLevels) {
              if (!latest[p.character_name] || p.chapter_index > latest[p.character_name].chapter_index) {
                latest[p.character_name] = p
              }
            }
            memoryContext += `\n\n[Power Levels]\n${Object.values(latest).map((p: any) => `- ${p.character_name}: ${p.realm || ''} ${p.stage || ''}`).join('\n')}`
          }
        }
      } catch { /* non-critical */ }

      // ── 6. Build system messages ──
      const systemMessages: Array<{ role: string; content: string }> = []
      systemMessages.push({ role: 'system', content: '你的改写必须以主角为中心。扩写内容要围绕主角的视角、行动、情感和成长展开。所有描写、对话、情节推进都要通过主角的体验来呈现。配角的作用是为凸显主角的性格和推动主角的剧情线服务。场景描写要以主角的感官为出发点（主角看到的、听到的、感受到的）。' })
      if (templateJson) {
        systemMessages.push({ role: 'system', content: templateJson.breakthroughTemplate })
        systemMessages.push({ role: 'system', content: templateJson.rewriteTemplate.commonPrompt })
      }
      for (const frag of promptFragments) {
        systemMessages.push({ role: 'system', content: frag })
      }

      // ── 7. Decide: single-call streaming vs sliding window ──
      const { windows, skipZones } = splitChapterIntoWindows(
        chapter.sceneTags,
        chapter.originalText,
      )

      const useWindowedFlow = windows.length > 1

      if (!useWindowedFlow) {
        // ── Single-call streaming flow ──
        if (templateJson) {
          const catPromptLines: string[] = []
          for (const entry of sceneMapEntries) {
            if (entry.rewritePrompt) {
              catPromptLines.push(`## ${entry.catName}\n${entry.rewritePrompt}`)
            }
          }
          if (catPromptLines.length > 0) {
            systemMessages.push({ role: 'system', content: `[Category Rewrite Rules]\n${catPromptLines.join('\n\n---\n\n')}` })
          }
        }

        const userContent = `[Character States]\n${characterStatesText}\n\n[Chapter Summaries]\n${summariesText}${memoryText}${memoryContext}\n\n[Original Text]\n${chapter.originalText}\n\n${sceneMapText}${skillSceneText}`
        const messages = [...systemMessages, { role: 'user', content: userContent }]

        const streamId = nanoid()
        let streamOutput = ''
        let streamError: string | null = null
        let streamDone = false

        return new Promise<RewriteResult>((resolve, reject) => {
          if (signal?.aborted) {
            resolve({ rewrittenText: chapter.originalText, characterUpdates: [], error: 'Aborted' })
            return
          }

          const unsubToken = window.api.ai.onToken(({ id, token }) => {
            if (id === streamId) {
              streamOutput += token
              onStreamChunk?.(token)
              onProgress?.(streamOutput, Math.min(streamOutput.length / 100, 95))
            }
          })

          const unsubDone = window.api.ai.onDone(async ({ id }) => {
            if (id !== streamId) return
            unsubToken()
            unsubDone()
            unsubError()
            try {
              const result = await finalizeRewrite(
                streamOutput,
                chapter,
                project.id,
              )
              resolve(result)
            } catch (err) {
              resolve({
                rewrittenText: streamOutput || chapter.originalText,
                characterUpdates: [],
                error: err instanceof Error ? err.message : 'Finalize failed',
              })
            }
          })

          const unsubError = window.api.ai.onError(({ id, error }) => {
            if (id !== streamId) return
            streamError = error
            unsubToken()
            unsubDone()
            unsubError()
            resolve({ rewrittenText: chapter.originalText, characterUpdates: [], error })
          })

          // Start streaming
          window.api.ai.stream({
            id: streamId,
            modelId: model.model_id,
            baseUrl: model.base_url,
            apiKey: model.api_key_encrypted,
            messages,
            temperature: model.temperature,
            maxTokens: model.max_tokens,
          }).then((result) => {
            if (!result.success) {
              unsubToken()
              unsubDone()
              unsubError()
              resolve({ rewrittenText: chapter.originalText, characterUpdates: [], error: result.error || 'AI request failed' })
            }
          }).catch((err) => {
            unsubToken()
            unsubDone()
            unsubError()
            resolve({ rewrittenText: chapter.originalText, characterUpdates: [], error: err instanceof Error ? err.message : 'Stream failed' })
          })
        })
      }

      // ── Sliding window flow (sequential non-streaming per window) ──
      onProgress?.('(正在使用滑动窗口逐段扩写...)', 0)

      const categoryPromptsMap = templateJson?.rewriteTemplate?.categoryPrompts || {}
      const windowOutputs: string[] = []

      for (let wi = 0; wi < windows.length; wi++) {
        if (signal?.aborted) {
          return { rewrittenText: chapter.originalText, characterUpdates: [], error: 'Aborted' }
        }

        const win = windows[wi]
        onProgress?.(`窗口 ${wi + 1}/${windows.length}`, Math.round((wi / windows.length) * 100))

        // Build per-window system messages
        const winSystemMsgs: Array<{ role: string; content: string }> = [
          ...systemMessages,
        ]

        if (templateJson && win.tagIds.size > 0) {
          const catLines: string[] = []
          for (const catId of win.tagIds) {
            const prompt = categoryPromptsMap[catId]
            if (prompt) {
              const catMeta = idCategories.get(catId)
              const catName = catMeta?.name || catId
              catLines.push(`## ${catName}\n${prompt}`)
            }
          }
          if (catLines.length > 0) {
            winSystemMsgs.push({ role: 'system', content: `[Category Rewrite Rules — this window only]\n${catLines.join('\n\n---\n\n')}` })
          }
        }

        // Build per-window user content
        const tagsInWindow = chapter.sceneTags
          .filter(t => win.tagIds.has(t.categoryId) && t.start >= win.start && t.end <= win.end)
          .sort((a, b) => a.start - b.start)

        let tagInfo = ''
        if (tagsInWindow.length > 0) {
          tagInfo = `[Scene Tags in this window]\n${tagsInWindow.map(t => {
            const catMeta = idCategories.get(t.categoryId)
            return `categoryId=${t.categoryId} | name=${catMeta?.name || t.name} | region: ${t.start}-${t.end}`
          }).join('\n')}\n\n`
        }

        const overlapSection = win.prevOverlap
          ? `[上文衔接]\n${win.prevOverlap}\n\n`
          : ''

        const winUserContent = `[Character States]\n${characterStatesText}\n\n[Chapter Summaries]\n${summaries5Text}${memoryText}${memoryContext}\n\n${overlapSection}${tagInfo}[Original Text for window ${wi + 1}/${windows.length}]\n${win.prevOverlap ? win.prevOverlap + '\n' : ''}${win.text}`

        const completeResult = await window.api.ai.complete({
          modelId: model.model_id,
          baseUrl: model.base_url,
          apiKey: model.api_key_encrypted,
          messages: [...winSystemMsgs, { role: 'user', content: winUserContent }],
          temperature: model.temperature,
          maxTokens: model.max_tokens,
        })

        if (!completeResult.success) {
          return {
            rewrittenText: chapter.originalText,
            characterUpdates: [],
            error: `窗口 ${wi + 1}/${windows.length} 扩写失败: ${completeResult.error}`,
          }
        }

        const rawOutput: string = completeResult.data || ''
        let parsed: string = rawOutput
        try {
          const parseResult = await window.api.ai.safeParseJson(rawOutput)
          if (parseResult.data && typeof parseResult.data === 'object') {
            const data = parseResult.data as any
            if (data.rewritten_text) {
              parsed = data.rewritten_text
            }
          }
        } catch {
          // Use raw output as-is
        }

        windowOutputs.push(parsed || win.text)

        // Update progress with stitched result so far
        const soFar = stitchWindows([...windowOutputs], windows.slice(0, wi + 1), skipZones, chapter.originalText)
        onProgress?.(soFar, Math.round(((wi + 1) / windows.length) * 100))
      }

      // Stitch all results
      const finalText = stitchWindows(windowOutputs, windows, skipZones, chapter.originalText)

      // Save and finalize
      return await finalizeRewrite(finalText, chapter, project.id)
    } catch (err) {
      return {
        rewrittenText: chapter.originalText,
        characterUpdates: [],
        error: err instanceof Error ? err.message : 'Unknown error',
      }
    }
  }, [])

  return { rewriteChapter }
}

// ── Shared finalization: parse, save, remap tags, update character states ──

async function finalizeRewrite(
  rawOutput: string,
  chapter: { id: string; chapterIndex: number; originalText: string; sceneTags: SceneTag[] },
  projectId: string,
): Promise<RewriteResult> {
  const parseResult = await window.api.ai.safeParseJson(rawOutput)

  let finalText = rawOutput
  let characterUpdates: Array<{ name: string; state_snapshot: unknown }> = []

  if (parseResult.data && typeof parseResult.data === 'object') {
    const data = parseResult.data as any
    if (data.rewritten_text) {
      finalText = data.rewritten_text
    }
    if (data.character_updates) {
      characterUpdates = data.character_updates
    }
  }

  // Persist rewritten text and status
  await window.api.db.mutation('chapters', 'update', {
    rewritten_text: finalText,
    status: 'done',
  }, 'id = ?', [chapter.id])

  // Remap original sceneTags to rewritten text positions
  const originalTags = chapter.sceneTags
  if (originalTags.length > 0) {
    try {
      const expandedTags = remapSceneTags(chapter.originalText, finalText, originalTags)
      await window.api.db.mutation('chapters', 'update', {
        expanded_scene_tags: JSON.stringify(expandedTags),
      }, 'id = ?', [chapter.id])
    } catch { /* non-critical */ }
  }

  // Update character states
  if (characterUpdates.length > 0) {
    await window.api.context.updateStates(projectId, characterUpdates.map((u: any) => ({
      name: u.name,
      state_snapshot: u.state_snapshot,
      chapterIndex: chapter.chapterIndex,
    })))
  }

  // Persist memory metadata (foreshadowing, items, power levels)
  if (parseResult.data && typeof parseResult.data === 'object') {
    const data = parseResult.data as any
    if (data.foreshadowing || data.items || data.power_updates) {
      try {
        await window.api.context.saveMeta({
          projectId,
          chapterIndex: chapter.chapterIndex,
          meta: {
            foreshadowing: data.foreshadowing || [],
            items: data.items || [],
            powerUpdates: data.power_updates || [],
          },
        })
      } catch { /* non-critical */ }
    }
  }

  return { rewrittenText: finalText, characterUpdates }
}
