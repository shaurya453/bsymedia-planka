// Reuses the same planka_ops database invite-service already created (see
// invite-service/src/db.js) - separate tables, same DB, so we don't grow a
// third stateful dependency for what's a one-off migration tool.
const { Pool } = require('pg');

async function ensureSchema(pool) {
  await pool.query(`
    -- One row per (source, entity_type, source_ref) ever created in Planka.
    -- This is what makes "apply" idempotent: re-running it - even against a
    -- newer re-export of the same source project with a different file hash
    -- - skips anything already recorded here instead of duplicating it.
    -- source_file_sha256 is kept as an audit column (which file most
    -- recently touched this row) but deliberately NOT part of the identity:
    -- it used to be, which meant re-running against an updated export (a
    -- different hash) failed to recognize already-imported entities and
    -- would have recreated all of them as duplicates.
    CREATE TABLE IF NOT EXISTS import_entities (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      source_file_sha256 TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      planka_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE import_entities DROP CONSTRAINT IF EXISTS import_entities_source_source_file_sha256_entity_type_sourc_key;
    ALTER TABLE import_entities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    -- One-time backfill: rows created before the adapter started scoping
    -- \`source\` by project slug (see adapters/taiga.js) all share the bare
    -- 'taiga' source, which collides across the 3 already-imported Taiga
    -- projects (e.g. every project has a "review" column, ref "1", etc).
    -- Each project's rows are still distinguishable by which export file
    -- created them, so backfill using the same sha256 -> slug mapping this
    -- deployment's known historical export files hash to. Safe to re-run:
    -- a no-op once no rows have source = 'taiga' left.
    UPDATE import_entities SET source = 'taiga:thaireis-yapmaster-media'
      WHERE source = 'taiga' AND source_file_sha256 = '69d5c00180a867b28e2f9a64ab5aaa1d97dc01568e844559deee10ae8fc67379';
    UPDATE import_entities SET source = 'taiga:thaireis-unindexed-media'
      WHERE source = 'taiga' AND source_file_sha256 = '36d604318e8915bb3b99e590ea1c1b0307367a7d8c5fc19d67c64a4270fbf7fb';
    UPDATE import_entities SET source = 'taiga:themaze420-classified'
      WHERE source = 'taiga' AND source_file_sha256 = '7172e6248e0104066436275dc4db5d29012c51387571a4d5bbbc37c9dff55986';

    DO $$ BEGIN
      ALTER TABLE import_entities ADD CONSTRAINT import_entities_identity_key UNIQUE (source, entity_type, source_ref);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE cycle_time_events DROP CONSTRAINT IF EXISTS cycle_time_events_source_source_file_sha256_card_source_ref_key;

    UPDATE cycle_time_events SET source = 'taiga:thaireis-yapmaster-media'
      WHERE source = 'taiga' AND source_file_sha256 = '69d5c00180a867b28e2f9a64ab5aaa1d97dc01568e844559deee10ae8fc67379';
    UPDATE cycle_time_events SET source = 'taiga:thaireis-unindexed-media'
      WHERE source = 'taiga' AND source_file_sha256 = '36d604318e8915bb3b99e590ea1c1b0307367a7d8c5fc19d67c64a4270fbf7fb';
    UPDATE cycle_time_events SET source = 'taiga:themaze420-classified'
      WHERE source = 'taiga' AND source_file_sha256 = '7172e6248e0104066436275dc4db5d29012c51387571a4d5bbbc37c9dff55986';

    DO $$ BEGIN
      ALTER TABLE cycle_time_events ADD CONSTRAINT cycle_time_events_identity_key
        UNIQUE (source, card_source_ref, event_type, to_list_name, occurred_at);
    EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
    END $$;
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

async function getEntity(pool, { source, entityType, sourceRef }) {
  const { rows } = await pool.query(
    `SELECT planka_id FROM import_entities
     WHERE source = $1 AND entity_type = $2 AND source_ref = $3`,
    [source, entityType, sourceRef],
  );
  return rows[0] ? rows[0].planka_id : null;
}

// Like getEntity, but also returns updated_at - the last time this tool
// itself touched (created or synced) this entity. Used to tell "the export
// changed" apart from "someone edited this directly in Planka since we last
// touched it" before blindly overwriting a reused entity on a rerun.
async function getEntityRecord(pool, { source, entityType, sourceRef }) {
  const { rows } = await pool.query(
    `SELECT planka_id, updated_at FROM import_entities
     WHERE source = $1 AND entity_type = $2 AND source_ref = $3`,
    [source, entityType, sourceRef],
  );
  return rows[0] ? { plankaId: rows[0].planka_id, updatedAt: rows[0].updated_at } : null;
}

async function recordEntity(pool, { source, sourceFileSha256, entityType, sourceRef, plankaId }) {
  await pool.query(
    `INSERT INTO import_entities (source, source_file_sha256, entity_type, source_ref, planka_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source, entity_type, source_ref)
     DO UPDATE SET source_file_sha256 = EXCLUDED.source_file_sha256, updated_at = now()`,
    [source, sourceFileSha256, entityType, sourceRef, plankaId],
  );
}

async function recordCycleTimeEvent(pool, ev) {
  await pool.query(
    `INSERT INTO cycle_time_events
       (source, source_file_sha256, card_source_ref, card_planka_id, event_type, from_list_name, to_list_name, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source, card_source_ref, event_type, to_list_name, occurred_at) DO NOTHING`,
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

module.exports = { connect, getEntity, getEntityRecord, recordEntity, recordCycleTimeEvent };
