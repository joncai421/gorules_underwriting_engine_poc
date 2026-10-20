import fs from 'node:fs';
import path from 'node:path';

/**
 * parityVerifier.ts  (`npm run verify-parity`)
 *
 * Shadow-mode behavioral equivalence check between the LEGACY Java service (:8080) and
 * the migrated GoRules TS engine (:3001) for the PRD v2 four-stage pipeline. Loads the
 * canonical test applicants, fires both engines concurrently, and prints a terminal
 * comparison table asserting that `derivedMetrics`, `step1SufficientInfo`,
 * `totalEmDebits`, `riskClass`, `finalDecision` (plus loading % and matched rule order)
 * match 100%.
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

interface Envelope {
  applicantId: string;
  derivedMetrics: { bmi: number; incomeMultiple: number };
  step1SufficientInfo: { isSufficient: boolean; missingDocuments: { docCode: string }[] };
  step2RiskAssessment: { totalEmDebits: number; matchedAssessmentRules: { ruleId: string }[] };
  step3RiskClassification: { riskClass: string; loadingPct: number };
  step4UnderwritingDecision: { finalDecision: string; loadingPct: number };
}

async function post(url: string, body: unknown): Promise<Envelope> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as Envelope;
}

function fingerprint(e: Envelope): string[] {
  return [
    String(e.derivedMetrics?.bmi),
    String(e.derivedMetrics?.incomeMultiple),
    String(e.step1SufficientInfo?.isSufficient),
    (e.step1SufficientInfo?.missingDocuments ?? []).map((m) => m.docCode).join('+'),
    String(e.step2RiskAssessment?.totalEmDebits),
    (e.step2RiskAssessment?.matchedAssessmentRules ?? []).map((m) => m.ruleId).join('+'),
    e.step3RiskClassification?.riskClass,
    e.step4UnderwritingDecision?.finalDecision,
    String(e.step4UnderwritingDecision?.loadingPct),
  ];
}

function same(a: Envelope, b: Envelope): boolean {
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  return fa.length === fb.length && fa.every((v, i) => v === fb[i]);
}

async function main() {
  const cases: any[] = JSON.parse(fs.readFileSync(TEST_CASES, 'utf-8')).cases;

  console.log('Parity Verifier (Shadow Mode): Legacy Java :8080  vs  GoRules TS :3001  [PRD v2 pipeline]');
  console.log('=========================================================================================');

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
  console.log(
    pad('CASE', 9) + pad('BMI/MULT', 13) + pad('SUFF', 7) + pad('DEBITS', 8) +
      pad('RISK CLASS', 26) + pad('DECISION', 26) + pad('LOAD%', 7) + 'RESULT',
  );
  console.log('-'.repeat(122));
  let failures = 0;
  for (const { c, java, ts, ok } of rows) {
    if (!ok) failures++;
    console.log(
      pad(c.id, 9) +
        pad(`${java.derivedMetrics.bmi}/${ts.derivedMetrics.bmi} ${java.derivedMetrics.incomeMultiple}/${ts.derivedMetrics.incomeMultiple}`, 13) +
        pad(`${java.step1SufficientInfo.isSufficient ? 'Y' : 'N'}/${ts.step1SufficientInfo.isSufficient ? 'Y' : 'N'}`, 7) +
        pad(`${java.step2RiskAssessment.totalEmDebits}/${ts.step2RiskAssessment.totalEmDebits}`, 8) +
        pad(ok ? java.step3RiskClassification.riskClass : `${java.step3RiskClassification.riskClass}/${ts.step3RiskClassification.riskClass}`, 26) +
        pad(ok ? java.step4UnderwritingDecision.finalDecision : `${java.step4UnderwritingDecision.finalDecision}/${ts.step4UnderwritingDecision.finalDecision}`, 26) +
        pad(`${java.step4UnderwritingDecision.loadingPct}/${ts.step4UnderwritingDecision.loadingPct}`, 7) +
        flag(ok),
    );
    if (!ok) {
      console.log('   java:', JSON.stringify(fingerprint(java)));
      console.log('   ts:   ', JSON.stringify(fingerprint(ts)));
    }
  }

  console.log('-'.repeat(122));
  const passed = rows.length - failures;
  console.log(`Parity: ${passed}/${rows.length} cases match (derived metrics + sufficiency + debits + risk class + decision + loading).`);
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
