import { Pool, types } from 'pg';

// Parse NUMERIC (e.g. execution_time_ms) as JS numbers instead of strings.
types.setTypeParser(types.builtins.NUMERIC, (v) => parseFloat(v));

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://uw_user:uw_password@localhost:5432/uw_engine_db';

// Process-wide connection pool used by the repositories and the HTTP server.
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
    pool.on('error', (err) => console.error('[pg-pool] idle client error:', err.message));
  }
  return pool;
}
