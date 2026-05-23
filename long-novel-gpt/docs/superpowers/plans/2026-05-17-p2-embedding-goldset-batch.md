# P2: Embedding Recall + Gold-Set Evaluation + ScanPanel AI Batch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic embedding recall to catch LLM-missed scenes, build gold-set evaluation framework for accuracy measurement, and upgrade ScanPanel from keyword-only to full AI pipeline batch processing.

**Architecture:** Embeddings stored as base64-encoded Float32Array TEXT in SQLite (avoids IPC serialization issues), cosine similarity computed in-memory. Category embeddings pre-computed at template import; chunk embeddings computed during scan at 3 concurrency. Gold labels persisted in `gold_labels` table; evaluation runs in `eval_runs`. Shared `useScanAnalysis` hook eliminates code duplication between ScanStage and ScanPanel.

**Tech Stack:** TypeScript, React, better-sqlite3 (BLOB storage), Ollama/OpenAI-compatible embeddings API, Zustand

---

### Task 1: Add embeddings table to DB

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\main\services\db.ts` (after existing migrations, ~line 233)

- [ ] **Step 1: Add embeddings table creation SQL (TEXT for vector, base64-encoded)**

In `createTables()`, add after the `power_levels` table creation block (before the indexes):

```typescript
database.exec(`
  CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('category','chunk','gold_snippet')),
    ref_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    vector TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`)
```

- [ ] **Step 2: Add indexes for embeddings table**

Add alongside existing indexes:

```typescript
database.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_type_ref ON embeddings(type, ref_id)`)
database.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project_id)`)
```

- [ ] **Step 3: Add migration for existing databases**

At the bottom of `createTables()`, after the existing `scan_metrics` migration:

```typescript
try {
  database.exec(`CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    vector TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_type_ref ON embeddings(type, ref_id)`)
  database.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project_id)`)
} catch {
  // Table already exists
}
```

- [ ] **Step 4: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -5`
Expected: No new TS errors from this change.

---

### Task 2: Create embedding utility library

**Files:**
- Create: `D:\AI\long-novel-gpt\src\renderer\src\lib\embedding.ts`

- [ ] **Step 1: Write the embedding utility module**

```typescript
/**
 * Embedding vector utilities: cosine similarity, base64 encoding/decoding,
 * and in-memory nearest-neighbor search.
 */

/** Compute cosine similarity between two same-length float arrays */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/** Pack number[] into base64-encoded Float32Array for TEXT column storage */
export function packVector(v: number[]): string {
  const arr = new Float32Array(v)
  const bytes = new Uint8Array(arr.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Unpack base64 string back to number[] */
export function unpackVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return []
  // Try base64 Float32Array decode first
  try {
    const binary = atob(raw)
    if (binary.length % 4 === 0) {
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return Array.from(new Float32Array(bytes.buffer))
    }
  } catch {}
  // Fallback: JSON array
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

/**
 * Simple hash for text change detection.
 * Uses a fast non-crypto hash (djb2).
 */
export function hashText(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Find top-k most similar items from a pool by cosine similarity.
 * Returns items with similarity >= threshold, sorted descending.
 */
export interface EmbeddingEntry {
  id: string
  vector: number[]
}

export interface SimilarityResult {
  id: string
  similarity: number
}

export function findSimilar(
  query: number[],
  pool: EmbeddingEntry[],
  threshold: number,
  topK: number = 5
): SimilarityResult[] {
  const results: SimilarityResult[] = []
  for (const entry of pool) {
    const sim = cosineSimilarity(query, entry.vector)
    if (sim >= threshold) {
      results.push({ id: entry.id, similarity: sim })
    }
  }
  results.sort((a, b) => b.similarity - a.similarity)
  return results.slice(0, topK)
}
```

### Task 3: Enhance ai:embed for OpenAI-compatible endpoints

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\main\ipc\ai.ts` (replace the `ai:embed` handler, lines ~343-361)

- [ ] **Step 1: Rewrite ai:embed to support both Ollama and OpenAI-compatible embeddings**

Replace the existing `ai:embed` handler:

```typescript
ipcMain.handle('ai:embed', async (_, request: { baseUrl: string; model: string; prompt: string }) => {
  log.info(`AI embed: model=${request.model}, baseUrl=${request.baseUrl}`)
  try {
    const isOllama = request.baseUrl.includes('localhost:11434') || request.baseUrl.includes('127.0.0.1:11434')

    let embedding: number[]

    if (isOllama) {
      // Ollama native embeddings endpoint
      const embedBase = request.baseUrl.replace(/\/v1\/?$/, '')
      const response = await fetch(`${embedBase}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: request.model, prompt: request.prompt }),
      })
      if (!response.ok) throw new Error(`Ollama embedding API returned ${response.status}`)
      const data = await response.json()
      embedding = data.embedding as number[]
    } else {
      // OpenAI-compatible embeddings endpoint
      const url = `${request.baseUrl}/embeddings`
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (request.apiKey) {
        headers['Authorization'] = `Bearer ${request.apiKey}`
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: request.model, input: request.prompt }),
      })
      if (!response.ok) throw new Error(`OpenAI embedding API returned ${response.status}`)
      const data = await response.json()
      embedding = data.data?.[0]?.embedding
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Unexpected embedding response format')
      }
    }

    return { success: true, data: embedding }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})
```

- [ ] **Step 2: Update preload signature to include optional apiKey in embed request**

Modify `D:\AI\long-novel-gpt\src\preload\index.ts` line ~38, the `embed` method:

```typescript
embed: (request: { baseUrl: string; model: string; prompt: string; apiKey?: string }) =>
  ipcRenderer.invoke('ai:embed', request),
```

- [ ] **Step 3: Update type declaration**

Modify `D:\AI\long-novel-gpt\src\renderer\src\env.d.ts`, add `apiKey?: string` to the embed request type:

In the `AiAPI` interface, update the `embed` signature:
```typescript
embed: (request: { baseUrl: string; model: string; prompt: string; apiKey?: string }) => Promise<{ success: boolean; data: number[]; error?: string }>;
```

- [ ] **Step 4: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`
Expected: No new TS errors.

---

### Task 4: Pre-compute category embeddings on template import

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\pages\TemplatesPage.tsx` (after `handleImport` saves the template, ~line 90)

- [ ] **Step 1: Add category embedding pre-computation after template import**

After the `await window.api.db.mutation('templates', 'insert', ...)` call (and before `setIsImportModalOpen(false)`), add:

```typescript
// Pre-compute category embeddings if an embedding model is configured
try {
  const modelsResult = await window.api.db.query('models')
  if (modelsResult.success && modelsResult.data) {
    const embedModel = (modelsResult.data as any[]).find(
      (m: any) => m.tier === 'embed' || m.model_id?.toLowerCase().includes('embed')
    )
    if (embedModel && embedModel.base_url && embedModel.model_id) {
      const categories = identifyTemplate.categories as Array<{
        id: string; name: string; conditions: string; synonyms?: string[]
      }>
      for (const cat of categories) {
        const textToEmbed = [
          cat.name,
          cat.conditions,
          ...(cat.synonyms || []).slice(0, 10)
        ].join('\n')
        const embedResult = await window.api.ai.embed({
          baseUrl: embedModel.base_url,
          model: embedModel.model_id,
          prompt: textToEmbed,
        })
        if (embedResult.success && embedResult.data) {
          const { hashText, packVector } = await import('../../lib/embedding')
          await window.api.db.mutation('embeddings', 'insert', {
            id: `category:${cat.id}`,
            type: 'category',
            ref_id: cat.id,
            project_id: '', // template-level, no project yet
            model_id: embedModel.model_id,
            vector: packVector(embedResult.data),
            text_hash: hashText(textToEmbed),
          })
        }
      }
    }
  }
} catch (err) {
  console.warn('Failed to pre-compute category embeddings:', err)
  // Non-fatal — embeddings can be computed later during scan
}
```

`packVector` returns a base64 string, which passes cleanly through IPC. No Buffer/ArrayBuffer conversion needed.

- [ ] **Step 2: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 5: Add embedding recall post-filter to ScanStage handleAnalyze

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\components\stages\scan\ScanStage.tsx`
- Create: None (uses embedding.ts from Task 2)

- [ ] **Step 1: Import embedding utilities at top of ScanStage**

Add import after existing imports:
```typescript
import { cosineSimilarity, packVector, unpackVector, findSimilar, hashText } from '../../../lib/embedding'
```

- [ ] **Step 2: Add helper to load category embeddings from DB**

Add this function inside `ScanStage` component, before `handleAnalyze`:

```typescript
async function loadCategoryEmbeddings(
  projectId: string,
  modelId: string
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>()
  try {
    const r = await window.api.db.query(
      'embeddings',
      "type = 'category' AND (project_id = ? OR project_id = '') AND model_id = ?",
      [projectId, modelId]
    )
    if (r.success && r.data) {
      for (const row of r.data as any[]) {
        map.set(row.ref_id, unpackVector(row.vector))
      }
    }
  } catch (err) {
    console.warn('Failed to load category embeddings:', err)
  }
  return map
}
```

- [ ] **Step 3: Add embedding recall post-filter in handleAnalyze**

After the chunk classification loop completes and all AI tags are collected, add a new block before deduplication (after line ~370, before `setLastMetrics`):

```typescript
// --- Embedding recall post-filter ---
// Compute chunk embeddings and find semantically similar but LLM-missed categories
const aiCategoryIds = new Set(aiTags.map(t => t.categoryId))
const embedModel = models.find(m => m.modelId?.toLowerCase().includes('embed'))
if (embedModel && categories.length > 0 && chunkResults.length > 0) {
  setAnalysisStatus('Embedding recall...')
  const catEmbeddings = await loadCategoryEmbeddings(currentProject!.id, embedModel.modelId!)

  // If no pre-computed embeddings, compute them now
  if (catEmbeddings.size === 0) {
    setAnalysisStatus('Computing category embeddings...')
    for (const cat of categories) {
      const textToEmbed = [cat.name, cat.conditions, ...(cat.synonyms || []).slice(0, 10)].join('\n')
      const r = await window.api.ai.embed({
        baseUrl: embedModel.baseUrl,
        model: embedModel.modelId!,
        prompt: textToEmbed,
        apiKey: embedModel.apiKey,
      })
      if (r.success && r.data) {
        catEmbeddings.set(cat.id, r.data)
        // Persist for future use
        await window.api.db.mutation('embeddings', 'insert', {
          id: `category:${cat.id}`,
          type: 'category',
          ref_id: cat.id,
          project_id: currentProject!.id,
          model_id: embedModel.modelId!,
          vector: packVector(r.data),
          text_hash: hashText(textToEmbed),
        })
      }
    }
  }

  // Compute chunk embeddings and find recall candidates
  const chunkEmbedRequests = chunkResults
    .filter(cr => cr.result.status === 'fulfilled' && cr.result.value)
    .slice(0, 10) // Limit to first 10 chunks for embedding cost control

  const embedConcurrency = 3
  for (let i = 0; i < chunkEmbedRequests.length; i += embedConcurrency) {
    if (abortRef.current) break
    const batch = chunkEmbedRequests.slice(i, i + embedConcurrency)
    const embedResults = await Promise.allSettled(
      batch.map(async cr => {
        const chunk = chunks[cr.chunkIndex]
        const r = await window.api.ai.embed({
          baseUrl: embedModel.baseUrl,
          model: embedModel.modelId!,
          prompt: chunk.text.slice(0, 500), // First 500 chars for cost
          apiKey: embedModel.apiKey,
        })
        return { chunkIndex: cr.chunkIndex, embedding: r.success ? r.data : null }
      })
    )

    for (const er of embedResults) {
      if (er.status === 'rejected' || !er.value.embedding) continue
      const { chunkIndex, embedding } = er.value
      const chunk = chunks[chunkIndex]

      // Find similar categories not already hit by LLM
      for (const [catId, catVec] of catEmbeddings) {
        if (aiCategoryIds.has(catId)) continue // Already found by LLM
        const sim = cosineSimilarity(embedding, catVec)
        if (sim >= 0.70) {
          const cat = categories.find(c => c.id === catId)
          if (cat) {
            // Add as low-confidence recall tag (mark entire chunk)
            aiTags.push({
              categoryId: catId,
              name: cat.name,
              start: chunk.offset,
              end: Math.min(chunk.offset + chunk.text.length, currentChapter!.originalText.length),
              source: 'ai' as const,
              confidence: 0.4, // Embedding recall, lower confidence
            })
            aiCategoryIds.add(catId)
          }
        }
      }
    }
  }
  setAnalysisStatus('')
}

// Existing dedupe and merge...
const merged = dedupeTags([...manualTags, ...aiTags])
```

- [ ] **Step 4: Add embedModel lookup to model selection**

The `models` state already contains all models. We filter for an embedding model by checking `modelId.includes('embed')` or `tier === 'embed'`. The existing model loading in the useEffect at line 181 already loads all models from the `models` table.

- [ ] **Step 5: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 6: Add gold_labels and eval_runs tables

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\main\services\db.ts` (after embeddings table creation)

- [ ] **Step 1: Add gold_labels table creation**

In `createTables()`, after the embeddings table:

```typescript
database.exec(`
  CREATE TABLE IF NOT EXISTS gold_labels (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL,
    snippet_text TEXT NOT NULL,
    label TEXT NOT NULL CHECK(label IN ('positive','negative')),
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now'))
  )
`)
database.exec(`CREATE INDEX IF NOT EXISTS idx_gold_labels_project ON gold_labels(project_id)`)
database.exec(`CREATE INDEX IF NOT EXISTS idx_gold_labels_chapter ON gold_labels(chapter_id)`)
```

- [ ] **Step 2: Add eval_runs table creation**

```typescript
database.exec(`
  CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    template_snapshot TEXT NOT NULL,
    total_gold INTEGER DEFAULT 0,
    true_positives INTEGER DEFAULT 0,
    false_positives INTEGER DEFAULT 0,
    false_negatives INTEGER DEFAULT 0,
    precision REAL DEFAULT 0,
    recall REAL DEFAULT 0,
    f1 REAL DEFAULT 0,
    per_category TEXT,
    threshold_used REAL DEFAULT 0.7,
    duration_ms INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`)
```

- [ ] **Step 3: Add migrations for existing databases**

After existing migrations:

```typescript
try { database.exec(`CREATE TABLE IF NOT EXISTS gold_labels (...)`) } catch {}
try { database.exec(`CREATE INDEX IF NOT EXISTS idx_gold_labels_project ON gold_labels(project_id)`) } catch {}
try { database.exec(`CREATE INDEX IF NOT EXISTS idx_gold_labels_chapter ON gold_labels(chapter_id)`) } catch {}
try { database.exec(`CREATE TABLE IF NOT EXISTS eval_runs (...)`) } catch {}
```

Note: Repeat the full CREATE TABLE statements. Keep column definitions consistent with Step 1-2.

- [ ] **Step 4: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 7: Create evaluation computation library

**Files:**
- Create: `D:\AI\long-novel-gpt\src\renderer\src\lib\evaluation.ts`

- [ ] **Step 1: Write evaluation utility module**

```typescript
/**
 * Gold-set evaluation: precision, recall, F1 computation
 * per category and overall.
 */

export interface GoldLabel {
  id: string
  chapterId: string
  categoryId: string
  snippetText: string
  label: 'positive' | 'negative'
}

export interface PredictedTag {
  categoryId: string
  start: number
  end: number
  confidence?: number
}

export interface CategoryMetrics {
  categoryId: string
  categoryName: string
  truePositives: number
  falsePositives: number
  falseNegatives: number
  precision: number
  recall: number
  f1: number
}

export interface EvalResult {
  totalGold: number
  truePositives: number
  falsePositives: number
  falseNegatives: number
  precision: number
  recall: number
  f1: number
  perCategory: CategoryMetrics[]
}

/**
 * Check if a predicted tag overlaps with a gold label's snippet range.
 * Positive gold labels mean "this range should be tagged".
 */
function overlaps(
  pred: PredictedTag,
  goldStart: number,
  goldEnd: number
): boolean {
  return pred.start < goldEnd && pred.end > goldStart
}

/**
 * Compute precision/recall/F1 for a single category.
 */
export function evaluateCategory(
  predicted: PredictedTag[],
  goldPositives: Array<{ start: number; end: number }>,
  goldNegatives: Array<{ start: number; end: number }>  // Not used for metrics, but stored
): { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number } {
  let tp = 0, fp = 0

  // For each prediction, check if it overlaps any gold positive
  const matchedGold = new Set<number>()
  for (const pred of predicted) {
    let matched = false
    for (let i = 0; i < goldPositives.length; i++) {
      if (matchedGold.has(i)) continue
      if (overlaps(pred, goldPositives[i].start, goldPositives[i].end)) {
        tp++
        matchedGold.add(i)
        matched = true
        break
      }
    }
    if (!matched) fp++
  }

  const fn = goldPositives.length - matchedGold.size
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0

  return { tp, fp, fn, precision, recall, f1 }
}

/**
 * Compute full evaluation across all categories.
 */
export function evaluateAll(
  predictionsByCategory: Map<string, PredictedTag[]>,
  goldLabels: GoldLabel[],
  categoryNames: Map<string, string>
): EvalResult {
  const goldByCategory = new Map<string, { positives: Array<{ start: number; end: number }>; negatives: Array<{ start: number; end: number }> }>()

  for (const gl of goldLabels) {
    let entry = goldByCategory.get(gl.categoryId)
    if (!entry) {
      entry = { positives: [], negatives: [] }
      goldByCategory.set(gl.categoryId, entry)
    }
    // Parse start/end from snippet position (stored as part of gold label context)
    // For simplicity, treat each gold label snippet as a single annotation point
    if (gl.label === 'positive') {
      entry.positives.push({ start: 0, end: 0 }) // Position-agnostic for now
    }
  }

  let totalTp = 0, totalFp = 0, totalFn = 0
  const perCategory: CategoryMetrics[] = []

  for (const [catId, preds] of predictionsByCategory) {
    const gold = goldByCategory.get(catId) || { positives: [], negatives: [] }
    const { tp, fp, fn, precision, recall, f1 } = evaluateCategory(preds, gold.positives, gold.negatives)
    totalTp += tp
    totalFp += fp
    totalFn += fn
    perCategory.push({
      categoryId: catId,
      categoryName: categoryNames.get(catId) || catId,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision,
      recall,
      f1,
    })
  }

  // Categories with gold but no predictions: all FN
  for (const [catId, gold] of goldByCategory) {
    if (!predictionsByCategory.has(catId)) {
      totalFn += gold.positives.length
      perCategory.push({
        categoryId: catId,
        categoryName: categoryNames.get(catId) || catId,
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: gold.positives.length,
        precision: 0,
        recall: 0,
        f1: 0,
      })
    }
  }

  const precision = totalTp + totalFp > 0 ? totalTp / (totalTp + totalFp) : 0
  const recall = totalTp + totalFn > 0 ? totalTp / (totalTp + totalFn) : 0
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0

  return {
    totalGold: goldLabels.length,
    truePositives: totalTp,
    falsePositives: totalFp,
    falseNegatives: totalFn,
    precision,
    recall,
    f1,
    perCategory,
  }
}
```

---

### Task 8: Add gold label right-click menu to ScanStage tags

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\components\stages\scan\ScanStage.tsx`

- [ ] **Step 1: Add gold label state and handlers**

Add state near other useState declarations (after line ~170):
```typescript
const [contextMenu, setContextMenu] = useState<{
  tagIndex: number
  x: number
  y: number
} | null>(null)
```

- [ ] **Step 2: Add gold label persistence function**

Add after `persistExample`:
```typescript
async function saveGoldLabel(tag: SceneTag, label: 'positive' | 'negative') {
  if (!currentChapter || !currentProject) return
  const snippet = currentChapter.originalText.slice(tag.start, tag.end)
  const id = `gold:${currentChapter.id}:${tag.categoryId}:${tag.start}`
  await window.api.db.mutation('gold_labels', 'insert', {
    id,
    project_id: currentProject.id,
    chapter_id: currentChapter.id,
    category_id: tag.categoryId,
    snippet_text: snippet,
    label,
    source: tag.source === 'ai' ? 'manual' : 'auto_suggest',
  })
}

async function deleteGoldLabel(tag: SceneTag) {
  if (!currentChapter) return
  const id = `gold:${currentChapter.id}:${tag.categoryId}:${tag.start}`
  await window.api.db.mutation('gold_labels', 'delete', undefined, 'id = ?', [id])
}
```

- [ ] **Step 3: Modify tag pill rendering to support right-click**

In `renderText()`, modify the tag pill elements (the `<span>` that renders each tag) to add `onContextMenu`:

```tsx
onContextMenu={(e) => {
  e.preventDefault()
  setContextMenu({ tagIndex: idx, x: e.clientX, y: e.clientY })
}}
```

Also add gold label visual indicator: positive labels get a green dot, negative get red dot. Add a state to track which tags have gold labels:

```typescript
const [goldLabelMap, setGoldLabelMap] = useState<Map<string, 'positive' | 'negative'>>(new Map())

// Load gold labels on chapter change
useEffect(() => {
  if (!currentChapter || !currentProject) return
  window.api.db.query('gold_labels', 'chapter_id = ?', [currentChapter.id]).then(r => {
    if (r.success && r.data) {
      const map = new Map<string, 'positive' | 'negative'>()
      for (const gl of r.data as any[]) {
        map.set(`${gl.category_id}:${gl.snippet_text.slice(0, 20)}`, gl.label)
      }
      setGoldLabelMap(map)
    }
  })
}, [currentChapter?.id, currentProject?.id])
```

- [ ] **Step 4: Add context menu JSX**

Add at the end of the component's return JSX (before the closing root tag):

```tsx
{contextMenu && (
  <>
    <div
      className="fixed inset-0 z-40"
      onClick={() => setContextMenu(null)}
    />
    <div
      className="fixed z-50 bg-white border rounded-lg shadow-lg py-1 min-w-[160px]"
      style={{ left: contextMenu.x, top: contextMenu.y }}
    >
      <button
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-green-50 flex items-center gap-2"
        onClick={async () => {
          const tag = tags[contextMenu.tagIndex]
          await saveGoldLabel(tag, 'positive')
          setGoldLabelMap(prev => new Map(prev).set(`${tag.categoryId}:${tag.name}`, 'positive'))
          setContextMenu(null)
        }}
      >
        <span className="w-2 h-2 rounded-full bg-green-500" />
        确认正确 (Positive)
      </button>
      <button
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-red-50 flex items-center gap-2"
        onClick={async () => {
          const tag = tags[contextMenu.tagIndex]
          await saveGoldLabel(tag, 'negative')
          setGoldLabelMap(prev => new Map(prev).set(`${tag.categoryId}:${tag.name}`, 'negative'))
          setContextMenu(null)
        }}
      >
        <span className="w-2 h-2 rounded-full bg-red-500" />
        标记错误 (Negative)
      </button>
      <div className="border-t my-1" />
      <button
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 text-gray-500"
        onClick={async () => {
          const tag = tags[contextMenu.tagIndex]
          await deleteGoldLabel(tag)
          setGoldLabelMap(prev => {
            const next = new Map(prev)
            next.delete(`${tag.categoryId}:${tag.name}`)
            return next
          })
          setContextMenu(null)
        }}
      >
        取消标注
      </button>
    </div>
  </>
)}
```

- [ ] **Step 5: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 9: Create EvalTab component for ScanPanel

**Files:**
- Create: `D:\AI\long-novel-gpt\src\renderer\src\components\workbench\panels\EvalTab.tsx`

- [ ] **Step 1: Write EvalTab component**

```tsx
import { useState, useEffect } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { evaluateAll, type EvalResult } from '../../../lib/evaluation'

interface EvalTabProps {
  categories: Array<{ id: string; name: string }>
}

export default function EvalTab({ categories }: EvalTabProps) {
  const { chapters, currentProject } = useProjectStore()
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null)
  const [evalHistory, setEvalHistory] = useState<Array<{
    id: string; f1: number; created_at: string
  }>>([])
  const [isRunning, setIsRunning] = useState(false)
  const [selectedRuns, setSelectedRuns] = useState<string[]>([])

  // Load evaluation history
  useEffect(() => {
    if (!currentProject) return
    window.api.db.query(
      'eval_runs',
      'project_id = ? ORDER BY created_at DESC LIMIT 5',
      [currentProject.id]
    ).then(r => {
      if (r.success && r.data) {
        setEvalHistory((r.data as any[]).map((er: any) => ({
          id: er.id,
          f1: er.f1,
          created_at: er.created_at,
        })))
      }
    })
  }, [currentProject?.id, evalResult])

  const handleRunEval = async () => {
    if (!currentProject) return
    setIsRunning(true)
    try {
      // Load all gold labels for this project
      const glResult = await window.api.db.query(
        'gold_labels',
        'project_id = ?',
        [currentProject.id]
      )
      if (!glResult.success || !glResult.data || (glResult.data as any[]).length === 0) {
        setEvalResult(null)
        return
      }

      const goldLabels = (glResult.data as any[]).map((gl: any) => ({
        id: gl.id,
        chapterId: gl.chapter_id,
        categoryId: gl.category_id,
        snippetText: gl.snippet_text,
        label: gl.label,
      }))

      // Collect all AI predictions from all chapters
      const predictionsByCategory = new Map<string, Array<{
        categoryId: string; start: number; end: number; confidence?: number
      }>>()
      for (const ch of chapters) {
        for (const tag of ch.sceneTags) {
          if (tag.source !== 'ai') continue
          let preds = predictionsByCategory.get(tag.categoryId)
          if (!preds) {
            preds = []
            predictionsByCategory.set(tag.categoryId, preds)
          }
          preds.push({
            categoryId: tag.categoryId,
            start: tag.start,
            end: tag.end,
            confidence: tag.confidence,
          })
        }
      }

      const categoryNames = new Map(categories.map(c => [c.id, c.name]))
      const result = evaluateAll(predictionsByCategory, goldLabels, categoryNames)

      // Save eval run
      const id = `eval:${Date.now()}`
      await window.api.db.mutation('eval_runs', 'insert', {
        id,
        project_id: currentProject.id,
        model_id: '', // TODO: track which model was used
        template_snapshot: JSON.stringify({ categories }),
        total_gold: result.totalGold,
        true_positives: result.truePositives,
        false_positives: result.falsePositives,
        false_negatives: result.falseNegatives,
        precision: result.precision,
        recall: result.recall,
        f1: result.f1,
        per_category: JSON.stringify(result.perCategory),
        threshold_used: 0.7,
        duration_ms: 0,
      })

      setEvalResult(result)
    } catch (err) {
      console.error('Eval failed:', err)
    } finally {
      setIsRunning(false)
    }
  }

  const handleExport = () => {
    if (!evalResult) return
    const json = JSON.stringify(evalResult, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `eval-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const goldCount = chapters.reduce(
    (sum, ch) => sum + ch.sceneTags.filter(t => t.source === 'ai').length,
    0
  )

  if (goldCount === 0 && !evalResult) {
    return (
      <div className="p-3 text-xs text-gray-400">
        <p className="font-medium mb-1">评估</p>
        <p>暂无 AI 标记数据。先在中间面板运行 AI 分析，然后右键标记正确/错误。</p>
      </div>
    )
  }

  return (
    <div className="p-3 text-xs">
      <p className="font-medium mb-2">评估</p>

      {/* Gold count */}
      <p className="text-gray-500 mb-2">
        Gold 样本: {evalResult?.totalGold ?? '...'} 条
      </p>

      {/* Overall metrics */}
      {evalResult && (
        <div className="space-y-1 mb-3">
          <div className="flex justify-between">
            <span>Precision</span>
            <span className="font-mono">{(evalResult.precision * 100).toFixed(0)}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded h-1.5">
            <div className="bg-blue-500 h-1.5 rounded" style={{ width: `${evalResult.precision * 100}%` }} />
          </div>
          <div className="flex justify-between">
            <span>Recall</span>
            <span className="font-mono">{(evalResult.recall * 100).toFixed(0)}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded h-1.5">
            <div className="bg-green-500 h-1.5 rounded" style={{ width: `${evalResult.recall * 100}%` }} />
          </div>
          <div className="flex justify-between font-semibold">
            <span>F1</span>
            <span className="font-mono">{(evalResult.f1 * 100).toFixed(0)}%</span>
          </div>
        </div>
      )}

      {/* Per category */}
      {evalResult && evalResult.perCategory.length > 0 && (
        <div className="mb-3">
          <p className="text-gray-500 mb-1">按类别:</p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {evalResult.perCategory
              .sort((a, b) => b.f1 - a.f1)
              .map(cat => (
                <div key={cat.categoryId} className="flex justify-between items-center text-[11px]">
                  <span className="truncate flex-1 mr-1">{cat.categoryName}</span>
                  <span className="font-mono">
                    P{(cat.precision * 100).toFixed(0)} R{(cat.recall * 100).toFixed(0)}
                    {cat.f1 < 0.5 && <span className="text-amber-500 ml-0.5">⚠</span>}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* History / F1 trend */}
      {evalHistory.length > 1 && (
        <div className="mb-3">
          <p className="text-gray-500 mb-1">F1 趋势:</p>
          <div className="flex items-end gap-1 h-8">
            {evalHistory.slice(0, 5).reverse().map((run, i) => (
              <div
                key={run.id}
                className="flex-1 bg-blue-400 rounded-t"
                style={{ height: `${run.f1 * 100}%` }}
                title={`${run.created_at}: F1=${(run.f1 * 100).toFixed(0)}%`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          className="flex-1 px-2 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600 disabled:opacity-50"
          onClick={handleRunEval}
          disabled={isRunning}
        >
          {isRunning ? '评估中...' : '运行评估'}
        </button>
        {evalResult && (
          <button
            className="px-2 py-1 border rounded text-xs hover:bg-gray-50"
            onClick={handleExport}
          >
            导出报告
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 10: Wire EvalTab into ScanPanel with tab switching

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\components\workbench\panels\ScanPanel.tsx`

- [ ] **Step 1: Add tab state and import**

Add import and state:
```typescript
import EvalTab from './EvalTab'

// Inside ScanPanel component, add:
const [activeTab, setActiveTab] = useState<'scan' | 'eval'>('scan')
```

- [ ] **Step 2: Add tab bar at top of ScanPanel JSX**

Insert at the top of the return JSX (after the root div):

```tsx
{/* Tab bar */}
<div className="flex border-b">
  <button
    className={`flex-1 py-1.5 text-xs font-medium ${activeTab === 'scan' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}
    onClick={() => setActiveTab('scan')}
  >
    标记
  </button>
  <button
    className={`flex-1 py-1.5 text-xs font-medium ${activeTab === 'eval' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}
    onClick={() => setActiveTab('eval')}
  >
    评估
  </button>
</div>

{activeTab === 'scan' ? (
  <>
    {/* Existing ScanPanel content (the old JSX from heading down to buttons) */}
    ...
  </>
) : (
  <EvalTab categories={categories} />
)}
```

- [ ] **Step 3: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 11: Create shared useScanAnalysis hook

**Files:**
- Create: `D:\AI\long-novel-gpt\src\renderer\src\hooks\useScanAnalysis.ts`

- [ ] **Step 1: Write the shared analysis hook**

```typescript
import { useState, useRef, useCallback } from 'react'
import { useProjectStore } from '../stores/useProjectStore'

// Re-use types from ScanStage
interface Chunk { text: string; offset: number; index: number }
interface SceneTag {
  categoryId: string; name: string; start: number; end: number
  source: 'ai' | 'manual'; confidence?: number
}
interface Category {
  id: string; name: string; conditions: string
  synonyms?: string[]; examples?: Array<{ text: string; label: string; categoryId?: string }>
}
interface ScanMetrics {
  chunks: number; recallCount: number; classifyCalls: number
  failedChunks: Array<{ chunkIndex: number; reason: string }>
  avgConfidence: number; durationMs: number
}

const CHUNK_SIZE = 1000
const CHUNK_OVERLAP = 200

function splitIntoChunks(text: string): Chunk[] {
  const chunks: Chunk[] = []
  let offset = 0, index = 0
  while (offset < text.length) {
    let end = Math.min(offset + CHUNK_SIZE, text.length)
    // Smart boundary: backtrack to sentence punctuation
    if (end < text.length) {
      const searchStart = Math.max(offset, end - 100)
      const slice = text.slice(searchStart, end)
      const match = slice.match(/[。！？\n](?=[^。！？\n]*$)/)
      if (match && match.index !== undefined) {
        end = searchStart + match.index + 1
      }
    }
    chunks.push({ text: text.slice(offset, end), offset, index })
    offset = end - CHUNK_OVERLAP
    index++
  }
  return chunks
}

function locateEvidence(chunk: Chunk, evidence: string): { start: number; end: number } | null {
  const idx = chunk.text.indexOf(evidence)
  if (idx !== -1) return { start: chunk.offset + idx, end: chunk.offset + idx + evidence.length }
  // Whitespace-fuzzy fallback
  const normalized = evidence.replace(/\s+/g, '')
  if (normalized.length >= 4) {
    const chunkNorm = chunk.text.replace(/\s+/g, '')
    const ni = chunkNorm.indexOf(normalized)
    if (ni !== -1) {
      // Approximate position
      return { start: chunk.offset + ni, end: chunk.offset + ni + evidence.length }
    }
  }
  return null
}

function buildExtractionSchema() {
  return {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            categoryId: { type: 'string' },
            confidence: { type: 'number' },
            evidence: { type: 'string' },
          },
          required: ['categoryId', 'confidence', 'evidence'],
        },
      },
    },
    required: ['matches'],
  }
}

function dedupeTags(tags: SceneTag[]): SceneTag[] {
  const byCategory = new Map<string, SceneTag[]>()
  for (const t of tags) {
    const arr = byCategory.get(t.categoryId) || []
    arr.push(t)
    byCategory.set(t.categoryId, arr)
  }
  const merged: SceneTag[] = []
  for (const [, group] of byCategory) {
    group.sort((a, b) => a.start - b.start)
    let current = { ...group[0] }
    for (let i = 1; i < group.length; i++) {
      const next = group[i]
      if (next.start <= current.end + 10) {
        current.end = Math.max(current.end, next.end)
        current.confidence = Math.max(current.confidence ?? 0, next.confidence ?? 0)
        if (next.source === 'ai') current.source = 'ai'
      } else {
        merged.push(current)
        current = { ...next }
      }
    }
    merged.push(current)
  }
  return merged.sort((a, b) => a.start - b.start)
}

function buildCatalog(categories: Category[]): string {
  return categories.map(cat => {
    const keywords = cat.synonyms?.slice(0, 16).join('、') || ''
    return `id="${cat.id}" | 名称="${cat.name}" | 描述：${cat.conditions}${keywords ? ` | 关键词/同义：${keywords}` : ''}`
  }).join('\n')
}

function buildFewShot(categories: Category[]): string {
  const lines: string[] = []
  for (const cat of categories) {
    if (!cat.examples) continue
    const positives = cat.examples.filter(e => e.label === 'positive').slice(0, 3)
    const negatives = cat.examples.filter(e => e.label === 'negative').slice(0, 3)
    for (const p of positives) {
      lines.push(`✓ 正例（categoryId="${cat.id}"）：${p.text.slice(0, 80)}`)
      if (lines.length >= 12) break
    }
    for (const n of negatives) {
      lines.push(`✗ 反例（不要标为 ${cat.id}）：${n.text.slice(0, 80)}`)
      if (lines.length >= 12) break
    }
    if (lines.length >= 12) break
  }
  return lines.join('\n')
}

export interface ScanAnalysisOptions {
  onProgress?: (status: string, done: number, total: number) => void
  signal?: AbortSignal
}

export function useScanAnalysis() {
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisStatus, setAnalysisStatus] = useState('')
  const [lastMetrics, setLastMetrics] = useState<ScanMetrics | null>(null)

  const analyze = useCallback(async (
    chapterText: string,
    chapterId: string,
    categories: Category[],
    modelConfig: { baseUrl: string; modelId: string; apiKey: string },
    existingManualTags: SceneTag[],
    options?: ScanAnalysisOptions
  ): Promise<SceneTag[]> => {
    setIsAnalyzing(true)
    setAnalysisStatus('')
    const startTime = Date.now()

    try {
      // Chunk text
      const chunks = splitIntoChunks(chapterText)
      const catalog = buildCatalog(categories)
      const fewShotBlock = buildFewShot(categories)
      const jsonSchema = buildExtractionSchema()

      const systemPrompt = `你是一个小说场景识别助手。根据场景清单判断文本片段属于哪些场景。
输出 JSON：{"matches":[{"categoryId":"分类ID","confidence":0.0-1.0,"evidence":"原文证据"}]}
规则：
- evidence 必须是从原文中连续引用的文本，20-120字
- confidence < 0.5 的匹配不要输出
- 每个场景最多匹配一次
${fewShotBlock ? `\n标注示例：\n${fewShotBlock}` : ''}`

      const aiTags: SceneTag[] = []
      const failedChunks: Array<{ chunkIndex: number; reason: string }> = []
      const confidenceScores: number[] = []
      const concurrency = 3

      // Classify each chunk
      for (let i = 0; i < chunks.length; i += concurrency) {
        if (options?.signal?.aborted) break
        const batch = chunks.slice(i, i + concurrency)
        options?.onProgress?.(`分类中... ${i + 1}/${chunks.length}`, i, chunks.length)

        const results = await Promise.allSettled(
          batch.map(async chunk => {
            const userPrompt = `场景清单：\n${catalog}\n\n小说文本片段（offset=${chunk.offset}）：\n${chunk.text}`
            const r = await window.api.ai.classify({
              baseUrl: modelConfig.baseUrl,
              modelId: modelConfig.modelId,
              apiKey: modelConfig.apiKey,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              jsonSchema,
              schemaName: 'scene_extraction',
              maxTokens: 1500,
            })
            return { chunk, result: r }
          })
        )

        for (const sr of results) {
          if (sr.status === 'rejected') {
            failedChunks.push({ chunkIndex: chunks.indexOf(batch[results.indexOf(sr)]), reason: String(sr.reason) })
            continue
          }
          const { chunk, result } = sr.value
          if (!result.success || !result.data?.matches) {
            failedChunks.push({ chunkIndex: chunk.index, reason: result.error || 'No matches' })
            // Keyword fallback
            for (const cat of categories) {
              const kws = (cat.synonyms || []).slice(0, 16)
              const hits = kws.filter(kw => chunk.text.includes(kw))
              if (hits.length >= 2) {
                aiTags.push({
                  categoryId: cat.id, name: cat.name,
                  start: chunk.offset, end: chunk.offset + chunk.text.length,
                  source: 'ai', confidence: 0.3,
                })
              }
            }
            continue
          }
          for (const m of result.data.matches) {
            if (m.confidence < 0.5) continue
            const cat = categories.find(c => c.id === m.categoryId)
            if (!cat) continue
            const pos = locateEvidence(chunk, m.evidence)
            if (pos) {
              aiTags.push({
                categoryId: m.categoryId, name: cat.name,
                start: pos.start, end: pos.end,
                source: 'ai', confidence: m.confidence,
              })
              confidenceScores.push(m.confidence)
            }
          }
        }
      }

      const merged = dedupeTags([...existingManualTags, ...aiTags])
      const avgConfidence = confidenceScores.length > 0
        ? confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length
        : 0

      const metrics: ScanMetrics = {
        chunks: chunks.length,
        recallCount: merged.length,
        classifyCalls: chunks.length,
        failedChunks,
        avgConfidence,
        durationMs: Date.now() - startTime,
      }
      setLastMetrics(metrics)

      // Persist tags and metrics
      await window.api.db.mutation('chapters', 'update', {
        scene_tags: JSON.stringify(merged),
        scan_metrics: JSON.stringify(metrics),
      }, 'id = ?', [chapterId])

      return merged
    } finally {
      setIsAnalyzing(false)
      setAnalysisStatus('')
    }
  }, [])

  const abort = useCallback(() => {
    // Signal-based abort
  }, [])

  return { analyze, abort, isAnalyzing, analysisStatus, lastMetrics }
}
```

- [ ] **Step 2: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 12: Refactor ScanStage to use shared useScanAnalysis hook

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\components\stages\scan\ScanStage.tsx`

- [ ] **Step 1: Import shared hook**

```typescript
import { useScanAnalysis } from '../../../hooks/useScanAnalysis'
```

- [ ] **Step 2: Replace inline analysis logic with hook call**

Delete the module-level helper functions that are now in the hook: `splitIntoChunks`, `locateEvidence`, `buildExtractionSchema`, `dedupeTags`, `buildSceneDesc`, `extractKeywords`. (They're all in `useScanAnalysis.ts` now, but `extractKeywords` and `buildSceneDesc` are still used locally — keep those.)

Replace `handleAnalyze` (lines ~208-405) with a simpler version that delegates to the hook:

```typescript
const { analyze, isAnalyzing, analysisStatus, lastMetrics } = useScanAnalysis()

const handleAnalyze = async () => {
  if (!currentChapter || !selModelId || categories.length === 0 || isAnalyzing) return
  abortRef.current = false

  const model = models.find(m => m.id === selModelId)
  if (!model) return

  const manualTags = currentChapter.sceneTags.filter(t => t.source === 'manual')

  const merged = await analyze(
    currentChapter.originalText,
    currentChapter.id,
    categories,
    { baseUrl: model.baseUrl, modelId: model.modelId, apiKey: model.apiKey },
    manualTags,
    {
      onProgress: (status) => setAnalysisStatus?.(status),
    }
  )

  updateChapterSceneTags(currentChapter.id, merged)
}
```

Remove the duplicate state declarations for `isAnalyzing`, `analysisStatus`, `lastMetrics` since they now come from the hook.

- [ ] **Step 3: Remove module-level duplicate functions**

Delete from ScanStage.tsx:
- `splitIntoChunks` (lines 63-81)
- `locateEvidence` (lines 85-108)
- `buildExtractionSchema` (lines 110-133)
- `dedupeTags` (lines 135-156)
- `buildSceneDesc` if used only in catalog building (check if used elsewhere)

Keep `extractKeywords` if still used for keyword fallback display.

- [ ] **Step 4: Keep synonym expansion and few-shot logic**

The synonym expansion block (lines ~230-281) stays in ScanStage — it's UI-level lazy initialization. The few-shot construction (`buildFewShot`) is now in the hook.

- [ ] **Step 5: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`
Expect: cleanup needed. Fix any missing imports or duplicate declarations.

---

### Task 13: Rewrite ScanPanel batch scan with AI pipeline

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\components\workbench\panels\ScanPanel.tsx`

- [ ] **Step 1: Add imports and hook usage**

```typescript
import { useState, useRef, useEffect } from 'react'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useScanAnalysis } from '../../../hooks/useScanAnalysis'
import EvalTab from './EvalTab'

interface Cat { id: string; name: string; conditions: string; synonyms?: string[] }
```

- [ ] **Step 2: Replace keyword-based generateTags with AI pipeline**

Remove the old `extractKeywords` and `generateTags` module-level functions. Replace the `handleScanAll` function:

```typescript
const { analyze } = useScanAnalysis()

const handleScanAll = async () => {
  if (running || !currentProject) return
  setRunning(true)
  setPaused(false)
  runningRef.current = true
  pausedRef.current = false

  try {
    // Find an AI model to use
    const modelsResult = await window.api.db.query('models')
    const models = (modelsResult.success && modelsResult.data) ? (modelsResult.data as any[]) : []
    const aiModel = models.find((m: any) => m.tier === 'high' || m.tier === 'low')
    if (!aiModel || !aiModel.base_url || !aiModel.model_id) {
      setStatus('未找到可用的 AI 模型，请在设置中配置')
      return
    }

    // Get chapters without AI tags
    const toProcess = chapters.filter(ch => {
      const hasAiTags = ch.sceneTags.some(t => t.source === 'ai')
      return !hasAiTags && ch.status !== 'processing'
    })

    const total = toProcess.length
    let done = 0

    for (const ch of toProcess) {
      if (!runningRef.current) break

      // Wait if paused
      while (pausedRef.current && runningRef.current) {
        await new Promise(r => setTimeout(r, 500))
      }
      if (!runningRef.current) break

      setStatus(`AI 分析中... ${done + 1}/${total}: ${ch.title || `第${ch.chapterIndex + 1}章`}`)

      const manualTags = ch.sceneTags.filter(t => t.source === 'manual')

      try {
        const merged = await analyze(
          ch.originalText,
          ch.id,
          categories,
          {
            baseUrl: aiModel.base_url,
            modelId: aiModel.model_id,
            apiKey: aiModel.api_key,
          },
          manualTags,
          {
            onProgress: (s) => setStatus(`${s} — ${ch.title || `第${ch.chapterIndex + 1}章`}`),
          }
        )

        updateChapterSceneTags(ch.id, merged)
      } catch (err) {
        console.error(`Failed chapter ${ch.chapterIndex}:`, err)
      }

      done++
      setProgress(Math.round((done / total) * 100))
    }

    setStatus(done === total ? '全部完成' : `已处理 ${done}/${total}`)
  } finally {
    setRunning(false)
    setPaused(false)
    runningRef.current = false
    pausedRef.current = false
  }
}
```

- [ ] **Step 3: Add tab state and tab bar (from Task 10, if not already applied)**

```typescript
const [activeTab, setActiveTab] = useState<'scan' | 'eval'>('scan')
```

And wrap existing content in tab conditional:

```tsx
{activeTab === 'scan' ? (
  <> {/* existing scan content */} </>
) : (
  <EvalTab categories={categories} />
)}
```

- [ ] **Step 4: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 14: Integrate embedding recall into shared hook

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\hooks\useScanAnalysis.ts`

- [ ] **Step 1: Add embedding recall post-filter to the analyze function**

After the AI classification loop completes (after `for (const sr of results)` loop, before `dedupeTags`), add the embedding recall block from Task 5. The hook needs access to `models` and `projectId`. Accept these as additional parameters:

```typescript
export interface ScanAnalysisOptions {
  onProgress?: (status: string, done: number, total: number) => void
  signal?: AbortSignal
  enableEmbeddingRecall?: boolean
  embeddingModel?: { baseUrl: string; modelId: string; apiKey?: string }
  projectId?: string
  categories?: Category[]  // Needed for embedding recall
}
```

Then in the analyze function, after the AI classification loop:

```typescript
// --- Embedding recall ---
if (options?.enableEmbeddingRecall && options?.embeddingModel && options?.projectId && options?.categories) {
  const { embeddingModel, projectId, categories: cats } = options
  const aiCategoryIds = new Set(aiTags.map(t => t.categoryId))

  // Load or compute category embeddings
  const catEmbeddings = await loadCategoryEmbeddings(projectId!, embeddingModel.modelId)

  if (catEmbeddings.size === 0) {
    onProgress?.('Computing category embeddings...', 0, 0)
    for (const cat of cats) {
      const textToEmbed = [cat.name, cat.conditions, ...(cat.synonyms || []).slice(0, 10)].join('\n')
      const r = await window.api.ai.embed({
        baseUrl: embeddingModel.baseUrl,
        model: embeddingModel.modelId,
        prompt: textToEmbed,
        apiKey: embeddingModel.apiKey,
      })
      if (r.success && r.data) {
        catEmbeddings.set(cat.id, r.data)
        await window.api.db.mutation('embeddings', 'insert', {
          id: `category:${cat.id}`,
          type: 'category',
          ref_id: cat.id,
          project_id: projectId,
          model_id: embeddingModel.modelId,
          vector: packVector(r.data),
          text_hash: hashText(textToEmbed),
        })
      }
    }
  }

  // Embed chunks and find recall candidates
  const chunksToEmbed = chunks.slice(0, 10)
  for (let i = 0; i < chunksToEmbed.length; i += 3) {
    const batch = chunksToEmbed.slice(i, i + 3)
    const embedResults = await Promise.allSettled(
      batch.map(async chunk => {
        const r = await window.api.ai.embed({
          baseUrl: embeddingModel.baseUrl,
          model: embeddingModel.modelId,
          prompt: chunk.text.slice(0, 500),
          apiKey: embeddingModel.apiKey,
        })
        return { chunkIndex: chunk.index, embedding: r.success ? r.data : null }
      })
    )

    for (const er of embedResults) {
      if (er.status === 'rejected' || !er.value.embedding) continue
      const { chunkIndex, embedding } = er.value
      for (const [catId, catVec] of catEmbeddings) {
        if (aiCategoryIds.has(catId)) continue
        const sim = cosineSimilarity(embedding, catVec)
        if (sim >= 0.70) {
          const cat = cats.find(c => c.id === catId)
          if (cat) {
            const chunk = chunks[chunkIndex]
            aiTags.push({
              categoryId: catId, name: cat.name,
              start: chunk.offset, end: Math.min(chunk.offset + chunk.text.length, chapterText.length),
              source: 'ai' as const, confidence: 0.4,
            })
            aiCategoryIds.add(catId)
          }
        }
      }
    }
  }
}

// ... then dedupeTags and persist as before
```

- [ ] **Step 2: Add helper function inside the hook module**

```typescript
async function loadCategoryEmbeddings(
  projectId: string,
  modelId: string
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>()
  try {
    const r = await window.api.db.query(
      'embeddings',
      "type = 'category' AND (project_id = ? OR project_id = '') AND model_id = ?",
      [projectId, modelId]
    )
    if (r.success && r.data) {
      for (const row of r.data as any[]) {
        map.set(row.ref_id, unpackVector(row.vector))
      }
    }
  } catch (err) {
    console.warn('Failed to load category embeddings:', err)
  }
  return map
}
```

- [ ] **Step 3: Verify**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -10`

---

### Task 15: Final integration and cleanup

**Files:**
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\components\stages\scan\ScanStage.tsx`
- Modify: `D:\AI\long-novel-gpt\src\renderer\src\components\workbench\panels\ScanPanel.tsx`

- [ ] **Step 1: Enable embedding recall in ScanStage's analyze call**

In `handleAnalyze`, pass the embedding recall options:

```typescript
const embedModel = models.find(m => m.modelId?.toLowerCase().includes('embed'))
const merged = await analyze(
  currentChapter.originalText,
  currentChapter.id,
  categories,
  { baseUrl: model.baseUrl, modelId: model.modelId, apiKey: model.apiKey },
  manualTags,
  {
    onProgress: (status) => setAnalysisStatus(status),
    enableEmbeddingRecall: !!embedModel,
    embeddingModel: embedModel ? {
      baseUrl: embedModel.baseUrl,
      modelId: embedModel.modelId!,
      apiKey: embedModel.apiKey,
    } : undefined,
    projectId: currentProject?.id,
    categories,
  }
)
```

- [ ] **Step 2: Enable embedding recall in ScanPanel's batch scan**

In `handleScanAll`, pass the same options to `analyze()`.

- [ ] **Step 3: Remove any remaining dead code**

- Remove old `generateTags` from ScanPanel
- Remove old `extractKeywords` from ScanPanel (if unused)
- Ensure `useScanAnalysis` hook exports match what consumers use

- [ ] **Step 4: Full type check**

Run: `cd D:\AI\long-novel-gpt && npx tsc --noEmit --pretty false 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 5: Build check**

Run: `cd D:\AI\long-novel-gpt && npm run build 2>&1 | tail -10`
Expected: Build succeeds.
