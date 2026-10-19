import fs from 'node:fs';
import path from 'node:path';

/**
 * parityVerifier.ts  (`npm run verify-parity`)
 *
 * Shadow-mode behavioral equivalence check between the LEGACY Java service (:8080) and
 * the migrated GoRules TS engine (:3001). Loads the canonical test applicants, fires both
 * engines concurrently, and prints a terminal comparison table asserting that `decision`,
 * `basePremiumLoadingPct` and the ordered `triggeredRules` IDs match 100%.
 *
 * Exits with code 1 on any discrepancy so it can gate CI.
 *
 * Prerequisite: both services running, e.g.
 *   (cd legacy-java-service && ./mvnw spring-boot:run)
 *   npm run engine
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_CASES = path.join(REPO_ROOT, 'shared', 'test-cases.json');
const JAVA_URL = process.env.JAVA_URL || 'http://localhost:8080/api/legacy/underwrite';
const TS_URL = process.env.TS_URL || 'http://localhost:3001/api/underwrite?rule=v1-migrated-rules';

interface CoreResult {
  decision: string;
  basePremiumLoadingPct: number;
  triggeredRules: { ruleId: string }[];
}

async function post(url: string, body: unknown): Promise<CoreResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json: any = await res.json();
  return {
    decision: json.decision,
    basePremiumLoadingPct: json.basePremiumLoadingPct,
    triggeredRules: json.triggeredRules ?? [],
  };
}

function ids(r: CoreResult): string {
  return r.triggeredRules.map((t) => t.ruleId).join(',');
}

function same(a: CoreResult, b: CoreResult): boolean {
  return (
    a.decision === b.decision &&
    a.basePremiumLoadingPct === b.basePremiumLoadingPct &&
    ids(a) === ids(b)
  );
}

async function main() {
  const cases: any[] = JSON.parse(fs.readFileSync(TEST_CASES, 'utf-8')).cases;

  console.log('Parity Verifier (Shadow Mode): Legacy Java :8080  vs  GoRules TS :3001');
  console.log('=====================================================================');

  // Verify both endpoints are reachable first.
  for (const [label, url] of [['Java', JAVA_URL], ['TS', TS_URL]] as const) {
    try {
      await post(url, cases[0].applicant);
    } catch (err: any) {
      console.error(`\nCannot reach ${label} service at ${url}: ${err.message}`);
      console.error('Start both services before running verify-parity.');
      process.exit(1);
    }
  }

  const rows = await Promise.all(
    cases.map(async (c) => {
      const [java, ts] = await Promise.all([post(JAVA_URL, c.applicant), post(TS_URL, c.applicant)]);
      return { c, java, ts, ok: same(java, ts) };
    }),
  );

  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const flag = (b: boolean) => (b ? 'MATCH' : 'DIFF ');
  console.log(pad('CASE', 9) + pad('DECISION', 10) + pad('LOADING%', 10) + pad('TRIGGERED RULE IDS', 60) + 'RESULT');
  console.log('-'.repeat(99));
  let failures = 0;
  for (const { c, java, ts, ok } of rows) {
    if (!ok) failures++;
    console.log(
      pad(c.id, 9) +
        pad(`${java.decision}/${ts.decision}`, 10) +
        pad(`${java.basePremiumLoadingPct}/${ts.basePremiumLoadingPct}`, 10) +
        pad(ok ? ids(java) : `${ids(java)}  vs  ${ids(ts)}`, 60) +
        flag(ok),
    );
  }

  console.log('-'.repeat(99));
  const passed = rows.length - failures;
  console.log(`Parity: ${passed}/${rows.length} cases match (decision + loading + triggered rule IDs).`);
  if (failures > 0) {
    console.error(`\nPARITY FAILED: ${failures} discrepancy(ies) detected.`);
    process.exit(1);
  }
  console.log('\nPARITY PASSED: 100% behavioral equivalence between legacy Java and GoRules TS.');
}

main().catch((err) => {
  console.error('Parity verification crashed:', err);
  process.exit(1);
});
