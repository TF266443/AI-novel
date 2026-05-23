import { describe, test, expect } from 'vitest'

// RED phase: these imports will fail because functions are not yet exported
import {
  splitChunks,
  maskStatusLines,
  longestCommonSubstring,
  snapToSentence,
  shrinkChunk,
  parseConditions,
  mergeTags,
} from './useScanAnalysis'
import type { SceneTag } from '../stores/useProjectStore'

// ── splitChunks ──
describe('splitChunks', () => {
  test('returns empty array for empty text', () => {
    expect(splitChunks('')).toEqual([])
  })

  test('single chunk for text shorter than chunkSize', () => {
    const short = 'AB。CD。'
    const result = splitChunks(short)
    expect(result.length).toBe(1)
    expect(result[0].offset).toBe(0)
  })

  test('splits long text into multiple chunks', () => {
    const text = '短句。'.repeat(500) // ~1500 chars, exceeds CHUNK_SIZE=1000
    const result = splitChunks(text)
    expect(result.length).toBeGreaterThan(1)
  })

  test('each chunk offset matches accumulated length minus overlap', () => {
    const text = 'A。'.repeat(500) // ~1000 chars
    const result = splitChunks(text)
    for (let i = 0; i < result.length; i++) {
      expect(result[i].offset).toBeGreaterThanOrEqual(0)
      expect(result[i].offset).toBeLessThan(text.length)
    }
  })
})

// ── maskStatusLines ──
describe('maskStatusLines', () => {
  test('masks 境界 line with full-width spaces', () => {
    const input = '境界：七品凡胎·易筋境\n正常叙事文本。'
    const result = maskStatusLines(input)
    expect(result).not.toContain('七品凡胎')
    expect(result).toContain('正常叙事文本')
    // Length preserved
    expect(result.length).toBe(input.length)
  })

  test('masks 等级 line', () => {
    const input = '等级：筑基期\n开始修炼。'
    const result = maskStatusLines(input)
    expect(result).not.toContain('筑基期')
    expect(result).toContain('开始修炼')
  })

  test('leaves normal text unchanged', () => {
    const input = '陈墨推开房门，走进屋内。'
    const result = maskStatusLines(input)
    expect(result).toBe(input)
  })

  test('masks 【修为】 bracket format', () => {
    const input = '【修为】金丹初期\n他握紧拳头。'
    const result = maskStatusLines(input)
    expect(result).not.toContain('金丹初期')
    expect(result).toContain('他握紧拳头')
  })
})

// ── longestCommonSubstring ──
describe('longestCommonSubstring', () => {
  test('finds common substring', () => {
    const result = longestCommonSubstring('hello world', 'hello')
    expect(result).toBe('hello')
  })

  test('returns null for no match', () => {
    const result = longestCommonSubstring('abc', 'xyz')
    expect(result).toBeNull()
  })

  test('returns null for strings shorter than 5 matching chars', () => {
    const result = longestCommonSubstring('abcd', 'abcd')
    expect(result).toBeNull() // min 5
  })

  test('finds Chinese substring', () => {
    const result = longestCommonSubstring('陈墨推开房门走进屋内', '推开房门走进')
    expect(result).toBe('推开房门走进')
  })
})

// ── snapToSentence ──
describe('snapToSentence', () => {
  test('expands range to sentence boundaries', () => {
    const text = '前面句子。这段是目标文本的中间部分。后面句子。'
    const start = text.indexOf('目标文本')
    const end = start + '目标文本'.length
    const result = snapToSentence(start, end, text)
    // Should expand to full sentence boundaries
    expect(result.start).toBeLessThanOrEqual(start)
    expect(result.end).toBeGreaterThanOrEqual(end)
    expect(text[result.start - 1] || '。').toBe('。')
  })
})

// ── shrinkChunk ──
describe('shrinkChunk', () => {
  test('halves a large chunk at newline boundary', () => {
    const chunk = { text: 'A'.repeat(300) + '\n' + 'B'.repeat(300), offset: 0, index: 0 }
    const result = shrinkChunk(chunk)
    expect(result).not.toBeNull()
    expect(result!.text.length).toBeLessThan(chunk.text.length)
    expect(result!.offset).toBe(0)
  })

  test('returns null for small chunk', () => {
    const chunk = { text: 'short', offset: 0, index: 0 }
    const result = shrinkChunk(chunk)
    expect(result).toBeNull()
  })
})

// ── parseConditions ──
describe('parseConditions', () => {
  test('parses structured conditions with 识别点 and 关键词', () => {
    const input = '识别点：丝绸罗袜、足部亲密。关键词：罗袜、玉足、足交。'
    const result = parseConditions(input)
    expect(result.cues).toContain('丝绸罗袜')
    expect(result.cues).toContain('足部亲密')
    expect(result.keywords).toContain('罗袜')
    expect(result.keywords).toContain('玉足')
    expect(result.keywords).toContain('足交')
  })

  test('parses 独占规则', () => {
    const input = '关键词：双修。独占规则：仅限女主与陈墨。'
    const result = parseConditions(input)
    expect(result.keywords).toContain('双修')
    expect(result.exclusivity).toBe('仅限女主与陈墨')
  })

  test('returns empty for unlabeled text', () => {
    const result = parseConditions('普通描述文本')
    expect(result.keywords).toEqual([])
    expect(result.cues).toEqual([])
    expect(result.raw).toBe('普通描述文本')
  })

  test('parses 排除规则 as exclusivity', () => {
    const input = '排除规则：排除打斗场景。'
    const result = parseConditions(input)
    expect(result.exclusivity).toBe('排除打斗场景')
  })
})

// ── mergeTags ──
describe('mergeTags', () => {
  test('merges adjacent same-category tags within 10 chars', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'Test', start: 0, end: 50, source: 'ai', confidence: 0.8 },
      { categoryId: 'cat1', name: 'Test', start: 55, end: 100, source: 'ai', confidence: 0.9 },
    ]
    const result = mergeTags(tags)
    expect(result.length).toBe(1)
    expect(result[0].start).toBe(0)
    expect(result[0].end).toBe(100)
  })

  test('manual tags win over ai tags', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'Test', start: 0, end: 50, source: 'ai', confidence: 0.8 },
      { categoryId: 'cat1', name: 'Test', start: 0, end: 50, source: 'manual' },
    ]
    const result = mergeTags(tags)
    expect(result.length).toBe(1)
    expect(result[0].source).toBe('manual')
  })

  test('different categories are not merged', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 0, end: 50, source: 'ai' },
      { categoryId: 'cat2', name: 'B', start: 55, end: 100, source: 'ai' },
    ]
    const result = mergeTags(tags)
    expect(result.length).toBe(2)
  })

  test('maintains sort by start position', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 100, end: 150, source: 'ai' },
      { categoryId: 'cat2', name: 'B', start: 0, end: 50, source: 'ai' },
    ]
    const result = mergeTags(tags)
    expect(result[0].start).toBe(0)
    expect(result[1].start).toBe(100)
  })
})

// ── resolveOverlaps ──
import { resolveOverlaps } from './useScanAnalysis'

describe('resolveOverlaps', () => {
  test('keeps non-overlapping tags of different categories', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 0, end: 50, source: 'ai', confidence: 0.8 },
      { categoryId: 'cat2', name: 'B', start: 60, end: 100, source: 'ai', confidence: 0.7 },
    ]
    const result = resolveOverlaps(tags)
    expect(result).toHaveLength(2)
  })

  test('removes heavily overlapping lower-confidence tag', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 0, end: 100, source: 'ai', confidence: 0.9 },
      { categoryId: 'cat2', name: 'B', start: 10, end: 90, source: 'ai', confidence: 0.6 },
    ]
    const result = resolveOverlaps(tags)
    expect(result).toHaveLength(1)
    expect(result[0].categoryId).toBe('cat1')
  })

  test('manual tag wins over ai tag with higher confidence', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 0, end: 100, source: 'ai', confidence: 0.9 },
      { categoryId: 'cat2', name: 'B', start: 10, end: 90, source: 'manual' },
    ]
    const result = resolveOverlaps(tags)
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('manual')
  })

  test('corrected tag wins over ai tag', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 0, end: 100, source: 'ai', confidence: 0.9 },
      { categoryId: 'cat2', name: 'B', start: 10, end: 90, source: 'corrected', confidence: 0.5 },
    ]
    const result = resolveOverlaps(tags)
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('corrected')
  })

  test('keeps tags with minimal overlap under 50%', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 0, end: 100, source: 'ai', confidence: 0.8 },
      { categoryId: 'cat2', name: 'B', start: 80, end: 180, source: 'ai', confidence: 0.7 },
    ]
    // Overlap: 100-80=20, ratio = max(20/100, 20/100) = 20% < 50%
    const result = resolveOverlaps(tags)
    expect(result).toHaveLength(2)
  })

  test('replaces kept tag when incoming has higher confidence on >50% overlap', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 0, end: 100, source: 'ai', confidence: 0.6 },
      { categoryId: 'cat2', name: 'B', start: 30, end: 130, source: 'ai', confidence: 0.9 },
    ]
    // Overlap: 100-30=70, ratio = max(70/100, 70/100) = 70% > 50%
    // Second tag has higher confidence, should replace first
    const result = resolveOverlaps(tags)
    expect(result).toHaveLength(1)
    expect(result[0].categoryId).toBe('cat2')
  })

  test('returns empty array for no tags', () => {
    expect(resolveOverlaps([])).toEqual([])
  })

  test('returns single tag unchanged', () => {
    const tags: SceneTag[] = [
      { categoryId: 'cat1', name: 'A', start: 0, end: 50, source: 'ai', confidence: 0.8 },
    ]
    const result = resolveOverlaps(tags)
    expect(result).toHaveLength(1)
  })
})
