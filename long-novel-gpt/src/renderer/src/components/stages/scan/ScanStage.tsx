import { useState, useEffect, useRef, useCallback } from 'react'
import { useProjectStore, type SceneTag } from '../../../stores/useProjectStore'
import { useScanAnalysis } from '../../../hooks/useScanAnalysis'
import { packVector, hashText } from '../../../lib/embedding'

interface Category {
  id: string; name: string; conditions: string
  synonyms?: string[]; examples?: Array<{ text: string; label: string }>
}

// ── Stop words excluded from auto keyword extraction ──
const STOP_PHRASES = new Set([
  '她说', '他说', '只见', '此刻', '顿时', '忽然', '突然', '原来', '然后',
  '不过', '但是', '因为', '所以', '如果', '虽然', '已经', '还是', '只是',
  '站起身来', '走了过去', '转过身', '回过头', '看过去', '说道', '问道',
  '一个', '这个', '那个', '什么', '怎么', '这么', '那么', '一下', '一点',
  '之前', '之后', '一边', '一起', '一阵', '一声', '一眼', '一手', '一',
])

// Characters that signal narrative boilerplate rather than scene content.
// Phrases dominated by these are dialogue filler, not useful keywords.
const FUNCTION_CHARS = new Set([
  '说', '道', '问', '答', '叫', '喊', '讲', '谈', '话', '语', '言',
  '还', '就', '又', '也', '都', '才', '便', '却', '只', '刚', '已',
  '着', '了', '过', '的', '地', '得',
  '没', '不', '别', '勿', '未',
  '这', '那', '哪', '什', '怎', '么', '何',
  '来', '去', '上', '下', '进', '出', '回', '到', '起', '开',
  '能', '会', '可', '要', '想', '敢', '肯', '愿',
  '很', '太', '更', '最', '非', '极', '挺', '蛮',
  '把', '被', '让', '给', '对', '向', '从', '在', '和', '与', '或',
  '但', '虽', '因', '所', '以', '而', '且', '并', '则',
  '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '嘛', '罢', '呗',
  '我', '你', '他', '她', '它', '们', '自', '己',
  '是', '有', '为', '如', '像', '似', '若',
  '走', '跑', '跳', '坐', '站', '躺', '看', '听', '闻', '感', '觉', '知',
  '再', '仍', '尚', '亦', '犹',
])

const MAX_FUNCTION_RATIO = 0.4

function extractCandidateKeywords(
  text: string,
  existingKeywords: string[],
  characterNames: string[],
  topK: number = 8,
): string[] {
  const freq = new Map<string, number>()
  const existing = new Set(existingKeywords.map(k => k.toLowerCase()))
  const names = new Set(characterNames.map(n => n.toLowerCase()))
  // Slide a window of 2-8 characters through the text
  for (let len = 3; len <= 8; len++) {
    for (let i = 0; i <= text.length - len; i++) {
      const phrase = text.slice(i, i + len)
      // Skip if contains line breaks, punctuation, or is pure digits/ascii
      if (/[\n\r。！？，、；：""''（）【】\u3000]/.test(phrase)) continue
      if (/^\p{ASCII}+$/u.test(phrase)) continue
      const lower = phrase.toLowerCase()
      if (existing.has(lower)) continue
      if (names.has(lower)) continue
      if (STOP_PHRASES.has(phrase)) continue
      // Skip phrases dominated by function/grammar characters (dialogue filler)
      let funcCount = 0
      for (const ch of phrase) { if (FUNCTION_CHARS.has(ch)) funcCount++ }
      if (funcCount / phrase.length >= MAX_FUNCTION_RATIO) continue
      freq.set(phrase, (freq.get(phrase) || 0) + 1)
    }
  }
  // Sort by frequency, then by length (shorter preferred for same freq)
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, topK)
    .map(e => e[0])
  return sorted
}
const SHOW_TEXT = 4 // NodeFilter.SHOW_TEXT is not a runtime value in TS

function getTextOffset(container: HTMLElement, targetNode: Node, targetOffset: number): number {
  let offset = 0
  const walker = document.createTreeWalker(container, SHOW_TEXT)
  let node: Text | null = walker.nextNode() as Text | null
  while (node) {
    if (node === targetNode) return offset + targetOffset
    offset += (node.textContent || '').length
    node = walker.nextNode() as Text | null
  }
  return offset
}

export default function ScanStage() {
  const { chapters, currentChapterIndex, currentProject, updateChapterSceneTags, loadSceneData, setActiveChapterIds, templateVersion } = useProjectStore()
  const currentChapter = chapters[currentChapterIndex]
  const { analyze, analyzing, status, metrics } = useScanAnalysis()

  const [models, setModels] = useState<any[]>([])
  const [selModelId, setSelModelId] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [goldLabelMap, setGoldLabelMap] = useState<Map<string, 'positive' | 'negative'>>(new Map())
  const abortRef = useRef<AbortController | null>(null)

  // Selection state for manual addition
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(null)
  const [selCategoryId, setSelCategoryId] = useState('')
  const textContainerRef = useRef<HTMLDivElement>(null)

  // Editing state for range adjustment
  const [editingTag, setEditingTag] = useState<SceneTag | null>(null)
  const [editStart, setEditStart] = useState(0)
  const [editEnd, setEditEnd] = useState(0)
  const [editCategoryId, setEditCategoryId] = useState('')
  // Suppress the click that fires immediately after a drag-select inside edit mode
  const justDraggedRef = useRef(false)
  // Keywords: manual marking + AI expansion
  const [manualKeywords, setManualKeywords] = useState('')
  const [customCategoryName, setCustomCategoryName] = useState('')
  const [markedSeeds, setMarkedSeeds] = useState<string[]>([])
  const [aiExpandedKeywords, setAiExpandedKeywords] = useState<string[]>([])
  const [aiCheckedKeywords, setAiCheckedKeywords] = useState<Set<string>>(new Set())
  const [expandingAI, setExpandingAI] = useState(false)

  // ── Load models (one-shot, cleanup prevents Strict Mode double-fire) ──
  useEffect(() => {
    let cancelled = false
    window.api.db.query('models').then(r => {
      if (cancelled || !r.success || !r.data) return
      const m = r.data as any[]
      setModels(m)
      if (!selModelId) {
        const nonEmbed = m.filter((x: any) => !/embed|nomic/i.test(x.model_id || '') && !/embed|nomic/i.test(x.name || ''))
        setSelModelId(nonEmbed[0]?.id || '')
      }
    })
    return () => { cancelled = true }
  }, [])

  // ── Load categories from template ──
  useEffect(() => {
    if (!currentProject?.templateId) return
    let cancelled = false
    window.api.db.query('templates', 'id = ?', [currentProject.templateId]).then(r => {
      if (cancelled || !r.success || !r.data?.length) return
      try {
        const raw = JSON.parse((r.data[0] as any).template_json)
        // Handle nested JSON strings (legacy templates)
        const identifyTemplate = typeof raw.identifyTemplate === 'string' ? JSON.parse(raw.identifyTemplate) : raw.identifyTemplate
        const rewriteTemplate = typeof raw.rewriteTemplate === 'string' ? JSON.parse(raw.rewriteTemplate) : raw.rewriteTemplate
        if (!cancelled) {
          if (identifyTemplate?.categories) setCategories(identifyTemplate.categories)
          if (rewriteTemplate?.categoryPrompts) categoryPromptsRef.current = rewriteTemplate.categoryPrompts
        }
      } catch { /* */ }
    })
    return () => { cancelled = true }
  }, [currentProject?.templateId, templateVersion])

  // ── Load scene data for current chapter ──
  useEffect(() => {
    if (currentChapter) loadSceneData(currentChapter.id)
  }, [currentChapter?.id])

  // ── Load gold labels ──
  useEffect(() => {
    if (!currentChapter || !currentProject) return
    let cancelled = false
    window.api.db.query('gold_labels', 'chapter_id = ?', [currentChapter.id]).then(r => {
      if (cancelled || !r.success || !r.data) return
      const map = new Map<string, 'positive' | 'negative'>()
      for (const gl of r.data as any[]) {
        const key = gl.end_pos > gl.start_pos
          ? `${gl.category_id}:${gl.start_pos}`
          : `${gl.category_id}:${(gl.snippet_text ?? '').slice(0, 20)}`
        map.set(key, gl.label)
      }
      if (!cancelled) setGoldLabelMap(map)
    })
    return () => { cancelled = true }
  }, [currentChapter?.id])

  // ── Text selection handler ──
  // When editingTag is set, selection replaces the tag's range directly.
  // Otherwise, selection opens the "add manual tag" toolbar.
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim() || !textContainerRef.current) {
      // Collapsed selection in edit mode: keep editing (user may re-click to deselect)
      return
    }
    try {
      const range = sel.getRangeAt(0)
      const start = getTextOffset(textContainerRef.current, range.startContainer, range.startOffset)
      const end = getTextOffset(textContainerRef.current, range.endContainer, range.endOffset)
      if (start >= end || end - start < 2) return

      if (editingTag) {
        // Replace editing tag's range with the dragged selection
        setEditStart(start)
        setEditEnd(end)
        justDraggedRef.current = true
        // Clear visual selection so the highlight isn't sticky
        sel.removeAllRanges()
      } else {
        setSelection({ start, end, text: sel.toString() })
        setSelCategoryId(categories[0]?.id || '')
      }
    } catch {
      if (!editingTag) setSelection(null)
    }
  }, [categories, editingTag])

  // ── Load categoryPrompts from template (cached once) ──
  const categoryPromptsRef = useRef<Record<string, string>>({})
  const loadCategoryPrompts = useCallback((): Record<string, string> => {
    return categoryPromptsRef.current
  }, [])

  // Track latest metrics via ref (avoid stale closure after await)
  const metricsRef = useRef(metrics)
  metricsRef.current = metrics

  // ── AI analyze ──
  const handleAnalyze = async () => {
    if (analyzing) return
    if (!currentChapter) { alert('请先选择章节'); return }
    if (!currentChapter.originalText) { alert('章节文本未加载，请稍候'); return }
    if (!selModelId) { alert('请先选择AI模型'); return }
    if (categories.length === 0) { alert('未加载场景类别，请检查模板配置'); return }
    const controller = new AbortController()
    abortRef.current = controller

    const mr = await window.api.db.query('models', 'id = ?', [selModelId])
    if (!mr.success || !mr.data?.length) return
    const model = mr.data[0] as any

    const manualTags = currentChapter.sceneTags.filter(t => t.source === 'manual')

    // Synonym expansion (non-blocking — failures don't stop analysis)
    const needsSynonyms = categories.filter(c => !c.synonyms?.length)
    if (needsSynonyms.length > 0 && currentProject?.templateId) {
      try {
        const synSchema = { type: 'object', properties: { synonyms: { type: 'array', items: { type: 'string' } } }, required: ['synonyms'] }
        const updates: Record<string, string[]> = {}
        for (let i = 0; i < needsSynonyms.length; i += 3) {
          if (controller.signal.aborted) break
          const batch = needsSynonyms.slice(i, i + 3)
          const batchResults = await Promise.allSettled(batch.map(async cat => {
            const r = await window.api.ai.classify({
              baseUrl: model.base_url, modelId: model.model_id, apiKey: model.api_key_encrypted,
              messages: [
                { role: 'system', content: '为给定场景生成中文同义词、隐喻、委婉表达。输出 JSON：{"synonyms": ["...", ...]}，10-20 个词。' },
                { role: 'user', content: `场景名称：${cat.name}\n场景描述：${cat.conditions}` },
              ],
              jsonSchema: synSchema, schemaName: 'synonyms', maxTokens: 500,
            })
            if (r.success && r.data) {
              const arr = (r.data as any).synonyms
              if (Array.isArray(arr)) updates[cat.id] = arr.filter((x: unknown) => typeof x === 'string' && x.length >= 2 && x.length <= 12).slice(0, 20)
            }
          }))
        }
        if (Object.keys(updates).length > 0) {
          const tr = await window.api.db.query('templates', 'id = ?', [currentProject.templateId])
          if (tr.success && tr.data?.length) {
            const raw2 = JSON.parse((tr.data[0] as any).template_json)
            const identifyTemplate2 = typeof raw2.identifyTemplate === 'string' ? JSON.parse(raw2.identifyTemplate) : raw2.identifyTemplate
            if (Array.isArray(identifyTemplate2?.categories)) {
              for (const c of identifyTemplate2.categories) if (updates[c.id]) c.synonyms = updates[c.id]
              raw2.identifyTemplate = identifyTemplate2
              await window.api.db.mutation('templates', 'update', { template_json: JSON.stringify(raw2) }, 'id = ?', [currentProject.templateId])
              setCategories([...identifyTemplate2.categories])
              for (const c of categories) if (updates[c.id]) c.synonyms = updates[c.id]
            }
          }
        }
      } catch { /* non-blocking: proceed to analysis even if synonym generation fails */ }
    }
    if (controller.signal.aborted) return

    const embedModel = models.find((m: any) => /embed|nomic/i.test(m.model_id || '') || /embed|nomic/i.test(m.name || ''))

    try {
      setActiveChapterIds(prev => [...prev, currentChapter.id])
      const merged = await analyze(
        currentChapter.originalText,
        currentChapter.id,
        categories,
        { baseUrl: model.base_url, modelId: model.model_id, apiKey: model.api_key_encrypted },
        manualTags,
        {
          signal: controller.signal,
          enableEmbeddingRecall: !!embedModel,
          embeddingModel: embedModel ? { baseUrl: embedModel.base_url, modelId: embedModel.model_id, apiKey: embedModel.api_key_encrypted } : undefined,
          projectId: currentProject?.id,
          categoryPrompts: loadCategoryPrompts(),
        }
      )
      updateChapterSceneTags(currentChapter.id, merged, metricsRef.current || undefined)
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      alert('AI 分析失败：' + (err?.message || '未知错误'))
    } finally {
      setActiveChapterIds(prev => prev.filter(id => id !== currentChapter.id))
    }
  }

  // ── Manual scene addition ──
  const handleAddManual = async () => {
    if (!currentChapter || !selection || !selCategoryId) return
    const cat = categories.find(c => c.id === selCategoryId)
    if (!cat) return
    const newTag: SceneTag = {
      categoryId: selCategoryId, name: cat.name,
      start: selection.start, end: selection.end,
      source: 'manual',
    }
    const merged = [...currentChapter.sceneTags.filter(t => t.source === 'manual'), newTag]
    updateChapterSceneTags(currentChapter.id, merged)
    setSelection(null)
    // Persist
    await window.api.db.mutation('chapters', 'update', { scene_tags: JSON.stringify(merged) }, 'id = ?', [currentChapter.id])
    // Add as few-shot positive example
    await persistExample(cat.id, 'positive', selection.text)
  }

  // ── Range adjustment: save edit ──
  const handleSaveEdit = async () => {
    if (!currentChapter || !editingTag) return
    const cat = categories.find(c => c.id === editCategoryId)
    const updated: SceneTag = {
      ...editingTag,
      categoryId: editCategoryId,
      name: cat?.name || editingTag.name,
      start: editStart,
      end: editEnd,
      source: editingTag.source === 'ai' ? 'corrected' as const : editingTag.source,
    }
    const others = currentChapter.sceneTags.filter(t => t !== editingTag)
    const merged = [...others, updated].sort((a, b) => a.start - b.start)
    updateChapterSceneTags(currentChapter.id, merged)
    setEditingTag(null)
    await window.api.db.mutation('chapters', 'update', { scene_tags: JSON.stringify(merged) }, 'id = ?', [currentChapter.id])
    // If AI was corrected, add as few-shot positive
    if (editingTag.source === 'ai') {
      await persistExample(editCategoryId, 'positive', currentChapter.originalText.slice(editStart, editEnd))
    }
    // Record user correction as gold label for RAG knowledge base
    // Positive: the corrected span at the selected category
    if (goldLabelMap.get(`${editCategoryId}:${editStart}`) !== 'positive') {
      await saveGoldLabelDirect(editCategoryId, editStart, editEnd, 'positive')
    }
    // Negative: mark old range as inaccurate (range change, category change, or both)
    const rangeChanged = editingTag.start !== editStart || editingTag.end !== editEnd
    const categoryChanged = editingTag.categoryId !== editCategoryId
    if (categoryChanged) {
      // Old category at old position is wrong
      const oldKey = `${editingTag.categoryId}:${editingTag.start}`
      if (goldLabelMap.get(oldKey) !== 'negative') {
        await saveGoldLabelDirect(editingTag.categoryId, editingTag.start, editingTag.end, 'negative')
      }
    } else if (rangeChanged) {
      // Same category but range was adjusted — old range was inaccurate
      const oldKey = `${editCategoryId}:${editingTag.start}`
      if (goldLabelMap.get(oldKey) !== 'negative') {
        await saveGoldLabelDirect(editCategoryId, editingTag.start, editingTag.end, 'negative')
      }
    }
    // Persist selected keyword candidates to template
    await saveKeywordCandidates()
  }

  // ── AI keyword expansion from marked seeds ──
  const handleAIExpand = async () => {
    if (markedSeeds.length === 0) return
    setExpandingAI(true)
    try {
      const model = models.find((m: any) => !/embed|nomic/i.test(m.model_id || ''))
      if (!model) return
      const r = await window.api.ai.complete({
        baseUrl: model.base_url,
        modelId: model.model_id,
        apiKey: model.api_key_encrypted,
        messages: [
          { role: 'system', content: '\u4F60\u662F\u5173\u952E\u8BCD\u63D0\u53D6\u52A9\u624B\u3002\u6839\u636E\u79CD\u5B50\u8BCD\u751F\u621010-15\u4E2A\u8BED\u4E49\u76F8\u5173\u7684\u6269\u5C55\u5173\u952E\u8BCD\uFF082-8\u5B57\uFF09\u3002\u4FDD\u7559\u79CD\u5B50\u8BCD\u3002\u7981\u6B62\u89E3\u91CA\uFF0C\u6BCF\u884C\u4E00\u4E2A\u8BCD\u3002' },
          { role: 'user', content: `\u79CD\u5B50\u8BCD\uFF1A${markedSeeds.join('\u3001')}\n\n\u7AE0\u8282\u8BED\u5883\uFF1A${currentChapter?.originalText.slice(editStart, editEnd).slice(0, 300)}` },
        ],
        maxTokens: 300,
      })
      if (r.success && r.data) {
        const text = typeof r.data === 'string' ? r.data : (r.data as any).content || (r.data as any).text || ''
        const keywords = text.split(/[\n,\uFF0C\u3001]+/).map((s: string) => s.replace(/^\d+[.\u3001]?\s*/, '').trim()).filter((s: string) => s.length >= 2 && s.length <= 12)
        const merged = [...new Set([...markedSeeds, ...keywords])].slice(0, 20)
        setAiExpandedKeywords(merged)
        setAiCheckedKeywords(new Set(merged))
      }
    } catch { /* non-critical */ }
    finally { setExpandingAI(false) }
  }

  // ── Persist selected keyword candidates to template ──
  const saveKeywordCandidates = async () => {
    // Gather from: marked seeds + AI-checked + auto-candidates + manually typed
    const manualList = manualKeywords
      .split(/[,，、\s]+/)
      .map(s => s.trim())
      .filter(s => s.length >= 2 && s.length <= 16)
    const allNew = new Set([...markedSeeds, ...aiCheckedKeywords, ...manualList])
    if (allNew.size === 0) return
    if (!currentProject?.templateId || !editCategoryId) return
    try {
      const r = await window.api.db.query('templates', 'id = ?', [currentProject.templateId])
      if (!r.success || !r.data?.length) return
      const row = (r.data as any[])[0]
      let tpl: any
      try { tpl = JSON.parse(row.template_json) } catch { return }
      const identifyTemplate3 = typeof tpl?.identifyTemplate === 'string' ? JSON.parse(tpl.identifyTemplate) : tpl?.identifyTemplate
      const cats: Category[] = identifyTemplate3?.categories
      if (!Array.isArray(cats)) return
      const cat = cats.find((c: Category) => c.id === editCategoryId)
      if (!cat) return
      const synonyms = [...new Set(Array.isArray(cat.synonyms) ? cat.synonyms : [])]
      let changed = false
      for (const kw of allNew) {
        if (!synonyms.includes(kw)) { synonyms.push(kw); changed = true }
      }
      if (!changed) return
      cat.synonyms = synonyms.slice(0, 30)
      await window.api.db.mutation('templates', 'update', { template_json: JSON.stringify(tpl) }, 'id = ?', [currentProject.templateId])
      setCategories([...cats])
      setManualKeywords('')
      setMarkedSeeds([])
      setAiExpandedKeywords([])
      setAiCheckedKeywords(new Set())
      setMarkedSeeds([])
      setAiExpandedKeywords([])
      setAiCheckedKeywords(new Set())
    } catch { /* non-critical */ }
  }

  // ── Reset manual marking when editing range changes ──
  useEffect(() => {
    if (!currentChapter || !editingTag || editStart >= editEnd) {
      setMarkedSeeds([])
      setAiExpandedKeywords([])
      setAiCheckedKeywords(new Set())
      return
    }
    setMarkedSeeds([])
    setAiExpandedKeywords([])
    setAiCheckedKeywords(new Set())
  }, [editStart, editEnd, editingTag])

  // ── Cleanup on unmount: abort analysis + reset state to avoid cross-page pollution ──
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      setActiveChapterIds([])
      setEditingTag(null)
      setSelection(null)
      setMarkedSeeds([])
      setAiExpandedKeywords([])
      setAiCheckedKeywords(new Set())
    }
  }, [])

  // ── Tokenize text into clickable words split by Chinese punctuation and spaces ──
  function tokenizeText(text: string): string[] {
    const tokens: string[] = []
    const cleaned = text.replace(/[\n\r]/g, '')
    if (!cleaned) return tokens
    // Split by Chinese punctuation and whitespace, keeping delimiters as separate tokens
    const parts = cleaned.split(/([。！？，、；：\s]+)/)
    for (const part of parts) {
      if (!part) continue
      // Always skip whitespace runs
      if (/^\s+$/.test(part)) continue
      // Skip pure punctuation tokens (only include if >= 1 visible char)
      tokens.push(part)
    }
    return tokens
  }

  function extractKeywordsFromConditions(conditions: string): string[] {
    const kws: string[] = []
    const quoted = conditions.match(/「(.+?)」/g)
    if (quoted) for (const q of quoted) kws.push(q.replace(/[「」]/g, ''))
    return kws
  }

  // ── Delete tag + record as few-shot negative + gold label ──
  const handleDeleteTag = async (tag: SceneTag) => {
    if (!currentChapter) return
    const merged = currentChapter.sceneTags.filter(t => t !== tag)
    updateChapterSceneTags(currentChapter.id, merged)
    const dbUpdate: Record<string, string | null> = { scene_tags: JSON.stringify(merged) }
    if (merged.length === 0) dbUpdate.scan_metrics = null
    await window.api.db.mutation('chapters', 'update', dbUpdate, 'id = ?', [currentChapter.id])
    // Record as few-shot negative (template learning)
    const snippet = currentChapter.originalText.slice(tag.start, tag.end)
    await persistExample(tag.categoryId, 'negative', snippet)
    // Record as gold label (RAG knowledge base) — embeds snippet for future retrieval
    await saveGoldLabel(tag, 'negative')
  }

  // ── Persist few-shot example to template ──
  const persistExample = async (categoryId: string, label: 'positive' | 'negative', text: string) => {
    if (!currentProject?.templateId || !text || text.trim().length < 8) return
    try {
      const r = await window.api.db.query('templates', 'id = ?', [currentProject.templateId])
      if (!r.success || !r.data?.length) return
      const row = (r.data as any[])[0]
      let tpl: any
      try { tpl = JSON.parse(row.template_json) } catch { return }
      const identifyTemplate4 = typeof tpl?.identifyTemplate === 'string' ? JSON.parse(tpl.identifyTemplate) : tpl?.identifyTemplate
      const cats: Category[] = identifyTemplate4?.categories
      if (!Array.isArray(cats)) return
      const cat = cats.find((c: Category) => c.id === categoryId)
      if (!cat) return
      const examples = Array.isArray(cat.examples) ? cat.examples : []
      if (examples.some(e => e.label === label && e.text === text.trim().slice(0, 200))) return
      examples.unshift({ text: text.trim().slice(0, 200), label })
      cat.examples = examples.slice(0, 20)
      tpl.identifyTemplate = identifyTemplate4
      await window.api.db.mutation('templates', 'update', { template_json: JSON.stringify(tpl) }, 'id = ?', [currentProject.templateId])
      setCategories([...cats])
    } catch { /* non-critical */ }
  }

  // ── Gold label helpers ──

  /** Direct gold-label insert using position/categoryId — no SceneTag object required. */
  const saveGoldLabelDirect = async (
    categoryId: string, startPos: number, endPos: number, label: 'positive' | 'negative'
  ) => {
    if (!currentChapter || !currentProject) return
    const key = `${categoryId}:${startPos}`
    // Dedup: don't re-insert the same label
    if (goldLabelMap.get(key) === label) return

    const snippet = currentChapter.originalText.slice(startPos, endPos)
    const goldLabelId = `gold:${currentChapter.id}:${categoryId}:${startPos}`
    await window.api.db.mutation('gold_labels', 'insert', {
      id: goldLabelId,
      project_id: currentProject.id, chapter_id: currentChapter.id,
      category_id: categoryId, snippet_text: snippet, label,
      start_pos: startPos, end_pos: endPos,
    })
    setGoldLabelMap(prev => new Map(prev).set(key, label))

    // Fire-and-forget: generate embedding for the gold label snippet
    void (async () => {
      const embedModel = models.find((m: any) => /embed|nomic/i.test(m.model_id || '') || /embed|nomic/i.test(m.name || ''))
      if (!embedModel) return
      try {
        const embRes = await window.api.ai.embed({
          baseUrl: embedModel.base_url,
          model: embedModel.model_id,
          prompt: snippet,
          apiKey: embedModel.api_key_encrypted,
        })
        if (!embRes.success || !embRes.data) return
        const vector = Array.isArray(embRes.data) ? embRes.data : (embRes.data as any).embedding
        if (!vector || !Array.isArray(vector)) return
        await window.api.db.mutation('embeddings', 'insert', {
          id: goldLabelId,
          type: 'gold_snippet',
          ref_id: goldLabelId,
          project_id: currentProject.id,
          model_id: embedModel.model_id,
          vector: packVector(vector),
          text_hash: hashText(snippet),
        })
      } catch { /* fire-and-forget: silently ignore errors */ }
    })()
  }

  const saveGoldLabel = async (tag: SceneTag, label: 'positive' | 'negative') => {
    await saveGoldLabelDirect(tag.categoryId, tag.start, tag.end, label)
  }

  const hasGold = (tag: SceneTag): 'positive' | 'negative' | null => {
    return goldLabelMap.get(`${tag.categoryId}:${tag.start}`) || null
  }

  // ── Tags sorted for display ──
  const tags = currentChapter ? [...currentChapter.sceneTags].sort((a, b) => a.start - b.start) : []

  // ── Render ──
  return (
    <div className="flex-1 flex flex-col p-4">
      {/* Toolbar */}
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <select value={selModelId} onChange={e => setSelModelId(e.target.value)} disabled={analyzing}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm">
          {models.filter((m: any) => !/embed|nomic/i.test(m.model_id || '')).map((m: any) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <button onClick={handleAnalyze} disabled={analyzing || !currentChapter?.originalText}
          className={`px-4 py-1.5 rounded-lg text-white text-sm font-medium ${analyzing ? 'bg-gray-400' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
          {analyzing ? `${status || '\u5206\u6790\u4E2D...'}` : currentChapter?.originalText ? 'AI \u5206\u6790' : '\u52A0\u8F7D\u6587\u672C\u4E2D...'}
        </button>
        {analyzing && (
          <button onClick={() => abortRef.current?.abort()} className="px-4 py-1.5 rounded-lg text-sm text-red-600 hover:bg-red-50 border border-red-200">
            {'\u4E2D\u6B62'}
          </button>
        )}
        {metrics && (
          <>
            <span className="text-xs text-gray-500">
              {metrics.chunks}\u5757 | \u53EC\u56DE{metrics.recallCount} | \u7F6E\u4FE1\u5EA6{(metrics.avgConfidence * 100).toFixed(0)}% | {(metrics.durationMs / 1000).toFixed(1)}s
            </span>
            {metrics.debugLog && metrics.debugLog.length > 0 && (
              <span
                className="text-xs text-indigo-600 cursor-pointer hover:underline ml-1"
                onClick={() => {
                  const div = document.getElementById('scan-debug-panel')
                  if (div) div.style.display = div.style.display === 'none' ? 'block' : 'none'
                }}
              >{'[\u8BCA\u65AD]'}</span>
            )}
          </>
        )}
        <span className="text-xs text-gray-400 ml-auto">
          AI: <span className="inline-block w-3 h-3 bg-indigo-200 rounded-sm align-middle" /> |
          {'\u624B\u52A8'}: <span className="inline-block w-3 h-3 bg-green-200 rounded-sm align-middle" /> |
          {'\u5DF2\u4FEE\u6B63'}: <span className="inline-block w-3 h-3 bg-amber-200 rounded-sm align-middle" />
        </span>
      </div>

      {/* Debug panel: AI recognition diagnostics */}
      {metrics?.debugLog && metrics.debugLog.length > 0 && (
        <div id="scan-debug-panel" style={{ display: 'none' }} className="mb-2 bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-auto max-h-64 leading-relaxed">
          {metrics.debugLog.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {/* Text view */}
      <div className="flex-1 overflow-auto bg-white rounded-lg border border-gray-200 relative">
        {currentChapter?.originalText ? (
          <div ref={textContainerRef}
            className="p-4 text-sm leading-relaxed whitespace-pre-wrap text-gray-800"
            onMouseUp={handleMouseUp}
          >
            {/* Render text with tagged spans */}
            {(() => {
              const pieces: Array<{ text: string; tag?: SceneTag; gold?: 'positive' | 'negative' | null }> = []
              let pos = 0
              for (const t of tags) {
                if (t.start > pos) pieces.push({ text: currentChapter.originalText.slice(pos, t.start) })
                pieces.push({ text: currentChapter.originalText.slice(t.start, t.end), tag: t, gold: hasGold(t) })
                pos = t.end
              }
              if (pos < currentChapter.originalText.length) pieces.push({ text: currentChapter.originalText.slice(pos) })

              return pieces.map((p, i) => {
                if (!p.tag) return <span key={i}>{p.text}</span>
                const t = p.tag
                const g = p.gold
                const isEditing = editingTag?.categoryId === t.categoryId && editingTag?.start === t.start
                // Color by source
                const bg = t.source === 'manual' ? 'rgba(34,197,94,0.18)' :
                           t.source === 'corrected' ? 'rgba(245,158,11,0.18)' :
                           'rgba(99,102,241,0.15)'
                const border = t.source === 'manual' ? '#22c55e' :
                               t.source === 'corrected' ? '#f59e0b' : '#6366f1'

                return (
                  <span key={i} className="relative group cursor-pointer"
                    style={{
                      backgroundColor: bg,
                      borderBottom: `2px solid ${border}`,
                      borderRadius: '2px',
                      outline: isEditing ? `2px solid ${border}` : undefined,
                      outlineOffset: '1px',
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (isEditing) setEditingTag(null)
                      handleDeleteTag(t)
                    }}
                    onClick={(e) => {
                      // Suppress the click that immediately follows a drag-select
                      if (justDraggedRef.current) {
                        justDraggedRef.current = false
                        return
                      }
                      if (isEditing) {
                        // If user did a drag-select, don't toggle off
                        const sel = window.getSelection()
                        if (sel && !sel.isCollapsed) return
                        setEditingTag(null)
                      } else {
                        // Switch directly into edit mode for the clicked tag,
                        // even if another tag is currently being edited.
                        setEditingTag(t)
                        setEditStart(t.start)
                        setEditEnd(t.end)
                        setEditCategoryId(t.categoryId)
                      }
                    }}
                    title={`${t.name} (${t.source === 'ai' ? `AI ${((t.confidence ?? 0) * 100).toFixed(0)}%` : t.source === 'corrected' ? `\u5DF2\u4FEE\u6B63 AI ${((t.confidence ?? 0) * 100).toFixed(0)}%` : '\u624B\u52A8'})${g ? ` [\u91D1\u6807:${g}]` : ''}`}
                  >
                    {p.text}
                    {/* Gold indicators */}
                    {g === 'positive' && <span className="absolute -top-1 -right-1 text-[10px] bg-green-500 text-white rounded-full w-4 h-4 flex items-center justify-center">{'\u2713'}</span>}
                    {g === 'negative' && <span className="absolute -top-1 -right-1 text-[10px] bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center">{'\u2717'}</span>}
                    {/* Gold label buttons (hover) */}
                    {!g && (
                      <span className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 flex gap-0.5">
                        <button onClick={(e) => { e.stopPropagation(); saveGoldLabel(t, 'positive') }}
                          className="text-[10px] bg-green-500 text-white rounded-full w-4 h-4 flex items-center justify-center hover:bg-green-600">{'\u2713'}</button>
                        <button onClick={(e) => { e.stopPropagation(); saveGoldLabel(t, 'negative') }}
                          className="text-[10px] bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center hover:bg-red-600">{'\u2717'}</button>
                      </span>
                    )}
                    {/* Delete button (hover) */}
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteTag(t) }}
                      className="absolute -top-1 -left-1 opacity-0 group-hover:opacity-100 text-[10px] bg-gray-500 text-white rounded-full w-4 h-4 flex items-center justify-center hover:bg-red-600">
                      {'\u2715'}
                    </button>
                    {/* Source badge */}
                    {t.source !== 'ai' && (
                      <span className="absolute -bottom-1 -left-1 text-[9px] bg-white border rounded px-0.5 leading-none opacity-80">
                        {t.source === 'manual' ? 'M' : 'C'}
                      </span>
                    )}
                  </span>
                )
              })
            })()}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {'\u70B9\u51FB\u7AE0\u8282\u5217\u8868\u52A0\u8F7D\u6587\u672C...'}
          </div>
        )}
      </div>

      {/* Floating toolbar: manual scene addition */}
      {selection && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-2xl border border-gray-200 p-3 z-50 flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {'\u9009\u4E2D'} {selection.end - selection.start} {'\u5B57'}
          </span>
          <select value={selCategoryId} onChange={e => setSelCategoryId(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm max-w-[120px] truncate">
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input
            type="text"
            value={customCategoryName}
            onChange={e => setCustomCategoryName(e.target.value)}
            placeholder={'\u81EA\u5B9A\u4E49...'}
            className="w-20 px-2 py-1.5 border border-gray-300 rounded text-xs"
          />
          <button onClick={() => {
            const name = customCategoryName.trim()
            if (!name) return
            const id = 'custom_' + Date.now()
            const newCat: Category = { id, name, conditions: '' }
            setCategories(prev => [...prev, newCat])
            setSelCategoryId(id)
            setCustomCategoryName('')
          }}
            className="px-2 py-1.5 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200 whitespace-nowrap">
            {'\u6DFB\u52A0'}
          </button>
          <button onClick={handleAddManual}
            className="px-4 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium">
            {'\u786E\u8BA4\u6DFB\u52A0'}
          </button>
          <button onClick={() => setSelection(null)}
            className="px-3 py-1.5 text-gray-500 hover:text-gray-700 text-sm">
            {'\u53D6\u6D88'}
          </button>
        </div>
      )}

      {/* Edit popup: range adjustment */}
      {editingTag && (
        <div className="fixed bottom-20 right-8 bg-white rounded-xl shadow-2xl border border-gray-200 p-4 z-50 w-72">
          <h3 className="font-semibold text-gray-900 text-sm mb-1">{'\u7F16\u8F91\u573A\u666F'}</h3>
          <p className="text-[11px] text-gray-500 mb-3 leading-snug">
            {'\u63D0\u793A\uFF1A\u5728\u5DE6\u4FA7\u6B63\u6587\u4E2D\u62D6\u9009\u4E00\u6BB5\u6587\u5B57\u53EF\u66FF\u6362\u5F53\u524D\u8303\u56F4\uFF1B\u4E0B\u62C9\u5217\u8868\u53EF\u66F4\u6539\u573A\u666F\u7C7B\u522B\u3002'}
          </p>
          <div className="space-y-3 text-sm">
            <div>
              <label className="text-xs text-gray-500">{'\u7C7B\u522B'}</label>
              <select value={editCategoryId} onChange={e => setEditCategoryId(e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg mt-1">
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div className="flex gap-1 mt-1">
                <input
                  type="text"
                  value={customCategoryName}
                  onChange={e => setCustomCategoryName(e.target.value)}
                  placeholder={'\u6216\u8F93\u5165\u81EA\u5B9A\u4E49\u7C7B\u522B\u540D\u79F0...'}
                  className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs"
                />
                {customCategoryName.trim() && (
                  <button onClick={() => {
                    const id = 'custom_' + Date.now()
                    const newCat: Category = { id, name: customCategoryName.trim(), conditions: '' }
                    setCategories(prev => [...prev, newCat])
                    setEditCategoryId(id)
                    setCustomCategoryName('')
                  }}
                    className="px-2 py-1 bg-green-500 text-white rounded text-xs hover:bg-green-600 whitespace-nowrap"
                  >{'\u6DFB\u52A0'}</button>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-gray-500">{'\u8D77\u59CB'}</label>
                <input type="number" value={editStart} onChange={e => setEditStart(Number(e.target.value))}
                  className="w-full px-2 py-1 border border-gray-300 rounded-lg mt-1 text-sm" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-gray-500">{'\u7ED3\u675F'}</label>
                <input type="number" value={editEnd} onChange={e => setEditEnd(Number(e.target.value))}
                  className="w-full px-2 py-1 border border-gray-300 rounded-lg mt-1 text-sm" />
              </div>
            </div>
            {currentChapter && (() => {
              const previewText = currentChapter.originalText.slice(editStart, editEnd)
              const tokens = tokenizeText(previewText)
              return (
                <div className="text-[11px]">
                  <span className="text-gray-400">{'\u9884\u89C8\uFF1A'}</span>
                  {previewText ? (
                    <>
                      <div
                        className="bg-gray-50 border border-gray-200 rounded p-2 max-h-40 overflow-auto leading-relaxed mt-1 flex flex-wrap gap-0.5"
                        onMouseUp={() => {
                          const sel = window.getSelection()
                          if (!sel || sel.isCollapsed) return
                          const selectedStr = sel.toString().trim()
                          if (!selectedStr) return
                          // Tokenize the user's selection and mark all content tokens
                          const selTokens = tokenizeText(selectedStr)
                            .filter(t => !/^[\u3000。！？，、；：\s]+$/.test(t))
                          if (selTokens.length === 0) return
                          setMarkedSeeds(prev => {
                            const next = [...prev]
                            for (const t of selTokens) {
                              if (!next.includes(t)) next.push(t)
                            }
                            return next
                          })
                          setAiExpandedKeywords([])
                          setAiCheckedKeywords(new Set())
                          // Clear the selection visual after processing
                          sel.removeAllRanges()
                        }}
                      >
                        {tokens.map((token, i) => {
                          if (/^[\u3000。！？，、；：\s]+$/.test(token)) {
                            return <span key={i}>{token}</span>
                          }
                          const isMarked = markedSeeds.includes(token)
                          return (
                            <span key={i}
                              onClick={() => {
                                // Single click: toggle this individual token
                                setMarkedSeeds(prev => {
                                  if (prev.includes(token)) return prev.filter(s => s !== token)
                                  return [...prev, token]
                                })
                                setAiExpandedKeywords([])
                                setAiCheckedKeywords(new Set())
                              }}
                              className={`cursor-pointer px-0.5 rounded transition-colors ${isMarked ? 'bg-indigo-200 text-indigo-800' : 'hover:bg-gray-200'}`}
                            >{token}</span>
                          )
                        })}
                      </div>
                      {markedSeeds.length > 0 && (
                        <>
                          <div className="mt-1 text-gray-500">
                            {'\u5DF2\u6807\u8BB0\uFF1A'}{markedSeeds.join(' ')}
                          </div>
                          <button onClick={handleAIExpand}
                            disabled={expandingAI}
                            className={`mt-1 px-2 py-0.5 rounded text-[10px] font-medium ${expandingAI ? 'bg-gray-300 text-gray-500' : 'bg-indigo-500 text-white hover:bg-indigo-600'}`}>
                            {expandingAI ? 'AI \u6269\u5C55\u4E2D...' : 'AI \u603B\u7ED3\u6269\u5C55'}
                          </button>
                        </>
                      )}
                    </>
                  ) : <span className="text-gray-400 italic">{'\u7A7A'}</span>}
                </div>
              )
            })()}
            {/* ── Keyword expansion (manual marking + AI) ── */}
            <div className="border-t border-gray-100 pt-2">
              <label className="text-xs text-gray-500">{'\u65B0\u589E\u5173\u952E\u8BCD'}</label>
              <input
                type="text"
                value={manualKeywords}
                onChange={e => setManualKeywords(e.target.value)}
                placeholder={'\u624B\u52A8\u8F93\u5165\uFF0C\u9017\u53F7\u5206\u9694\uFF0C\u5982\uFF1A\u7EEB\u7F57\u957F\u886C\uFF0C\u8DB3\u8DBE\u881F\u7F29'}
                className="w-full px-2 py-1 border border-gray-300 rounded text-xs mt-1"
              />
              {/* AI-expanded keywords from manual marking */}
              {aiExpandedKeywords.length > 0 && (
                <div className="mt-2">
                  <span className="text-[10px] text-gray-400">AI \u6269\u5C55\u7ED3\u679C\uFF1A</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {aiExpandedKeywords.map(kw => {
                      const checked = aiCheckedKeywords.has(kw)
                      return (
                        <button key={kw}
                          onClick={() => {
                            setAiCheckedKeywords(prev => {
                              const next = new Set(prev)
                              if (next.has(kw)) next.delete(kw)
                              else next.add(kw)
                              return next
                            })
                          }}
                          className={`text-[10px] px-1.5 py-0.5 rounded border ${checked ? 'bg-indigo-100 border-indigo-300 text-indigo-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'}`}
                        >{checked ? `\u2713 ${kw}` : kw}</button>
                      )
                    })}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2 mt-2">
                <button onClick={() => saveKeywordCandidates()}
                  className="px-2 py-1 bg-green-600 text-white rounded text-[10px] font-medium hover:bg-green-700 disabled:bg-gray-300"
                  disabled={markedSeeds.length === 0 && aiCheckedKeywords.size === 0 && !manualKeywords.trim()}>
                  {'\u4FDD\u5B58\u81F3\u77E5\u8BC6\u5E93'}
                </button>
                <span className="text-[10px] text-gray-400">{'\u6216\u70B9\u201C\u4FDD\u5B58\u201D\u65F6\u81EA\u52A8\u5199\u5165'}</span>
              </div>
            </div>
            {editingTag.confidence !== undefined && (
              <div className="text-xs text-gray-400">
                AI {'\u7F6E\u4FE1\u5EA6'}: {(editingTag.confidence * 100).toFixed(0)}%
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={handleSaveEdit}
                disabled={editStart >= editEnd}
                className="flex-1 px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 text-sm font-medium">
                {'\u4FDD\u5B58'}
              </button>
              <button onClick={() => setEditingTag(null)}
                className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm">
                {'\u53D6\u6D88'}
              </button>
            </div>
            <button onClick={() => { handleDeleteTag(editingTag); setEditingTag(null) }}
              className="w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200">
              {'\u5220\u9664\u6B64\u573A\u666F'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
