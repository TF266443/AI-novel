import type { SceneTag } from '../stores/useProjectStore'

interface GoldLabel {
  id: string; chapterId: string; categoryId: string
  snippetText: string; label: 'positive' | 'negative'
  startPos: number; endPos: number
}

interface EvalEntry {
  goldId: string; categoryId: string
  positives: Array<{ start: number; end: number }>
  negatives: Array<{ start: number; end: number }>
}

interface CategoryEval {
  categoryId: string
  truePositives: number; falsePositives: number; falseNegatives: number
  precision: number; recall: number; f1: number
}

export interface EvalResult {
  runId: string
  totalGold: number
  totalTP: number; totalFP: number; totalFN: number
  precision: number; recall: number; f1: number
  perCategory: CategoryEval[]
  durationMs: number
}

/** Check if a tag overlaps with a gold label position range */
function overlaps(tag: { start: number; end: number }, gold: { start: number; end: number }): boolean {
  return tag.start < gold.end && tag.end > gold.start
}

/** Evaluate AI tags against gold labels */
export async function evaluateAll(
  projectId: string,
  chapterIds: string[],
  aiTagsByChapter: Map<string, SceneTag[]>,
): Promise<EvalResult> {
  const t0 = Date.now()

  // Load gold labels
  const glResult = await window.api.db.query('gold_labels', 'project_id = ?', [projectId])
  const goldLabels: GoldLabel[] = []
  if (glResult.success && glResult.data) {
    for (const gl of glResult.data as any[]) {
      goldLabels.push({
        id: gl.id, chapterId: gl.chapter_id, categoryId: gl.category_id,
        snippetText: gl.snippet_text || '', label: gl.label,
        startPos: gl.start_pos ?? 0, endPos: gl.end_pos ?? 0,
      })
    }
  }

  // Build per-category evaluation entries
  const byCategory = new Map<string, EvalEntry>()
  for (const gl of goldLabels) {
    if (!chapterIds.includes(gl.chapterId)) continue
    const entry = byCategory.get(gl.categoryId) || {
      goldId: gl.id, categoryId: gl.categoryId, positives: [], negatives: [],
    }
    if (gl.label === 'positive') {
      if (gl.startPos > 0 || gl.endPos > 0) {
        entry.positives.push({ start: gl.startPos, end: gl.endPos })
      } else {
        // Legacy gold: use full-text match
        entry.positives.push({ start: -1, end: Number.MAX_SAFE_INTEGER })
      }
    } else {
      if (gl.startPos > 0 || gl.endPos > 0) {
        entry.negatives.push({ start: gl.startPos, end: gl.endPos })
      }
    }
    byCategory.set(gl.categoryId, entry)
  }

  // Compute metrics per category
  let totalTP = 0, totalFP = 0, totalFN = 0
  const perCategory: CategoryEval[] = []

  for (const [catId, entry] of byCategory) {
    let tp = 0
    for (const [chId, tags] of aiTagsByChapter) {
      for (const tag of tags.filter(t => t.categoryId === catId && t.source === 'ai')) {
        const isTP = entry.positives.some(p => p.start === -1 || overlaps(tag, p))
        if (isTP) tp++
      }
    }

    const fpTags = new Set<string>()
    for (const [chId, tags] of aiTagsByChapter) {
      for (const tag of tags.filter(t => t.categoryId === catId && t.source === 'ai')) {
        if (!entry.positives.some(p => p.start === -1 || overlaps(tag, p))) {
          fpTags.add(`${chId}:${tag.start}`)
        }
      }
    }
    const fp = fpTags.size
    const fn = Math.max(0, entry.positives.length - tp)

    totalTP += tp; totalFP += fp; totalFN += fn

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0

    perCategory.push({ categoryId: catId, truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 })
  }

  const precision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 0
  const recall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 0
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0

  return {
    runId: `eval_${Date.now()}`,
    totalGold: goldLabels.length,
    totalTP, totalFP, totalFN,
    precision, recall, f1,
    perCategory,
    durationMs: Date.now() - t0,
  }
}

/** Persist evaluation result */
export async function saveEvalRun(projectId: string, modelId: string, templateJson: string, result: EvalResult): Promise<void> {
  await window.api.db.mutation('eval_runs', 'insert', {
    id: result.runId,
    project_id: projectId,
    model_id: modelId,
    template_snapshot: templateJson,
    total_gold: result.totalGold,
    true_positives: result.totalTP,
    false_positives: result.totalFP,
    false_negatives: result.totalFN,
    precision: Math.round(result.precision * 10000) / 10000,
    recall: Math.round(result.recall * 10000) / 10000,
    f1: Math.round(result.f1 * 10000) / 10000,
    per_category: JSON.stringify(result.perCategory),
  })
}
