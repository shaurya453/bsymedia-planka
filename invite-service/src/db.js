const { Pool } = require('pg');

const OPS_DB_NAME = 'planka_ops';

// Postgres has no `CREATE DATABASE IF NOT EXISTS`, so check pg_database first.
// Runs against the `postgres` maintenance DB, which always exists.
async function ensureOpsDatabaseExists(adminConnectionString) {
  const adminPool = new Pool({ connectionString: adminConnectionString });
  try {
    const { rows } = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      OPS_DB_NAME,
    ]);
    if (rows.length === 0) {
      // Database names can't be parameterized; OPS_DB_NAME is a fixed
      // constant above, not user input.
      await adminPool.query(`CREATE DATABASE ${OPS_DB_NAME}`);
    }
  } finally {
    await adminPool.end();
  }
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invites (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      board_id TEXT NOT NULL,
      board_name TEXT NOT NULL,
      board_role TEXT NOT NULL,
      invited_by_email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);

    -- BSY Media: per-checklist (Planka TaskList) Gantt bar color, chosen by
    -- the team on the Timeline tab's Tier 3 color picker. Kept here rather
    -- than in Planka's own schema, same rationale as everything else in
    -- planka_ops - a PLANKA version upgrade must never be able to wipe or
    -- break this. Shared team-wide (not per-user), one row per checklist.
    CREATE TABLE IF NOT EXISTS gantt_task_list_colors (
      task_list_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      color TEXT NOT NULL,
      updated_by_email TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_gantt_task_list_colors_board_id
      ON gantt_task_list_colors(board_id);
  `);
}

module.exports = { OPS_DB_NAME, ensureOpsDatabaseExists, ensureSchema };
