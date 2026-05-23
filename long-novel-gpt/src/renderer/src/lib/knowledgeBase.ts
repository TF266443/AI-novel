export interface PromptKBData {
  version: number
  exported_at: string
  gold_labels: Array<{
    id: string; category_id: string; snippet_text: string
    label: string; start_pos: number; end_pos: number; created_at: string
  }>
  embeddings: Array<{
    id: string; type: string; ref_id: string; model_id: string
    vector: string; text_hash: string
  }>
  categories: Array<{
    id: string; name: string; synonyms: string[]
    confidence_threshold?: number
    bootstrap?: {
      entry_conditions: string
      confirm_signals: string[]
      exclude_patterns: string[]
      expansion_brief: string
    }
  }>
}

export interface ExpansionKBData {
  version: number
  exported_at: string
  rewrite_feedback: Array<{
    id: string; chapter_id: string; original_snippet: string
    corrected_snippet?: string; category_id?: string; note?: string
    created_at: string
  }>
  rewrite_template?: { commonPrompt?: string; categoryPrompts?: Record<string, string> }
  skills?: Array<{ id: string; name: string; type: string; skill_json: string }>
}

export async function exportPromptKB(filePath: string): Promise<void> {
  // Query all gold_labels
  const gl = await window.api.db.query('gold_labels', '1=1')
  // Query all gold_snippet embeddings
  const emb = await window.api.db.query('embeddings', "type = 'gold_snippet'")
  // Query all templates, collect unique categories
  const tmpl = await window.api.db.query('templates', '1=1')
  const allCats: any[] = []
  for (const t of (tmpl.data as any[] || [])) {
    try {
      const tpl = JSON.parse(t.template_json)
      const idTpl = typeof tpl?.identifyTemplate === 'string' ? JSON.parse(tpl.identifyTemplate) : tpl?.identifyTemplate
      for (const c of (idTpl?.categories || [])) {
        if (!allCats.find(x => x.id === c.id)) {
          allCats.push({ id: c.id, name: c.name, synonyms: c.synonyms || [], confidence_threshold: c.confidence_threshold, bootstrap: c.bootstrap })
        }
      }
    } catch {}
  }
  const data: PromptKBData = {
    version: 1,
    exported_at: new Date().toISOString(),
    gold_labels: (gl.data as any[]) || [],
    embeddings: (emb.data as any[]) || [],
    categories: allCats,
  }
  await window.api.fs.saveFile(filePath, JSON.stringify(data, null, 2))
}

export async function importPromptKB(filePath: string, projectId: string): Promise<void> {
  const r = await window.api.fs.readFile(filePath)
  const fileData = (r.data as any)?.content || (r.data as string)
  if (!r.success || !fileData) throw new Error('Failed to read file')
  const data: PromptKBData = JSON.parse(fileData)
  for (const gl of (data.gold_labels || [])) {
    await window.api.db.mutation('gold_labels', 'insert', {
      id: gl.id, project_id: projectId, chapter_id: '',
      category_id: gl.category_id, snippet_text: gl.snippet_text,
      label: gl.label, start_pos: gl.start_pos, end_pos: gl.end_pos,
    }).catch(() => {})
  }
  for (const emb of (data.embeddings || [])) {
    await window.api.db.mutation('embeddings', 'insert', {
      id: emb.id, type: emb.type, ref_id: emb.ref_id,
      project_id: projectId, model_id: emb.model_id,
      vector: emb.vector, text_hash: emb.text_hash,
    }).catch(() => {})
  }
  // Merge categories
  const tr = await window.api.db.query('templates', 'id IN (SELECT template_id FROM projects WHERE id = ?)', [projectId])
  if (tr.success && (tr.data as any[])?.length) {
    const row = (tr.data as any[])[0]
    const tpl = JSON.parse(row.template_json)
    const idTpl = typeof tpl?.identifyTemplate === 'string' ? JSON.parse(tpl.identifyTemplate) : tpl?.identifyTemplate
    const cats = idTpl?.categories
    if (Array.isArray(cats)) {
      for (const imported of (data.categories || [])) {
        const existing = cats.find((c: any) => c.id === imported.id)
        if (existing) {
          if (imported.synonyms?.length) {
            const merged = [...new Set([...(existing.synonyms || []), ...imported.synonyms])].slice(0, 30)
            existing.synonyms = merged
          }
          if (imported.confidence_threshold !== undefined) {
            existing.confidence_threshold = imported.confidence_threshold
          }
          if (imported.bootstrap) {
            existing.bootstrap = imported.bootstrap
          }
        }
      }
      await window.api.db.mutation('templates', 'update', { template_json: JSON.stringify(tpl) }, 'id = ?', [row.id])
    }
  }
}

export async function exportExpansionKB(filePath: string, projectId: string): Promise<void> {
  const fb = await window.api.db.query('rewrite_feedback', 'project_id = ?', [projectId])
  const tr = await window.api.db.query('templates', 'id IN (SELECT template_id FROM projects WHERE id = ?)', [projectId])
  let rewriteTemplate: any = undefined
  if (tr.success && (tr.data as any[])?.length) {
    const rawTpl = JSON.parse((tr.data as any[])[0].template_json)
    rewriteTemplate = typeof rawTpl?.rewriteTemplate === 'string' ? JSON.parse(rawTpl.rewriteTemplate) : rawTpl?.rewriteTemplate
  }
  const ps = await window.api.db.query('project_skills', 'project_id = ? AND enabled = 1', [projectId])
  const skillIds = (ps.data as any[] || []).map((s: any) => s.skill_id)
  const skills = []
  for (const sid of skillIds) {
    const sr = await window.api.db.query('skills', 'id = ?', [sid])
    if (sr.success && (sr.data as any[])?.length) {
      const s = (sr.data as any[])[0]
      skills.push({ id: s.id, name: s.name, type: s.type, skill_json: s.skill_json })
    }
  }
  const data: ExpansionKBData = {
    version: 1,
    exported_at: new Date().toISOString(),
    rewrite_feedback: (fb.data as any[]) || [],
    rewrite_template: rewriteTemplate,
    skills,
  }
  await window.api.fs.saveFile(filePath, JSON.stringify(data, null, 2))
}

export async function importExpansionKB(filePath: string, projectId: string): Promise<void> {
  const r = await window.api.fs.readFile(filePath)
  const fileData2 = (r.data as any)?.content || (r.data as string)
  if (!r.success || !fileData2) throw new Error('Failed to read file')
  const data: ExpansionKBData = JSON.parse(fileData2)
  for (const fb of (data.rewrite_feedback || [])) {
    await window.api.db.mutation('rewrite_feedback', 'insert', {
      id: fb.id, project_id: projectId, chapter_id: fb.chapter_id,
      original_snippet: fb.original_snippet,
      corrected_snippet: fb.corrected_snippet || null,
      category_id: fb.category_id || null, note: fb.note || null,
    }).catch(() => {})
  }
  if (data.rewrite_template) {
    const tr = await window.api.db.query('templates', 'id IN (SELECT template_id FROM projects WHERE id = ?)', [projectId])
    if (tr.success && (tr.data as any[])?.length) {
      const row = (tr.data as any[])[0]
      const tpl = JSON.parse(row.template_json)
      if (typeof tpl.rewriteTemplate === 'string') {
        tpl.rewriteTemplate = JSON.parse(tpl.rewriteTemplate)
      }
      tpl.rewriteTemplate = tpl.rewriteTemplate || {}
      if (data.rewrite_template.commonPrompt) tpl.rewriteTemplate.commonPrompt = data.rewrite_template.commonPrompt
      if (data.rewrite_template.categoryPrompts) {
        tpl.rewriteTemplate.categoryPrompts = { ...(tpl.rewriteTemplate.categoryPrompts || {}), ...data.rewrite_template.categoryPrompts }
      }
      await window.api.db.mutation('templates', 'update', { template_json: JSON.stringify(tpl) }, 'id = ?', [row.id])
    }
  }
  for (const sk of (data.skills || [])) {
    await window.api.db.mutation('skills', 'insert', {
      id: sk.id, name: sk.name, type: sk.type, version: '1.0',
      description: '', skill_json: sk.skill_json,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).catch(() => {})
  }
}
