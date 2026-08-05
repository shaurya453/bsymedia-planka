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
  `);
}

module.exports = { OPS_DB_NAME, ensureOpsDatabaseExists, ensureSchema };
