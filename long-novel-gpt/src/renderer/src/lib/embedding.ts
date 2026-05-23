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
