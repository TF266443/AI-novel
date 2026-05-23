import type { SceneTag } from '../stores/useProjectStore'

/**
 * Remap SceneTag positions from original text coordinates to rewritten text.
 *
 * Algorithm:
 * 1. Compute LCS (longest common subsequence) alignment between original and rewritten.
 * 2. From the DP traceback, build a character mapping: original[i] → rewritten[j].
 * 3. Apply the mapping to each tag's [start, end] range.
 * 4. Tags whose content was substantially lost in rewrite are dropped.
 */
export function remapSceneTags(
  original: string,
  rewritten: string,
  tags: SceneTag[],
): SceneTag[] {
  if (!original || !tags.length) return []

  // Build character mapping from DP-based LCS alignment
  const mapping = buildLCSMap(original, rewritten)
  if (!mapping) return []

  const result: SceneTag[] = []
  for (const tag of tags) {
    if (tag.start < 0 || tag.end > original.length || tag.start >= tag.end) continue

    const newStart = mapping.get(tag.start)
    const newEnd = mapping.get(tag.end - 1)
    if (newStart === undefined || newEnd === undefined) continue

    const newEndExclusive = newEnd + 1
    if (newEndExclusive <= newStart) continue

    result.push({
      ...tag,
      start: newStart,
      end: newEndExclusive,
    })
  }
  return result
}

/**
 * DP-based LCS alignment character mapping.
 *
 * Computes the standard LCS DP table between original and rewritten text,
 * then traces back to build a Map<originalIndex, rewrittenIndex>.
 *
 * The DP uses O(n*m) space but is limited to paragraphs — for full chapters
 * we'd split by paragraph first. Currently handles texts up to ~5000 chars.
 *
 * Returns null if texts are too long or too dissimilar.
 */
function buildLCSMap(
  original: string,
  rewritten: string,
): Map<number, number> | null {
  const n = original.length
  const m = rewritten.length

  // Safety: avoid memory explosion for very long texts
  if (n > 5000 || m > 15000) return fallbackGreedyMap(original, rewritten)

  // DP table: dp[i][j] = length of LCS for original[0..i) and rewritten[0..j)
  // For memory, use two rows
  const prev = new Uint16Array(m + 1)
  const curr = new Uint16Array(m + 1)

  // Store the full DP as Uint16Array rows for traceback
  // This is the compromise — full DP for precision, uint16 for memory
  const rows: Uint16Array[] = [new Uint16Array(m + 1)]
  for (let i = 1; i <= n; i++) {
    curr[0] = 0
    for (let j = 1; j <= m; j++) {
      if (original[i - 1] === rewritten[j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1])
      }
    }
    rows.push(new Uint16Array(curr))
    // Swap rows
    for (let j = 0; j <= m; j++) prev[j] = curr[j]
  }

  // Check similarity
  const lcsLen = rows[n][m]
  if (lcsLen < n * 0.3) return null // too dissimilar

  // Traceback: build mapping from original index → rewritten index
  const map = new Map<number, number>()
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (original[i - 1] === rewritten[j - 1]) {
      map.set(i - 1, j - 1)
      i--
      j--
    } else if (rows[i - 1][j] >= rows[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  // Interpolate unmapped characters: each unmapped original[i] maps to
  // the same rewritten position as the nearest mapped character after it
  // (or the nearest before it if none after).
  let lastMapped = -1
  const sorted = [...map.entries()].sort((a, b) => a[0] - b[0])
  for (const [origIdx, rewIdx] of sorted) {
    // Fill gap: unmapped chars between lastMapped+1 and origIdx-1
    for (let k = lastMapped + 1; k < origIdx; k++) {
      map.set(k, rewIdx)
    }
    lastMapped = origIdx
  }
  // Tail: chars after the last mapped one → map to end of rewritten
  const lastRew = sorted.length > 0 ? sorted[sorted.length - 1][1] : 0
  for (let k = lastMapped + 1; k < n; k++) {
    map.set(k, Math.min(lastRew + (k - lastMapped), m - 1))
  }

  return map
}

/** Fallback for very long texts: simple greedy alignment. */
function fallbackGreedyMap(
  original: string,
  rewritten: string,
): Map<number, number> | null {
  const map = new Map<number, number>()
  let ri = 0
  for (let oi = 0; oi < original.length; oi++) {
    const oc = original[oi]
    const limit = Math.min(ri + 200, rewritten.length)
    let found = false
    for (let rj = ri; rj < limit; rj++) {
      if (rewritten[rj] === oc) {
        map.set(oi, rj)
        ri = rj + 1
        found = true
        break
      }
    }
    if (!found && map.size > 0) {
      // Map to nearest known rewritten position
      const lastMapped = [...map.values()].pop()!
      map.set(oi, Math.min(lastMapped + 1, rewritten.length - 1))
    }
  }
  if (map.size < original.length * 0.3) return null
  return map
}
