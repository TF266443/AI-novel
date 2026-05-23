import { useState, useCallback } from 'react'
import { cosineSimilarity, packVector, unpackVector, hashText } from '../lib/embedding'
import type { SceneTag, ScanMetrics } from '../stores/useProjectStore'

// ── Types ──
interface Chunk { text: string; offset: number; index: number }

export interface CategoryBootstrap {
  entry_conditions: string    // broad match criteria: e.g. "裸足按摩、足部把玩、足部特写"
  confirm_signals: string[]   // strong keywords that confirm a match
  exclude_patterns: string[]  // patterns that should NOT trigger this category
  expansion_brief: string     // how to expand: e.g. "添加丝袜材质，升级为足交"
}

interface Category {
  id: string; name: string; conditions: string
  synonyms?: string[]; examples?: Array<{ text: string; label: string }>
  confidence_threshold?: number
  bootstrap?: CategoryBootstrap // LLM-generated at template import
}

interface AnalysisOptions {
  onProgress?: (status: string, done: number, total: number) => void
  signal?: AbortSignal
  enableEmbeddingRecall?: boolean
  embeddingModel?: { baseUrl: string; modelId: string; apiKey?: string }
  projectId?: string
  categoryPrompts?: Record<string, string>
  useLLM?: boolean // default false: keyword-only mode. Set true for LLM verification pass.
}

// [OOM-PROBE] Set to false to bisect OOM cause (disables Phase 2 embedding recall).
const OOM_PROBE_ENABLE_EMBEDDING_RECALL = true
const EMBEDDING_BATCH_SIZE = 1        // was 3; serialized to fix OOM
const MAX_EMBED_CHUNKS = 5           // was 30; limit to prevent memory pressure
// Gold Label RAG: retrieve similar user corrections during classification
const ENABLE_GOLD_LABEL_RAG = true
const GOLD_LABEL_SIMILARITY_THRESHOLD = 0.65
const GOLD_LABEL_TOP_K = 5
// Adaptive chunk sizing: dynamic parameters are now selected inside splitChunks()
// based on total text length (see table in splitChunks). Module-level constants
// removed to prevent accidental hardcoded usage.
const CONCURRENCY = 2
const EMBED_SIMILARITY_THRESHOLD = 0.70
const MAX_RETRY_DEPTH = 2
const KEYWORD_FALLBACK_MIN_HITS = 3
const KEYWORD_FALLBACK_MIN_DISTINCT = 2
const MIN_TAG_LEN = 12
const MAX_TAG_LEN = 250
const MIN_CONFIDENCE = 0.55

// ── Status-line mask: replace metadata declarations with same-length filler ──
// Patterns matched: "境界：xxx", "等级：xxx", "修为：xxx", "属性：xxx", "技能：xxx",
// "称号：xxx", "天赋：xxx", "血脉：xxx", "灵根：xxx", "功法：xxx", "经验：xxx", "状态：xxx"
// Also single-line declarations like "【境界】xxx" / "[等级] xxx".
// Replaces with U+3000 (ideographic space) to preserve offsets so tag positions stay aligned.
const STATUS_LABEL = '(?:境界|等级|修为|属性|技能|称号|天赋|血脉|灵根|功法|经验|状态|气血|魂力|战力|品阶|阶位)'
const STATUS_LINE_RE = new RegExp(
  `(?:^|\\n)[^\\n]*?(?:${STATUS_LABEL}[：:][^\\n]*|[【\\[]${STATUS_LABEL}[】\\]][^\\n]*)`,
  'g',
)
export function maskStatusLines(text: string): string {
  return text.replace(STATUS_LINE_RE, (m) => {
    // Keep leading newline if present, replace the rest with full-width spaces
    const lead = m.startsWith('\n') ? '\n' : ''
    return lead + '\u3000'.repeat(m.length - lead.length)
  })
}

// ── Adaptive chunk sizing ──
// Dynamically adjust chunk size and overlap based on total text length to
// prevent excessive API calls on long chapters.
//
// | Total length | CHUNK_SIZE | OVERLAP | Max chunks |
// |--------------|------------|---------|------------|
// | <3000        | 1000       | 500     | unlimited  |
// | 3000-8000    | 1200       | 600     | 12         |
// | 8000-16000   | 1500       | 700     | 15         |
// | >16000       | 2000       | 1000    | 15         |
//
// When chunk count would exceed maxChunks, chunkSize is increased
// proportionally: chunkSize = textLen / maxChunks + overlap
function selectChunkParams(textLen: number): { chunkSize: number; overlap: number } {
  if (textLen < 3000) {
    return { chunkSize: 1000, overlap: 500 }
  }
  if (textLen <= 8000) {
    let chunkSize = 1200
    const overlap = 600
    const maxChunks = 12
    const estChunks = textLen / (chunkSize - overlap)
    if (estChunks > maxChunks) {
      chunkSize = Math.ceil(textLen / maxChunks + overlap)
    }
    return { chunkSize, overlap }
  }
  if (textLen <= 16000) {
    let chunkSize = 1500
    const overlap = 700
    const maxChunks = 15
    const estChunks = textLen / (chunkSize - overlap)
    if (estChunks > maxChunks) {
      chunkSize = Math.ceil(textLen / maxChunks + overlap)
    }
    return { chunkSize, overlap }
  }
  // >16000
  let chunkSize = 2000
  const overlap = 1000
  const maxChunks = 15
  const estChunks = textLen / (chunkSize - overlap)
  if (estChunks > maxChunks) {
    chunkSize = Math.ceil(textLen / maxChunks + overlap)
  }
  return { chunkSize, overlap }
}

export function splitChunks(text: string): Chunk[] {
  const chunks: Chunk[] = []
  if (!text) return chunks
  const { chunkSize, overlap } = selectChunkParams(text.length)
  let offset = 0, index = 0
  while (offset < text.length) {
    let end = Math.min(offset + chunkSize, text.length)
    if (end < text.length) {
      const searchStart = Math.max(offset, end - 120)
      const m = text.slice(searchStart, end).match(/[。！？\n](?=[^。！？\n]*$)/)
      if (m?.index !== undefined) end = searchStart + m.index + 1
    }
    chunks.push({ text: text.slice(offset, end), offset, index })
    index++
    if (end >= text.length) break
    const nextOffset = end - overlap
    offset = nextOffset > offset ? nextOffset : end
  }
  return chunks
}

// ── Evidence location: exact → normalized → LCS → best-effort span ──
function locateEvidence(chunk: Chunk, evidence: string, fullText: string): { start: number; end: number } | null {
  // 1. Exact match
  let idx = chunk.text.indexOf(evidence)
  if (idx !== -1) return { start: chunk.offset + idx, end: chunk.offset + idx + evidence.length }

  // 2. Whitespace-normalized
  const norm = evidence.replace(/\s+/g, '')
  if (norm.length >= 4) {
    const ci = chunk.text.replace(/\s+/g, '').indexOf(norm)
    if (ci !== -1) return { start: chunk.offset + ci, end: chunk.offset + ci + norm.length }
  }

  // 3. Longest common substring (fallback for slight LLM paraphrasing)
  const lcs = longestCommonSubstring(evidence, chunk.text)
  if (lcs && lcs.length >= Math.min(10, evidence.length * 0.5)) {
    idx = chunk.text.indexOf(lcs)
    if (idx !== -1) return { start: chunk.offset + idx, end: chunk.offset + idx + lcs.length }
  }

  // 4. First sentence of evidence as anchor
  const firstSentence = evidence.match(/^(.+?)[。！？]/)
  if (firstSentence) {
    idx = chunk.text.indexOf(firstSentence[1])
    if (idx !== -1) {
      // Try to match full evidence near this position
      const fullIdx = chunk.text.indexOf(evidence, Math.max(0, idx - 10))
      if (fullIdx !== -1) {
        const endPos = chunk.offset + fullIdx + Math.min(evidence.length, 200)
        return { start: chunk.offset + fullIdx, end: endPos }
      }
      // Fall back to just the matched sentence
      return { start: chunk.offset + idx, end: chunk.offset + idx + firstSentence[1].length }
    }
  }

  return null
}

// ── Longest common substring (O(n*m)) ──
export function longestCommonSubstring(a: string, b: string): string | null {
  const la = a.length, lb = b.length
  if (la === 0 || lb === 0) return null
  const dp = new Array(la + 1).fill(0).map(() => new Array(lb + 1).fill(0))
  let maxLen = 0, endA = 0
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
        if (dp[i][j] > maxLen) { maxLen = dp[i][j]; endA = i }
      }
    }
  }
  return maxLen >= 5 ? a.slice(endA - maxLen, endA) : null
}

// ── JSON Schema with categoryId enum enforcement ──
function buildSchema(cats: Category[]) {
  return {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            categoryId: { type: 'string', enum: cats.map(c => c.id) },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidence: { type: 'string', minLength: 4 },
          },
          required: ['categoryId', 'confidence', 'evidence'],
        },
      },
    },
    required: ['matches'],
  }
}

// ── Deduplicate + merge tags by category, manual wins on conflict ──
export function mergeTags(tags: SceneTag[]): SceneTag[] {
  const byCat = new Map<string, SceneTag[]>()
  for (const t of tags) {
    const arr = byCat.get(t.categoryId) || []
    arr.push(t)
    byCat.set(t.categoryId, arr)
  }
  const merged: SceneTag[] = []

  for (const [, group] of byCat) {
    // Resolve same-start conflicts: manual > corrected > ai
    const resolved: SceneTag[] = []
    group.sort((a, b) => a.start - b.start)
    for (let i = 0; i < group.length; i++) {
      const t = group[i]
      const existing = resolved.findIndex(r => r.start === t.start)
      if (existing !== -1) {
        // Manual wins
        if (t.source === 'manual') resolved[existing] = t
        else if (t.source === 'corrected' && resolved[existing].source === 'ai') resolved[existing] = t
      } else {
        resolved.push({ ...t })
      }
    }

    // Adjacent merge (same category, <=10 char gap)
    resolved.sort((a, b) => a.start - b.start)
    let cur = { ...resolved[0] }
    for (let i = 1; i < resolved.length; i++) {
      const n = resolved[i]
      if (n.start <= cur.end + 10) {
        cur.end = Math.max(cur.end, n.end)
        cur.confidence = Math.max(cur.confidence ?? 0, n.confidence ?? 0)
        if (n.source === 'ai' && cur.source === 'manual') { /* manual wins, keep cur.source */ }
        else if (n.source === 'manual') cur.source = 'manual'
        else if (n.source === 'corrected' && cur.source === 'ai') cur.source = 'corrected'
      } else {
        merged.push(cur)
        cur = { ...n }
      }
    }
    merged.push(cur)
  }

  return merged.sort((a, b) => a.start - b.start)
}

// ── Cross-category overlap resolution ──
// When two tags of DIFFERENT categories overlap by >50% of either tag's span,
// keep only the higher-priority one. Priority: manual > corrected > ai.
// Within same priority, higher confidence wins.
export function resolveOverlaps(tags: SceneTag[]): SceneTag[] {
  if (tags.length <= 1) return tags
  const sorted = [...tags].sort((a, b) => a.start - b.start)
  const result: SceneTag[] = []

  const sourcePriority = (source: string): number =>
    source === 'manual' ? 3 : source === 'corrected' ? 2 : 1

  for (const tag of sorted) {
    let shouldAdd = true
    for (let i = result.length - 1; i >= 0; i--) {
      const kept = result[i]
      if (kept.end <= tag.start) break // no more possible overlaps (sorted by start)

      // Compute overlap
      const overlapStart = Math.max(kept.start, tag.start)
      const overlapEnd = Math.min(kept.end, tag.end)
      const overlapLen = overlapEnd - overlapStart
      if (overlapLen <= 0) continue

      const tagLen = tag.end - tag.start
      const keptLen = kept.end - kept.start
      const overlapRatio = Math.max(overlapLen / tagLen, overlapLen / keptLen)

      if (overlapRatio > 0.5) {
        // Heavy overlap — resolve by source priority, then confidence
        const keptPriority = sourcePriority(kept.source)
        const tagPriority = sourcePriority(tag.source)
        if (tagPriority > keptPriority || (tagPriority === keptPriority && (tag.confidence ?? 0) > (kept.confidence ?? 0))) {
          result[i] = tag
        }
        shouldAdd = false
        break
      }
    }
    if (shouldAdd) result.push(tag)
  }

  return result
}

// ── Parse conditions into structured cues: 识别点 / 关键词 / 独占规则 ──
// Categories may carry conditions text in a structured form, e.g.:
//   "识别点：丝绸罗袜、足部亲密。
//    关键词：罗袜、丝绸袜、绫袜、玉足、金莲、足交、足侍奉、足心、足弓。
//    独占规则：女性足部侍奉专属陈墨，严禁为其他男性服务。"
// We parse these into typed sections so the LLM gets all three signals
// (semantic cues, literal terms, exclusivity constraints) and we can apply
// each appropriately downstream.
interface ParsedConditions {
  cues: string[]      // 识别点 — semantic recognition cues
  keywords: string[]  // 关键词 — literal terms (extracted into the keyword list)
  exclusivity: string // 独占规则 — verbatim, fed to LLM
  raw: string         // remainder text not in any labeled section
}

export function parseConditions(text: string): ParsedConditions {
  const result: ParsedConditions = { cues: [], keywords: [], exclusivity: '', raw: '' }
  if (!text) return result
  // Section header pattern: 识别点 / 关键词 / 独占规则 (also accept 触发条件、触发点)
  // followed by ：or :
  const SECTION_RE = /(识别点|触发点|触发条件|关键词|独占规则|排除规则)\s*[：:]/g
  const parts: Array<{ label: string; start: number; bodyStart: number }> = []
  let m: RegExpExecArray | null
  while ((m = SECTION_RE.exec(text)) !== null) {
    parts.push({ label: m[1], start: m.index, bodyStart: m.index + m[0].length })
  }
  if (parts.length === 0) {
    result.raw = text.trim()
    return result
  }
  // Anything before the first labeled section is "raw"
  if (parts[0].start > 0) result.raw = text.slice(0, parts[0].start).trim()
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const end = i + 1 < parts.length ? parts[i + 1].start : text.length
    const body = text.slice(p.bodyStart, end).trim().replace(/[。\n]+$/g, '').trim()
    if (!body) continue
    if (p.label === '关键词') {
      const items = body.split(/[、,，;；\s]+/).map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 16)
      result.keywords.push(...items)
    } else if (p.label === '识别点' || p.label === '触发点' || p.label === '触发条件') {
      const items = body.split(/[、,，;；]+/).map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 30)
      result.cues.push(...items)
    } else if (p.label === '独占规则' || p.label === '排除规则') {
      result.exclusivity = body
    }
  }
  return result
}

// ── Extract keywords: synonyms + parsed-conditions keywords + bootstrap confirm_signals + 「」-quoted terms ──
function extractKeywords(cat: Category): string[] {
  const kws: string[] = []
  if (cat.synonyms) kws.push(...cat.synonyms)
  const parsed = parseConditions(cat.conditions || '')
  for (const k of parsed.keywords) if (!kws.includes(k)) kws.push(k)
  // Bootstrap confirm_signals are LLM-picked strong keywords → high quality, always include
  if (cat.bootstrap?.confirm_signals) {
    for (const s of cat.bootstrap.confirm_signals) {
      if (s.length >= 2 && !kws.includes(s)) kws.push(s)
    }
  }
  // Legacy 「xxx」 quoted-term extraction stays as a fallback
  const quoted = (cat.conditions || '').match(/「(.+?)」/g)
  if (quoted) {
    for (const q of quoted) {
      const inner = q.replace(/[「」]/g, '')
      if (inner.length >= 2 && !kws.includes(inner)) kws.push(inner)
    }
  }
  return kws
}

// ── Build category catalog with all three structured cue layers ──
// We feed the LLM (a) keywords for literal anchoring, (b) 识别点 semantic cues
// for paraphrase tolerance, (c) 独占规则 to constrain who/what counts.
function buildCatalog(cats: Category[], categoryPrompts?: Record<string, string>): string {
  return cats.map(c => {
    const parsed = parseConditions(c.conditions || '')
    const kws = extractKeywords(c).slice(0, 24)
    const kwStr = kws.length ? kws.join('、') : '（无）'
    const cueStr = parsed.cues.length ? parsed.cues.join('、') : (parsed.raw || '（无）')
    const lines = [
      `id="${c.id}"`,
    ]

    // If bootstrapped: use LLM-generated recognition semantics (方案5)
    if (c.bootstrap) {
      const b = c.bootstrap
      lines.push(`可扩写入口：${b.entry_conditions}`)
      lines.push(`确认信号：${b.confirm_signals.join('、')}`)
      if (b.exclude_patterns.length) lines.push(`排除条件：${b.exclude_patterns.join('、')}`)
      lines.push(`关键词：${kwStr}`)
    } else {
      // Fallback: original template-based catalog
      lines.push(`识别点：${cueStr}`)
      lines.push(`关键词：${kwStr}`)
      if (parsed.exclusivity) lines.push(`独占规则：${parsed.exclusivity}`)
      // Include categoryPrompts scene recognition line
      const prompt = categoryPrompts?.[c.id]
      if (prompt) {
        const recMatch = prompt.match(/\*\*场景识别\*\*[：:][^\n]*/)
        const kwMatch = prompt.match(/\*\*关键词\*\*[：:][^\n]*/)
        if (recMatch) lines.push(recMatch[0].trim())
        if (kwMatch) lines.push(kwMatch[0].trim())
      }
    }
    return lines.join(' | ')
  }).join('\n')
}

// ── Few-shot examples (suppress category names; only id + cues) ──
function buildFewShot(cats: Category[]): string {
  const parts: string[] = []
  for (const c of cats) {
    if (!c.examples) continue
    const pos = c.examples.filter(e => e.label === 'positive').slice(0, 2)
    const neg = c.examples.filter(e => e.label === 'negative').slice(0, 1)
    for (const p of pos) {
      parts.push(`✓ 正例（categoryId="${c.id}"）："${p.text.slice(0, 100)}"`)
    }
    for (const n of neg) {
      parts.push(`✗ 反例（categoryId≠"${c.id}"）："${n.text.slice(0, 100)}"`)
    }
  }
  return parts.join('\n')
}

// ── Find keyword spans in text with which keyword matched ──
function findKeywordSpans(text: string, offset: number, kws: string[]): Array<{ start: number; end: number; kw: string }> {
  const spans: Array<{ start: number; end: number; kw: string }> = []
  for (const kw of kws) {
    if (kw.length < 2) continue // single-char keywords too noisy
    let pos = 0
    while ((pos = text.indexOf(kw, pos)) !== -1) {
      spans.push({ start: offset + pos, end: offset + pos + kw.length, kw })
      pos += kw.length
    }
  }
  return spans
}

// ── Snap a located range to nearest sentence boundary on both sides ──
export function snapToSentence(start: number, end: number, fullText: string, window: number = 45): { start: number; end: number } {
  const SENT = /[。！？\n]/
  let s = start
  for (let k = 0; k < window && s > 0; k++, s--) {
    if (SENT.test(fullText[s - 1])) break
  }
  let e = end
  for (let k = 0; k < window && e < fullText.length; k++, e++) {
    if (SENT.test(fullText[e])) { e++; break }
  }
  return { start: s, end: e }
}

// ── Shrink chunk for retry ──
export function shrinkChunk(chunk: Chunk): Chunk | null {
  const mid = Math.floor(chunk.text.length / 2)
  const pivot = chunk.text.lastIndexOf('\n', mid)
  const splitAt = pivot > 0 ? pivot : mid
  if (splitAt < 100) return null // too small to split
  return { text: chunk.text.slice(0, splitAt), offset: chunk.offset, index: chunk.index }
}

// ── Gold Label RAG ──
interface GoldLabelEntry {
  id: string
  categoryId: string
  categoryName: string
  label: 'positive' | 'negative'
  snippet: string
  vector?: number[]
}

async function loadGoldLabels(projectId: string): Promise<GoldLabelEntry[]> {
  const r = await window.api.db.query('gold_labels', 'project_id = ?', [projectId])
  if (!r.success || !r.data) return []
  return (r.data as any[]).map((gl: any) => ({
    id: gl.id,
    categoryId: gl.category_id,
    categoryName: '',
    label: gl.label as 'positive' | 'negative',
    snippet: gl.snippet_text || '',
  }))
}

function matchGoldLabelsByKeyword(
  chunkText: string,
  goldLabels: GoldLabelEntry[],
  catKeywordsMap: Map<string, string[]>,
  topK: number,
): GoldLabelEntry[] {
  const scored: Array<{ entry: GoldLabelEntry; score: number }> = []
  for (const gl of goldLabels) {
    const kws = catKeywordsMap.get(gl.categoryId) || []
    let score = 0
    for (const kw of kws) {
      if (gl.snippet.includes(kw)) score += 1
      if (chunkText.includes(kw)) score += 0.5
    }
    // Bonus for exact snippet substring match in chunk
    if (gl.snippet.length >= 8 && chunkText.includes(gl.snippet.slice(0, 20))) {
      score += 2
    }
    if (score > 0) scored.push({ entry: gl, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map(s => s.entry)
}

function formatGoldLabelContext(matches: GoldLabelEntry[]): string {
  if (matches.length === 0) return ''
  const positive = matches.filter(m => m.label === 'positive')
  const negative = matches.filter(m => m.label === 'negative')
  const lines: string[] = ['', '【用户历史标注参考】以下是你之前对类似文段的标注，请参考：', '']
  for (const p of positive.slice(0, 3)) {
    const snippet = p.snippet.replace(/\n/g, ' ').slice(0, 80)
    lines.push(`✓ 用户确认这是 ${p.categoryName || p.categoryId}：\"${snippet}\"`)
  }
  for (const n of negative.slice(0, 2)) {
    const snippet = n.snippet.replace(/\n/g, ' ').slice(0, 80)
    lines.push(`✗ 用户确认这不是 ${n.categoryName || n.categoryId}：\"${snippet}\"`)
  }
  if (lines.length <= 4) return '' // Not enough meaningful matches
  lines.push('')
  return lines.join('\n')
}

// ── Adaptive per-category confidence threshold ──
// After each scan, count FP/FN from gold labels vs AI tags for each category.
// Nudge the threshold up (if too many false positives) or down (if too many false negatives).
// Persists the updated threshold to template.categories[catId].confidence_threshold.
async function adaptThresholds(
  projectId: string,
  categories: Category[],
  aiTags: SceneTag[],
  chapterText: string,
): Promise<void> {
  if (!projectId || categories.length === 0) return
  // Load all gold labels for this project
  const r = await window.api.db.query('gold_labels', 'project_id = ?', [projectId])
  if (!r.success || !r.data) return
  const allGold = r.data as any[]
  if (allGold.length === 0) return

  // Group gold labels by category
  const goldByCat = new Map<string, { positives: any[]; negatives: any[] }>()
  for (const gl of allGold) {
    let entry = goldByCat.get(gl.category_id)
    if (!entry) { entry = { positives: [], negatives: [] }; goldByCat.set(gl.category_id, entry) }
    if (gl.label === 'positive') entry.positives.push(gl)
    else entry.negatives.push(gl)
  }

  const MIN_THRESHOLD = 0.35
  const MAX_THRESHOLD = 0.80
  const NUDGE = 0.05

  for (const cat of categories) {
    const entry = goldByCat.get(cat.id)
    if (!entry) continue
    const total = entry.positives.length + entry.negatives.length
    if (total < 5) continue // Not enough data to adapt

    const catTags = aiTags.filter(t => t.categoryId === cat.id)

    // FP: AI tag overlaps a negative gold label range
    let fp = 0
    for (const tag of catTags) {
      for (const neg of entry.negatives) {
        if (neg.start_pos !== undefined && neg.end_pos !== undefined) {
          if (tag.start < neg.end_pos && tag.end > neg.start_pos) { fp++; break }
        }
      }
    }

    // FN: positive gold label with NO overlapping AI tag
    let fn = 0
    for (const pos of entry.positives) {
      const ps = pos.start_pos ?? 0
      const pe = pos.end_pos ?? 0
      if (ps >= pe) continue
      const overlapped = catTags.some(t => t.start < pe && t.end > ps)
      if (!overlapped) fn++
    }

    const currentThreshold = cat.confidence_threshold ?? MIN_CONFIDENCE
    let newThreshold = currentThreshold

    if (fp > fn) {
      newThreshold = Math.min(currentThreshold + NUDGE, MAX_THRESHOLD)
    } else if (fn > fp) {
      newThreshold = Math.max(currentThreshold - NUDGE, MIN_THRESHOLD)
    }

    if (newThreshold !== currentThreshold) {
      cat.confidence_threshold = newThreshold
    }
  }

  // Persist updated thresholds to template
  try {
    const tr = await window.api.db.query('templates', "id IN (SELECT template_id FROM projects WHERE id = ?)", [projectId])
    if (!tr.success || !tr.data?.length) return
    const row = (tr.data as any[])[0]
    const tpl = JSON.parse(row.template_json)
    const tplCats = tpl?.identifyTemplate?.categories
    if (!Array.isArray(tplCats)) return
    for (const tc of tplCats) {
      const mem = categories.find(c => c.id === tc.id)
      if (mem?.confidence_threshold !== undefined) {
        tc.confidence_threshold = mem.confidence_threshold
      }
    }
    await window.api.db.mutation('templates', 'update', { template_json: JSON.stringify(tpl) }, 'id = ?', [row.id])
  } catch { /* non-critical */ }
}

// ── Hook ──
export function useScanAnalysis() {
  const [analyzing, setAnalyzing] = useState(false)
  const [status, setStatus] = useState('')
  const [metrics, setMetrics] = useState<ScanMetrics | null>(null)

  const analyze = useCallback(async (
    chapterText: string,
    chapterId: string,
    categories: Category[],
    modelConfig: { baseUrl: string; modelId: string; apiKey: string },
    existingManualTags: SceneTag[],
    options?: AnalysisOptions,
  ): Promise<SceneTag[]> => {
    setAnalyzing(true)
    setStatus('')
    const t0 = Date.now()

    try {
      // Mask status-line metadata (e.g., "境界：七品凡胎·易筋境") so the LLM/keyword
       // pipeline does not classify RPG-style declarations as narrative scenes.
       // Masking preserves offsets, so resulting tag positions still index into chapterText.
       const maskedText = maskStatusLines(chapterText)
       const chunks = splitChunks(maskedText)
      const catalog = buildCatalog(categories, options?.categoryPrompts)
      const fewShot = buildFewShot(categories)
      const schema = buildSchema(categories)
      const categoryIds = JSON.stringify(categories.map(c => c.id))
      const hasBootstrap = categories.some(c => c.bootstrap)

      const systemPrompt = hasBootstrap ? `你是"加料标记"助手。你的任务不是判断文本"已经"是某个场景，而是找出文本中可以作为某场景扩写起点的段落。
scene_catalog 中每个条目包含：
- 可扩写入口：哪些原文描写可以作为该场景的扩写出发点（宽泛匹配）
- 确认信号：出现了这些元素的，置信度应更高
- 排除条件：出现了这些模式的，不应该标记为该场景
- 关键词：必须在 evidence 中字面出现的词（硬性锚点）

输出 JSON：{"matches":[{"categoryId":"<必须从下面清单选取>","confidence":0.0-1.0,"evidence":"必须从原文逐字引用，≥4字"}]}
判定规则：
- evidence 字面包含该 categoryId 的至少一个关键词（硬性锚点，不满足则不输出）
- evidence 描写落在某条"可扩写入口"上（语义层）
- 若 evidence 落入某条"排除条件"，一律不输出
- categoryId 只能从 scene_catalog 中选择，不得自造
- evidence 是原文中连续引用的文本，不能改写或总结
- confidence < 0.55 的匹配不输出
- 忽略状态栏/属性栏类描述` : `你是文本场景识别助手。每个场景包含三层信号：识别点（语义触发条件）、关键词（字面词表）、独占规则（可选的人物/对象限制）。
判定流程：先看 evidence 是否满足任一识别点（语义层），再要求 evidence 中字面包含该 categoryId 的至少一个关键词作为锚点；若该场景有独占规则，evidence 还必须符合该规则（否则一律不输出）。
输出 JSON：{"matches":[{"categoryId":"<必须从下面清单选取>","confidence":0.0-1.0,"evidence":"必须从原文逐字引用，≥4字"}]}
判定规则（严格执行）：
- evidence 中**字面出现**该 categoryId 的某个关键词（硬性锚点）
- 同时 evidence 整体描写须落在某条识别点上（语义层）
- 若有独占规则，evidence 中的对象/动作必须符合该规则；不符合则不输出
- categoryId 只能从 scene_catalog 中选择，不得自造
- evidence 是原文中连续引用的文本，不能改写或总结
- confidence < 0.55 的匹配不输出
- 最多输出 5 个匹配
- 忽略状态栏/属性栏类描述（如"境界：xxx"、"等级：xxx"、"修为：xxx"、"【天赋】xxx"），即使包含关键词也不输出
${fewShot ? `\n标注示例：\n${fewShot}` : ''}`

      const aiTags: SceneTag[] = []
      const failedChunks: ScanMetrics['failedChunks'] = []
      // Pre-build keyword index per category (must come before debugLog usage)
      const catKeywords = categories.map(c => ({ id: c.id, name: c.name, kws: extractKeywords(c) }))

      // ── Gold Label RAG: load user corrections as retrieval source ──
      const catKeywordsMap = new Map<string, string[]>()
      for (const ck of catKeywords) catKeywordsMap.set(ck.id, ck.kws)
      const goldLabels = (ENABLE_GOLD_LABEL_RAG && options?.projectId)
        ? await loadGoldLabels(options.projectId)
        : []
      for (const gl of goldLabels) {
        const cat = catKeywords.find(c => c.id === gl.categoryId)
        if (cat) gl.categoryName = cat.name
      }

      const debugLog: string[] = []
      debugLog.push(`\u250C\u2500 AI \u573A\u666F\u8BC6\u522B\u8BCA\u65AD`)
      debugLog.push(`\u251C \u7AE0\u8282\u957F\u5EA6: ${chapterText.length} \u5B57, \u5206\u5757: ${chunks.length} (\u6BCF\u5757~${chunks[0]?.text.length || 0}\u5B57)`)
      debugLog.push(`\u251C \u573A\u666F\u7C7B\u522B: ${categories.length} \u4E2A`)
      for (const c of categories) {
        const kws = catKeywords.find(k => k.id === c.id)?.kws || []
        debugLog.push(`\u2502  ${c.id}: ${c.name} (\u5173\u952E\u8BCD: ${kws.slice(0,8).join(', ')}${kws.length > 8 ? '...' : ''})`)
      }
      // ── Per-category adaptive confidence threshold ──
      const thresholdMap = new Map<string, number>()
      for (const cat of categories) {
        thresholdMap.set(cat.id, cat.confidence_threshold ?? MIN_CONFIDENCE)
      }

      debugLog.push(`\u251C RAG: ${goldLabels.length} \u6761\u5386\u53F2\u6807\u6CE8`)
      debugLog.push(`\u251C \u9608\u503C: ${[...thresholdMap.entries()].filter(([,v]) => v !== MIN_CONFIDENCE).map(([k,v]) => k + '=' + v).join(', ') || '\u5168\u90E8 ' + MIN_CONFIDENCE}`)

      // ── Phase 1: AI full-chapter analysis (≤5000 chars) ──
      const FULL_CHAPTER_MAX = 5000
      if (chapterText.length <= FULL_CHAPTER_MAX) {
        debugLog.push(`\u251C \u5168\u6587AI\u5206\u6790 (\u7AE0\u8282${chapterText.length}\u5B57)`)
        options?.onProgress?.('AI 全文分析中...', 0, 1)
        // Setup abort for complete call (non-streaming)
        const abortId = `complete-${chapterId}-${Date.now()}`
        if (options?.signal) {
          const onAbort = () => { window.api.ai.abort(abortId).catch(() => {}) }
          options.signal.addEventListener('abort', onAbort, { once: true })
        }

        try {
          const r = await window.api.ai.complete({
            baseUrl: modelConfig.baseUrl,
            modelId: modelConfig.modelId,
            apiKey: modelConfig.apiKey,
            abortId,
            messages: [
              { role: 'system', content: `你是小说场景分析助手。根据提供的场景清单（scene_catalog）和模板规则，分析章节文本，识别所有可匹配的场景。

规则：
1. 对每个匹配的场景，从原文中**逐字完整复制**连续段落（≥60字），不得增删改任何字、标点、换行
2. 标注场景名称和置信度
3. 同一类别最多1个最长段落
4. 总共不超过5个
5. 忽略境界/修为/状态栏等元数据
6. 禁止总结、缩写、改写——必须是原文原样

输出格式示例（注意：blockquote内必须是原文字符）：
### 丝袜足交场景 (置信度:0.95)
> 看着搭在腿上的玉足，陈墨一时有些愣神。难道这就是娘娘给他的奖励？感动……根本不敢动啊！
### 按摩场景 (置信度:0.90)
> 陈墨好似珍宝似的把脚丫捧在手心，按压足底，轻刮趾窝……` },
              { role: 'user', content: `scene_catalog（只能从中选择）：\n${catalog}\n\nallowed_ids：${categoryIds}\n\n章节文本：\n${chapterText}` },
            ],
            maxTokens: 2000,
            temperature: 0.7,
          })

          // Parse response: Markdown analysis format (same as Chatbox output)
          // Format: ### 场景名 (置信度:0.95)\n> 原文段落引用\n
          if (r.success && r.data) {
            let rawText = r.data as string

            // Strip DeepSeek-R1 / reasoning model thinking blocks
            // Format: 思考...<｜end▁of▁thinking｜> or <thinking>...</thinking>
            rawText = rawText.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            rawText = rawText.replace(/思考[\s\S]*?回答/gi, '')
            // Strip 思考... answer marker (Chinese R1 format)
            const answerIdx = rawText.indexOf('### ')
            if (answerIdx > 0) rawText = rawText.slice(answerIdx)

            const matches: Array<{ categoryId: string; confidence: number; evidence: string }> = []

            // Split by ### headings, extract scene name + confidence + blockquote
            const sections = rawText.split(/^###\s*/m).filter(Boolean)
            for (const section of sections) {
              const lines = section.split('\n')
              const heading = lines[0].trim()

              // Extract scene name and confidence: "丝袜足交场景 (置信度:0.95)"
              const nameMatch = heading.match(/^(.+?)\s*[(（]\s*置信度?\s*[:：]\s*([0-9.]+)\s*[)）]/)
              if (!nameMatch) continue
              const sceneName = nameMatch[1].trim()
              const confidence = parseFloat(nameMatch[2])

              // Find matching category: id → name → partial → keyword overlap
              let cat = categories.find(c => c.id === sceneName)
              if (!cat) cat = categories.find(c => c.name === sceneName)
              if (!cat) cat = categories.find(c => sceneName.includes(c.name) || c.name.includes(sceneName))
              if (!cat) cat = categories.find(c => sceneName.length >= 4 && c.name.length >= 4 && (sceneName.slice(0,4) === c.name.slice(0,4)))
              if (!cat) continue

              // Extract evidence from > blockquote lines
              const evidenceLines: string[] = []
              for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim()
                if (line.startsWith('>')) {
                  evidenceLines.push(line.replace(/^>\s*/, ''))
                } else if (evidenceLines.length > 0) {
                  break // stop at first non-quote line after quotes
                }
              }
              const evidence = evidenceLines.join('')
              if (!evidence || evidence.length < 12) continue

              matches.push({ categoryId: cat.id, confidence, evidence })
            }

            // Fallback: try JSON if no Markdown matches found
            if (matches.length === 0) {
              try {
                let jsonText = rawText
                const mdMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
                if (mdMatch) jsonText = mdMatch[1].trim()
                const braceIdx = jsonText.indexOf('{')
                if (braceIdx > 0) jsonText = jsonText.slice(braceIdx)
                const parsed = JSON.parse(jsonText)
                for (const m of ((parsed as any).matches || [])) {
                  const cat = categories.find(c => c.id === m.categoryId)
                  if (cat && m.confidence >= MIN_CONFIDENCE && m.evidence?.length >= 12) {
                    matches.push({ categoryId: cat.id, confidence: m.confidence, evidence: m.evidence })
                  }
                }
              } catch { /* fallback parse failed */ }
            }

            debugLog.push(`\u251C AI\u5168\u6587\u8FD4\u56DE${matches.length}\u4E2A\u5339\u914D`)
            // Dedup: per category keep only the longest evidence, then top 5 by confidence
            const deduped: typeof matches = []
            const seenCats = new Set<string>()
            // Sort by evidence length desc (longest first) → dedup by category
            const byLength = [...matches].sort((a, b) => (b.evidence?.length || 0) - (a.evidence?.length || 0))
            for (const m of byLength) {
              if (seenCats.has(m.categoryId)) continue
              seenCats.add(m.categoryId)
              deduped.push(m)
            }
            // Take top 5 by confidence
            deduped.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
            const finalMatches = deduped.slice(0, 5)
            debugLog.push(`\u251C AI\u5168\u6587\u8FD4\u56DE${matches.length}\u4E2A\u5339\u914D\uFF0C\u53BB\u91CD\u540E${finalMatches.length}\u4E2A`)
            for (const m of finalMatches) {
              if (m.confidence < MIN_CONFIDENCE) continue
              const cat = categories.find(c => c.id === m.categoryId)
              if (!cat) continue
              if (!m.evidence || m.evidence.length < 12) continue

              // Full-chapter analysis: AI does semantic matching. Only gate-check:
              // evidence must exist verbatim in the source text (no hallucinations).
              // Skip keyword gate — the AI's catalog analysis replaces it.

              // Locate evidence in chapter text (multiple strategies)
              let idx = chapterText.indexOf(m.evidence)
              // Strategy 1: collapse all whitespace/newlines for matching
              if (idx === -1) {
                const normEv = m.evidence.replace(/[\s\r\n\u3000]+/g, '')
                const normText = chapterText.replace(/[\s\r\n\u3000]+/g, '')
                idx = normText.indexOf(normEv)
                // Map back: count chars until the normalized position in original
                if (idx !== -1) {
                  let origPos = 0, normPos = 0
                  while (normPos < idx && origPos < chapterText.length) {
                    if (/[\s\r\n\u3000]/.test(chapterText[origPos])) { origPos++ }
                    else { origPos++; normPos++ }
                  }
                  idx = origPos
                }
              }
              // Strategy 2: decreasing window substring search
              if (idx === -1) {
                for (let win = Math.min(40, m.evidence.length); win >= 15; win -= 5) {
                  let found = false
                  for (let k = 0; k <= m.evidence.length - win; k++) {
                    const pos = chapterText.indexOf(m.evidence.slice(k, k + win))
                    if (pos !== -1) { idx = pos; found = true; break }
                  }
                  if (found) break
                }
              }
              if (idx === -1) {
                debugLog.push(`  \u251C\u2500 ${cat.name}: \u2717 \u5B9A\u4F4D\u5931\u8D25 "${m.evidence.slice(0,30)}"`)
                continue
              }

              // Snap to sentence boundaries with wide window (100 chars) for full-chapter mode
              // to catch preceding paragraphs that may be part of the same scene
              const snapped = snapToSentence(idx, idx + m.evidence.length, chapterText, 100)
              if (snapped.end - snapped.start < MIN_TAG_LEN) continue
              if (snapped.end - snapped.start > MAX_TAG_LEN) {
                snapped.end = Math.min(snapped.start + MAX_TAG_LEN, chapterText.length)
              }

              const evSnippet = m.evidence.replace(/\n/g, ' ').slice(0, 40)
              aiTags.push({
                categoryId: m.categoryId,
                name: cat.name,
                start: snapped.start,
                end: snapped.end,
                source: 'ai',
                confidence: m.confidence,
              })
              debugLog.push(`  \u2514\u2500 ${cat.name}: \u2713 AI\u5168\u6587 \u7F6E\u4FE1\u5EA6${(m.confidence*100).toFixed(0)}% [${snapped.start}-${snapped.end}] "${evSnippet}"`)
            }
          } else {
            debugLog.push(`\u251C AI\u5168\u6587\u5206\u6790\u5931\u8D25: ${r.error || 'unknown'}`)
          }
        } catch (err: unknown) {
          debugLog.push(`\u251C AI\u5206\u6790\u5F02\u5E38: ${(err as Error).message}`)
        }
      } else {
        debugLog.push(`\u251C \u7AE0\u8282${chapterText.length}\u5B57 > ${FULL_CHAPTER_MAX}\uFF0C\u56DE\u9000\u5230\u5206\u5757\u6A21\u5F0F`)
      }

      // ── Abort check: skip remaining phases if user cancelled ──
      if (options?.signal?.aborted) {
        debugLog.push(`\u2514 \u5DF2\u4E2D\u6B62`)
        return [...existingManualTags]
      }

      // ── Phase 2: Keyword scanning per chunk (always runs, fills gaps AI missed) ──
      for (let i = 0; i < chunks.length; i++) {
        if (options?.signal?.aborted) break
        options?.onProgress?.(`扫描中... ${i + 1}/${chunks.length}`, i, chunks.length)

        const chunk = chunks[i]
        let kwCount = 0
        for (const ck of catKeywords) {
          if (ck.kws.length === 0) continue
          const spans = findKeywordSpans(chunk.text, chunk.offset, ck.kws)
          if (spans.length < KEYWORD_FALLBACK_MIN_HITS) continue
          const distinct = new Set(spans.map(s => s.kw)).size
          if (distinct < KEYWORD_FALLBACK_MIN_DISTINCT) continue
          kwCount++
          spans.sort((a, b) => a.start - b.start)
          let clusterStart = spans[0].start, clusterEnd = spans[0].end
          let clusterDistinct = new Set<string>([spans[0].kw])
          const pushCluster = (cs: number, ce: number, distinctSet: Set<string>): void => {
            if (distinctSet.size < KEYWORD_FALLBACK_MIN_DISTINCT) return
            if (ce - cs > 200) {
              const end = Math.min(cs + MAX_TAG_LEN, ce + 60)
              aiTags.push({ categoryId: ck.id, name: ck.name, start: cs, end, source: 'ai', confidence: MIN_CONFIDENCE })
              return
            }
            let snapped = snapToSentence(cs, ce, chapterText)
            if (snapped.end < ce) snapped = { start: snapped.start, end: ce }
            if (snapped.start > cs) snapped = { start: cs, end: snapped.end }
            if (snapped.end - snapped.start < MIN_TAG_LEN) return
            if (snapped.end - snapped.start > MAX_TAG_LEN) {
              snapped = { start: cs, end: Math.min(cs + MAX_TAG_LEN, ce + 60) }
            }
            aiTags.push({ categoryId: ck.id, name: ck.name, start: snapped.start, end: snapped.end, source: 'ai', confidence: MIN_CONFIDENCE })
          }
          for (let s = 1; s < spans.length; s++) {
            if (spans[s].start <= clusterEnd + 25) {
              clusterEnd = Math.max(clusterEnd, spans[s].end)
              clusterDistinct.add(spans[s].kw)
            } else {
              pushCluster(clusterStart, clusterEnd, clusterDistinct)
              clusterStart = spans[s].start; clusterEnd = spans[s].end
              clusterDistinct = new Set<string>([spans[s].kw])
            }
          }
          pushCluster(clusterStart, clusterEnd, clusterDistinct)
        }
        if (kwCount > 0) debugLog.push(`\u251C \u5757${i}: ${kwCount}\u4E2A\u7C7B\u522B\u547D\u4E2D`)
      }

      // ── Phase 2: Embedding recall ──
      if (OOM_PROBE_ENABLE_EMBEDDING_RECALL && options?.enableEmbeddingRecall && options?.embeddingModel && options?.projectId) {
        const { embeddingModel, projectId } = options
        const aiCatIds = new Set(aiTags.map(t => t.categoryId))
        options.onProgress?.('Embedding recall...', 0, 0)

        const catEmbMap = new Map<string, { vector: number[]; textHash: string }>()
        const embR = await window.api.db.query('embeddings', "type = 'category' AND project_id = ? AND model_id = ?", [projectId, embeddingModel.modelId])
        if (embR.success && embR.data) {
          for (const row of embR.data as any[]) {
            catEmbMap.set(row.ref_id, { vector: unpackVector(row.vector), textHash: row.text_hash || '' })
          }
        }

        for (const cat of categories) {
          const text = [cat.name, cat.conditions, ...(cat.synonyms || []).slice(0, 10)].join('\n')
          const h = hashText(text)
          const existing = catEmbMap.get(cat.id)
          if (existing?.textHash === h) continue
          const r = await window.api.ai.embed({ baseUrl: embeddingModel.baseUrl, model: embeddingModel.modelId, prompt: text, apiKey: embeddingModel.apiKey })
          if (r.success && r.data) {
            catEmbMap.set(cat.id, { vector: r.data, textHash: h })
            await window.api.db.mutation('embeddings', 'insert', {
              id: `cat:${cat.id}`,
              type: 'category', ref_id: cat.id, project_id: projectId,
              model_id: embeddingModel.modelId, vector: packVector(r.data), text_hash: h,
            })
          }
        }

        const taggedIdx = new Set(aiTags.map(t => {
          for (const c of chunks) { if (t.start >= c.offset && t.start < c.offset + c.text.length) return c.index }
          return -1
        }))
        taggedIdx.delete(-1)
        const untagged = chunks.filter(c => !taggedIdx.has(c.index)).slice(0, MAX_EMBED_CHUNKS)

        for (let i = 0; i < untagged.length; i += EMBEDDING_BATCH_SIZE) {
          if (options.signal?.aborted) break
          const batch = untagged.slice(i, i + EMBEDDING_BATCH_SIZE)
          const embResults = await Promise.allSettled(
            batch.map(async chunk => {
              const r = await window.api.ai.embed({ baseUrl: embeddingModel.baseUrl, model: embeddingModel.modelId, prompt: chunk.text.slice(0, 500), apiKey: embeddingModel.apiKey })
              return { idx: chunk.index, vec: r.success ? r.data : null }
            })
          )
          for (const er of embResults) {
            if (er.status === 'rejected' || !er.value.vec) continue
            for (const [catId, entry] of catEmbMap) {
              if (aiCatIds.has(catId)) continue
              if (cosineSimilarity(er.value.vec, entry.vector) >= EMBED_SIMILARITY_THRESHOLD) {
                const cat = categories.find(c => c.id === catId)
                if (cat) {
                  const ck = chunks[er.value.idx]
                  // Embedding recall finds a relevant chunk, but using the FULL chunk
                  // as the tag span produces massive tags (1000-2000 chars). Instead,
                  // snap the chunk bounds to sentence boundaries and cap at MAX_TAG_LEN.
                  const snapped = snapToSentence(ck.offset, Math.min(ck.offset + ck.text.length, chapterText.length), chapterText)
                  const span = snapped.end - snapped.start
                  if (span > MAX_TAG_LEN) {
                    // Cap to MAX_TAG_LEN from the start
                    snapped.end = Math.min(snapped.start + MAX_TAG_LEN, chapterText.length)
                  }
                  if (snapped.end - snapped.start >= MIN_TAG_LEN) {
                    aiTags.push({ categoryId: catId, name: cat.name, start: snapped.start, end: snapped.end, source: 'ai', confidence: MIN_CONFIDENCE })
                    aiCatIds.add(catId)
                  }
                }
              }
            }
          }
        }
      }

      // Enforce minimum confidence across ALL paths (keyword fallback, embedding, LLM)
      const filteredTags = aiTags.filter(t => (t.confidence ?? 0) >= MIN_CONFIDENCE)
      const merged = mergeTags([...existingManualTags, ...filteredTags])
      const resolved = resolveOverlaps(merged)

      const allConfidences = filteredTags.map(t => t.confidence ?? 0)
      debugLog.push(`\u2514 \u7ED3\u679C: ${chunks.length}\u5757 \u2192 ${aiTags.length}\u4E2A\u539F\u59CB\u5339\u914D \u2192 ${filteredTags.length}\u4E2A\u8FC7\u6EE4(${aiTags.length - filteredTags.length}\u4F4E\u7F6E\u4FE1\u5220\u9664) \u2192 ${resolved.length}\u4E2A\u6700\u7EC8\u6807\u7B7E (${allConfidences.length ? (allConfidences.reduce((a,b)=>a+b,0)/allConfidences.length*100).toFixed(0) : 0}% avg, ${(Date.now()-t0)/1000}s)`)

      const m: ScanMetrics = {
        chunks: chunks.length,
        recallCount: resolved.length,
        classifyCalls: chunks.length,
        failedChunks,
        avgConfidence: allConfidences.length ? allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length : 0,
        durationMs: Date.now() - t0,
        debugLog,
      }
      setMetrics(m)

      await window.api.db.mutation('chapters', 'update', {
        scene_tags: JSON.stringify(resolved),
        scan_metrics: JSON.stringify(m),
      }, 'id = ?', [chapterId])

      // ── Adaptive threshold: non-blocking, don't delay the return ──
      if (options?.projectId) {
        adaptThresholds(options.projectId, categories, resolved, chapterText).catch(() => { /* non-critical */ })
      }

      return resolved
    } finally {
      setAnalyzing(false)
      setStatus('')
    }
  }, [])

  return { analyze, analyzing, status, metrics }
}
