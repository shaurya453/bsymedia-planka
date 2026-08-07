// Reuses the same planka_ops database invite-service already created (see
// invite-service/src/db.js) - separate tables, same DB, so we don't grow a
// third stateful dependency for what's a one-off migration tool.
const { Pool } = require('pg');

async function ensureSchema(pool) {
  await pool.query(`
    -- One row per (source, entity_type, source_ref) ever created in Planka.
    -- This is what makes "apply" idempotent: re-running it after a partial
    -- failure skips anything already recorded here instead of duplicating it.
    CREATE TABLE IF NOT EXISTS import_entities (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      source_file_sha256 TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      planka_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source, source_file_sha256, entity_type, source_ref)
    );

    -- Derived cycle-time seed data - NOT written into PLANKA's own schema
    -- (which only has the import-time createCard action, since the API has
    -- no way to backdate history). This is our own historical record,
    -- queried separately by whatever Phase 3 cycle-time reporting builds.
    CREATE TABLE IF NOT EXISTS cycle_time_events (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      source_file_sha256 TEXT NOT NULL,
      card_source_ref TEXT NOT NULL,
      card_planka_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_list_name TEXT,
      to_list_name TEXT,
      occurred_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source, source_file_sha256, card_source_ref, event_type, to_list_name, occurred_at)
    );
  `);
}

async function connect() {
  if (!process.env.OPS_DATABASE_URL) {
    throw new Error('OPS_DATABASE_URL env var is required');
  }
  const opsDbUrl = process.env.OPS_DATABASE_URL.replace(/\/[^/]*$/, '/planka_ops');
  const pool = new Pool({ connectionString: opsDbUrl });
  await ensureSchema(pool);
  return pool;
}

async function getEntity(pool, { source, sourceFileSha256, entityType, sourceRef }) {
  const { rows } = await pool.query(
    `SELECT planka_id FROM import_entities
     WHERE source = $1 AND source_file_sha256 = $2 AND entity_type = $3 AND source_ref = $4`,
    [source, sourceFileSha256, entityType, sourceRef],
  );
  return rows[0] ? rows[0].planka_id : null;
}

async function recordEntity(pool, { source, sourceFileSha256, entityType, sourceRef, plankaId }) {
  await pool.query(
    `INSERT INTO import_entities (source, source_file_sha256, entity_type, source_ref, planka_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source, source_file_sha256, entity_type, source_ref) DO NOTHING`,
    [source, sourceFileSha256, entityType, sourceRef, plankaId],
  );
}

async function recordCycleTimeEvent(pool, ev) {
  await pool.query(
    `INSERT INTO cycle_time_events
       (source, source_file_sha256, card_source_ref, card_planka_id, event_type, from_list_name, to_list_name, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source, source_file_sha256, card_source_ref, event_type, to_list_name, occurred_at) DO NOTHING`,
    [
      ev.source,
      ev.sourceFileSha256,
      ev.cardSourceRef,
      ev.cardPlankaId,
      ev.eventType,
      ev.fromListName || null,
      ev.toListName || null,
      ev.occurredAt,
    ],
  );
}

module.exports = { connect, getEntity, recordEntity, recordCycleTimeEvent };
