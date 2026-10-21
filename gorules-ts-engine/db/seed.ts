import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * seed.ts  (`npm run db:seed`)
 *
 * Loads the initial JDM rule templates from shared/seed-rules/ into the PostgreSQL
 * `rule_definitions` table as immutable version 1 rows with status 'LIVE'
 * (PRD v3 Requirement 6). Idempotent: existing (rule_key, version) rows are skipped.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SEED_DIR = path.join(REPO_ROOT, 'shared', 'seed-rules');
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://uw_user:uw_password@localhost:5432/uw_engine_db';

// Rules are attributed to the seeded ADMIN demo user.
const SYSTEM_AUTHOR_ID = 'u_dave_admin';

interface SeedSpec {
  file: string;
  ruleKey: string;
  ruleTier: 'FUNDAMENTAL' | 'PRODUCT';
  productCode: string | null;
  name: string;
}

const SEED_RULES: SeedSpec[] = [
  {
    file: 'fundamental-eligibility.json',
    ruleKey: 'FUNDAMENTAL_ELIGIBILITY',
    ruleTier: 'FUNDAMENTAL',
    productCode: null,
    name: 'Global Fundamental Eligibility Rule',
  },
  {
    file: 'product-term-life.json',
    ruleKey: 'PRODUCT_TERM_LIFE',
    ruleTier: 'PRODUCT',
    productCode: 'TERM_LIFE',
    name: 'Term Life Underwriting (4-Stage Pipeline)',
  },
  {
    file: 'product-critical-illness.json',
    ruleKey: 'PRODUCT_CRITICAL_ILLNESS',
    ruleTier: 'PRODUCT',
    productCode: 'CRITICAL_ILLNESS',
    name: 'Critical Illness Underwriting (Enhanced 4-Stage Pipeline)',
  },
];

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const users = await client.query('SELECT id FROM users WHERE id = $1', [SYSTEM_AUTHOR_ID]);
    if (users.rowCount === 0) {
      throw new Error(`Seed user ${SYSTEM_AUTHOR_ID} missing. Run 'npm run db:migrate' first.`);
    }

    for (const spec of SEED_RULES) {
      const filePath = path.join(SEED_DIR, spec.file);
      if (!fs.existsSync(filePath)) throw new Error(`Seed template not found: ${filePath}`);
      const jdm = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      const res = await client.query(
        `INSERT INTO rule_definitions (rule_key, rule_tier, product_code, name, version, status, jdm_content, change_notes, created_by)
         VALUES ($1, $2, $3, $4, 1, 'LIVE', $5::jsonb, $6, $7)
         ON CONFLICT (rule_key, version) DO NOTHING`,
        [spec.ruleKey, spec.ruleTier, spec.productCode, spec.name, JSON.stringify(jdm), 'Initial PRD v3 seed import', SYSTEM_AUTHOR_ID],
      );
      console.log(res.rowCount ? `[seeded]   ${spec.ruleKey} v1 -> LIVE` : `[skip]     ${spec.ruleKey} v1 already exists`);
    }

    const live = await client.query(
      "SELECT rule_key, version, status FROM rule_definitions WHERE status = 'LIVE' ORDER BY rule_key",
    );
    console.log(`\nLIVE rules in DB: ${live.rowCount}`);
    for (const r of live.rows) console.log(`  - ${r.rule_key} v${r.version} (${r.status})`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('DB seed failed:', err.message || err);
  process.exit(1);
});
