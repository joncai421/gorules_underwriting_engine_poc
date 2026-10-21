import fs from 'node:fs';
import path from 'node:path';
import { UwEngine } from '../engine/uwEngine';
import type { ApplicantRequest, UnderwritingEnvelope } from '../types';

// shared/test-cases.json lives at the repository root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_CASES = path.join(REPO_ROOT, 'shared', 'test-cases.json');

const LATENCY_BUDGET_MS = 5;

interface Expected {
  derivedMetrics: { bmi: number; incomeMultiple: number };
  isSufficient: boolean;
  missingDocCodes: string[];
  matchedRuleIds: string[];
  totalEmDebits: number;
  riskClass: string;
  finalDecision: string;
  loadingPct: number;
  isUncleanReferral: boolean;
}

interface TestCase {
  id: string;
  label: string;
  applicant: ApplicantRequest;
  expected: Expected;
  expectedV2?: Expected;
}

function eq(a: string, b: string): boolean {
  return a === b;
}

function check(env: UnderwritingEnvelope, exp: Expected): string[] {
  const problems: string[] = [];
  const got = {
    bmi: env.derivedMetrics?.bmi,
    incomeMultiple: env.derivedMetrics?.incomeMultiple,
    isSufficient: env.step1SufficientInfo?.isSufficient,
    missingDocCodes: (env.step1SufficientInfo?.missingDocuments ?? []).map((m) => m.docCode).join(','),
    matchedRuleIds: (env.step2RiskAssessment?.matchedAssessmentRules ?? []).map((m) => m.ruleId).join(','),
    totalEmDebits: env.step2RiskAssessment?.totalEmDebits,
    riskClass: env.step3RiskClassification?.riskClass,
    finalDecision: env.step4UnderwritingDecision?.finalDecision,
    loadingPct: env.step4UnderwritingDecision?.loadingPct,
    isUncleanReferral: env.step4UnderwritingDecision?.isUncleanReferral,
  };
  const expectNorm = {
    ...exp,
    bmi: exp.derivedMetrics.bmi,
    incomeMultiple: exp.derivedMetrics.incomeMultiple,
    missingDocCodes: exp.missingDocCodes.join(','),
    matchedRuleIds: exp.matchedRuleIds.join(','),
  };
  for (const key of Object.keys(got) as Array<keyof typeof got>) {
    if (!eq(String(got[key]), String((expectNorm as any)[key]))) {
      problems.push(`${key}: got ${got[key]}, expected ${(expectNorm as any)[key]}`);
    }
  }
  return problems;
}

async function run() {
  // Only the four-stage parity baseline cases run here; PRD v3 FUND-CASE* entries have no
  // 'expected' envelope — they are Fundamental-gate knockouts verified via /api/underwrite.
  const cases: TestCase[] = JSON.parse(fs.readFileSync(TEST_CASES, 'utf-8')).cases.filter((c: TestCase) => c.expected);
  const engine = new UwEngine();

  console.log('GoRules Engine Self-Test (PRD v2 four-stage pipeline)');
  console.log('=====================================================');
  console.log(`Loaded rule versions: ${engine.listRules().map((r) => `${r.id} (${r.ruleCount} stage-2 rules)`).join(', ')}`);
  console.log('');

  let failures = 0;
  let maxLatency = 0;

  for (const version of ['v1-migrated-rules', 'v2-onboarded-rules'] as const) {
    console.log(`--- Rule version: ${version} ---`);
    for (const c of cases) {
      const exp = (version === 'v2-onboarded-rules' && c.expectedV2 ? c.expectedV2 : c.expected)!;
      const outcome = await engine.evaluate(c.applicant, version);
      maxLatency = Math.max(maxLatency, outcome.executionTimeMs);
      const problems = check(outcome.result, exp);
      if (problems.length > 0) failures++;
      const flag = problems.length === 0 ? 'PASS' : 'FAIL';
      const s4 = outcome.result.step4UnderwritingDecision;
      console.log(
        `[${flag}] ${c.id} -> ${s4?.finalDecision} class=${outcome.result.step3RiskClassification?.riskClass} ` +
          `debits=${outcome.result.step2RiskAssessment?.totalEmDebits} load=${s4?.loadingPct} refer=${s4?.isUncleanReferral} ` +
          `in ${outcome.executionTimeMs}ms`,
      );
      for (const p of problems) console.log(`       ${p}`);
    }
    console.log('');
  }

  console.log(`Max evaluation latency: ${maxLatency.toFixed(3)}ms (budget ${LATENCY_BUDGET_MS}ms/case)`);

  if (failures > 0) {
    console.error(`\nSelf-test FAILED: ${failures} mismatching case(s).`);
    process.exit(1);
  }
  console.log('\nSelf-test PASSED: all cases match across both rule versions.');
}

run().catch((err) => {
  console.error('Self-test crashed:', err);
  process.exit(1);
});
