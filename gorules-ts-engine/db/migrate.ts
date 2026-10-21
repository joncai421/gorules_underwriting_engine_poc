import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * migrate.ts  (`npm run db:migrate`)
 *
 * Applies numbered `.sql` files from db/migrations in ascending order, tracking applied
 * scripts in `schema_migrations`. Each pending script runs inside its own transaction so
 * a failed migration leaves the database untouched. Re-runs are no-ops (idempotent).
 */

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://uw_user:uw_password@localhost:5432/uw_engine_db';

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r: any) => r.version),
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/i, '');
      if (applied.has(version)) {
        console.log(`[skip]     ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`[applied]  ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    console.log(`Migrations complete (${applied.size + files.filter((f) => !applied.has(f.replace(/\.sql$/i, ''))).length} total tracked).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('DB migration failed:', err.message || err);
  process.exit(1);
});
