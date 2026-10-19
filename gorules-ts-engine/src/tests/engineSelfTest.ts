import fs from 'node:fs';
import path from 'node:path';
import { UwEngine } from '../engine/uwEngine';
import type { ApplicantRequest } from '../types';

// shared/test-cases.json lives at the repository root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_CASES = path.join(REPO_ROOT, 'shared', 'test-cases.json');

const LATENCY_BUDGET_MS = 5;

interface TestCase {
  id: string;
  label: string;
  applicant: ApplicantRequest;
  expectedV1: { decision: string; basePremiumLoadingPct: number; triggeredRuleIds: string[] };
  expectedV2: { decision: string; basePremiumLoadingPct: number; triggeredRuleIds: string[] };
}

function idsMatch(actual: string[], expected: string[]): boolean {
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.length === e.length && a.every((v, i) => v === e[i]);
}

async function run() {
  const cases: TestCase[] = JSON.parse(fs.readFileSync(TEST_CASES, 'utf-8')).cases;
  const engine = new UwEngine();

  console.log('GoRules Engine Self-Test');
  console.log('========================');
  console.log(`Loaded rule versions: ${engine.listRules().map((r) => `${r.id} (${r.ruleCount} rules)`).join(', ')}`);
  console.log('');

  let failures = 0;
  let maxLatency = 0;

  for (const version of ['v1-migrated-rules', 'v2-onboarded-rules'] as const) {
    const expectedKey = version === 'v1-migrated-rules' ? 'expectedV1' : 'expectedV2';
    console.log(`--- Rule version: ${version} ---`);
    for (const c of cases) {
      const expected = (c as any)[expectedKey];
      const outcome = await engine.evaluate(c.applicant, version);
      maxLatency = Math.max(maxLatency, outcome.executionTimeMs);
      const actualIds = outcome.result.triggeredRules.map((r) => r.ruleId);
      const ok =
        outcome.result.decision === expected.decision &&
        outcome.result.basePremiumLoadingPct === expected.basePremiumLoadingPct &&
        idsMatch(actualIds, expected.triggeredRuleIds);
      if (!ok) failures++;
      const flag = ok ? 'PASS' : 'FAIL';
      console.log(
        `[${flag}] ${c.id} -> ${outcome.result.decision} load=${outcome.result.basePremiumLoadingPct} ` +
          `rules=[${actualIds.join(',')}] (expected ${expected.decision} load=${expected.basePremiumLoadingPct} ` +
          `rules=[${expected.triggeredRuleIds.join(',')}]) in ${outcome.executionTimeMs}ms`,
      );
      if (!ok) {
        console.log('       raw result:', JSON.stringify(outcome.result));
      }
    }
    console.log('');
  }

  console.log(`Max evaluation latency: ${maxLatency.toFixed(3)}ms (budget ${LATENCY_BUDGET_MS}ms/case)`);
  if (maxLatency > LATENCY_BUDGET_MS) {
    console.log('NOTE: latency budget exceeded (first-call JIT/warm-up is normally the cause).');
  }

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
