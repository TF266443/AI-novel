import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import log from 'electron-log'

let db: Database.Database | null = null

export function getDbPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'novel-mate.db')
}

export function initDatabase(): void {
  const dbPath = getDbPath()
  log.info(`Initializing database at: ${dbPath}`)

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  createTables()
  log.info('Database initialized successfully at:', dbPath)
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    log.info('Database closed')
  }
}

function createTables(): void {
  const database = getDatabase()

  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_path TEXT,
      save_path TEXT,
      template_id TEXT,
      high_model_id TEXT,
      low_model_id TEXT,
      share_models INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_index INTEGER NOT NULL,
      title TEXT,
      original_text TEXT,
      rewritten_text TEXT,
      summary_data TEXT,
      scene_tags TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paragraphs (
      id TEXT PRIMARY KEY,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      paragraph_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      scene_tags TEXT,
      rewrite_status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      stage_name TEXT NOT NULL,
      stage_phase TEXT,
      status TEXT DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS character_state (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      alias TEXT,
      description TEXT,
      state_snapshot TEXT NOT NULL,
      source TEXT DEFAULT 'auto',
      locked INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_from_chapter INTEGER
    );

    CREATE TABLE IF NOT EXISTS chapter_summaries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      plot_summary TEXT NOT NULL,
      additions TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT DEFAULT '1.0',
      description TEXT,
      template_json TEXT NOT NULL,
      category_count INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'openai-compatible',
      base_url TEXT NOT NULL,
      api_key_encrypted TEXT,
      model_id TEXT NOT NULL,
      temperature REAL DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 16000,
      timeout_sec INTEGER DEFAULT 120,
      tier TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
    CREATE INDEX IF NOT EXISTS idx_paragraphs_chapter ON paragraphs(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_character_state_project ON character_state(project_id);
    CREATE INDEX IF NOT EXISTS idx_chapter_summaries_chapter ON chapter_summaries(chapter_id);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'prompt_fragment',
      version TEXT DEFAULT '1.0',
      description TEXT,
      skill_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_skills (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_project_skills_project ON project_skills(project_id);

    CREATE TABLE IF NOT EXISTS quality_checks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      results TEXT NOT NULL,
      passed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quality_checks_chapter ON quality_checks(chapter_id);

    CREATE TABLE IF NOT EXISTS foreshadowing (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      planted_in INTEGER NOT NULL,
      resolved_in INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_foreshadowing_project ON foreshadowing(project_id, status);

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      owner TEXT,
      location TEXT,
      status TEXT DEFAULT 'active',
      chapter_index INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id);

    CREATE TABLE IF NOT EXISTS power_levels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      character_name TEXT NOT NULL,
      realm TEXT,
      stage TEXT,
      progress TEXT,
      chapter_index INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_power_levels_project ON power_levels(project_id, character_name);

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('category','chunk','gold_snippet')),
      ref_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      vector TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_type_ref ON embeddings(type, ref_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project_id);

    CREATE TABLE IF NOT EXISTS gold_labels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      category_id TEXT NOT NULL,
      snippet_text TEXT NOT NULL,
      label TEXT NOT NULL CHECK(label IN ('positive','negative')),
      source TEXT DEFAULT 'manual',
      start_pos INTEGER NOT NULL DEFAULT 0,
      end_pos INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gold_labels_project ON gold_labels(project_id);
    CREATE INDEX IF NOT EXISTS idx_gold_labels_chapter ON gold_labels(chapter_id);

    CREATE TABLE IF NOT EXISTS rewrite_feedback (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      original_snippet TEXT NOT NULL,
      corrected_snippet TEXT,
      category_id TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rewrite_feedback_project ON rewrite_feedback(project_id);

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
    );
  `)

  database.exec(`
    CREATE TABLE IF NOT EXISTS kb_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO kb_settings (key, value) VALUES ('prompt_kb_path', '');
    INSERT OR IGNORE INTO kb_settings (key, value) VALUES ('expansion_kb_path', '');
  `)

  try {
    database.exec(`ALTER TABLE projects ADD COLUMN save_path TEXT`)
  } catch {
    // Column already exists
  }

  // ── P0-P2: Stage 3 AI Scene Recognition schema ──
  try { database.exec(`ALTER TABLE chapters ADD COLUMN scene_tags TEXT`) } catch { /* exists */ }
  try { database.exec(`ALTER TABLE chapters ADD COLUMN scan_metrics TEXT`) } catch { /* exists */ }
  try { database.exec(`ALTER TABLE chapters ADD COLUMN expanded_scene_tags TEXT`) } catch { /* exists */ }
  try { database.exec(`ALTER TABLE chapter_summaries ADD COLUMN scene_summary TEXT`) } catch { /* exists */ }

  database.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      vector TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { database.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_type_ref ON embeddings(type, ref_id)`) } catch { /* */ }

  database.exec(`
    CREATE TABLE IF NOT EXISTS gold_labels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      snippet_text TEXT NOT NULL,
      label TEXT NOT NULL CHECK(label IN ('positive','negative')),
      source TEXT DEFAULT 'manual',
      start_pos INTEGER NOT NULL DEFAULT 0,
      end_pos INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  database.exec(`
    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
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
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
}