import { ZenEngine, type ZenDecision } from '@gorules/zen-engine';
import * as ruleRepo from '../db/ruleRepository';
import type { RuleVersionRow } from '../db/ruleRepository';
import type { ApplicantRequest, UnderwritingEnvelope } from '../types';

/**
 * Req 1: Two-tier underwriting orchestrator.
 *
 *   [Applicant + productCode] -> STAGE A: LIVE FUNDAMENTAL rule -> (fail) short-circuit
 *                                                         (pass) -> STAGE B: LIVE PER-PRODUCT rule
 *
 * LIVE rule JDM graphs are lazily loaded from PostgreSQL and compiled into an in-memory
 * ZenEngine decision cache keyed `ruleKey@version`; `invalidate(ruleKey)` forces the next
 * execution to recompile (used immediately after an approval publishes a new LIVE version).
 */

export interface FundamentalStage {
  ruleKey: string;
  version: number;
  passed: boolean;
  outcome: any;
  trace: unknown;
  executionTimeMs: number;
}

export interface ProductStage {
  ruleKey: string;
  version: number;
  productCode: string;
  envelope: UnderwritingEnvelope;
  trace: unknown;
  executionTimeMs: number;
}

export interface PipelineOutcome {
  haltedAtFundamental: boolean;
  fundamental: FundamentalStage;
  product: ProductStage | null;
  finalDecision: string;
  riskClass: string;
  totalEmDebits: number;
  loadingPct: number;
  exclusions: string[];
  missingDocuments: { docCode: string; reason: string }[];
  isUncleanReferral: boolean;
  executionTimeMs: number;
}

const FUNDAMENTAL_RULE_KEY = 'FUNDAMENTAL_ELIGIBILITY';

export class UwPipelineEngine {
  private zen = new ZenEngine();
  private cache = new Map<string, { decision: ZenDecision; rule: RuleVersionRow }>();

  /** Drop the compiled decision(s) for a rule_key so the next call re-reads the DB. */
  invalidate(ruleKey: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${ruleKey}@`)) this.cache.delete(key);
    }
  }

  private async loadLive(ruleTier: 'FUNDAMENTAL', productCode?: undefined): Promise<RuleVersionRow>;
  private async loadLive(ruleTier: 'PRODUCT', productCode: string): Promise<RuleVersionRow>;
  private async loadLive(ruleTier: 'FUNDAMENTAL' | 'PRODUCT', productCode?: string): Promise<RuleVersionRow> {
    const rule =
      ruleTier === 'FUNDAMENTAL'
        ? await ruleRepo.getLiveRuleByTier('FUNDAMENTAL')
        : await ruleRepo.getLiveRuleByTier('PRODUCT', productCode!);
    const cacheKey = `${rule.ruleKey}@${rule.version}`;
    let entry = this.cache.get(cacheKey);
    if (!entry) {
      const decision = this.zen.createDecision(Buffer.from(JSON.stringify(rule.jdmContent)));
      entry = { decision, rule };
      this.cache.set(cacheKey, entry);
    }
    return entry.rule;
  }

  private async evaluateLive(rule: RuleVersionRow, payload: unknown) {
    const cacheKey = `${rule.ruleKey}@${rule.version}`;
    let entry = this.cache.get(cacheKey);
    if (!entry) {
      const decision = this.zen.createDecision(Buffer.from(JSON.stringify(rule.jdmContent)));
      entry = { decision, rule };
      this.cache.set(cacheKey, entry);
    }
    const start = process.hrtime.bigint();
    const response = await entry.decision.evaluate(payload, { trace: true });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if ((response as any).error) {
      throw new Error(`Rule ${rule.ruleKey} v${rule.version} evaluation error: ${JSON.stringify((response as any).error)}`);
    }
    return { result: response.result, trace: response.trace ?? null, executionTimeMs: Number(elapsedMs.toFixed(3)) };
  }

  /** Validate that an edited JDM graph compiles before it is saved as a draft. */
  assertCompilable(jdm: unknown): void {
    if (!jdm || typeof jdm !== 'object' || !Array.isArray((jdm as any).nodes)) {
      throw new Error('JDM payload must be a decision graph object with "nodes"');
    }
    try {
      this.zen.createDecision(Buffer.from(JSON.stringify(jdm)));
    } catch (err: any) {
      throw new Error(`JDM graph failed to compile: ${err.message ?? err}`);
    }
  }

  async execute(applicant: ApplicantRequest, productCode: string): Promise<PipelineOutcome> {
    const startedAt = process.hrtime.bigint();

    // ---- STAGE A: Fundamental Rule --------------------------------------------------
    const fundRule = await this.loadLive('FUNDAMENTAL');
    if (fundRule.ruleKey !== FUNDAMENTAL_RULE_KEY && fundRule.ruleTier !== 'FUNDAMENTAL') {
      throw new Error(`Unexpected fundamental rule key: ${fundRule.ruleKey}`);
    }
    const fundEval = await this.evaluateLive(fundRule, applicant);
    const fundOutcome = fundEval.result as any;
    const fundamental: FundamentalStage = {
      ruleKey: fundRule.ruleKey,
      version: fundRule.version,
      passed: fundOutcome?.fundamentalPassed === true,
      outcome: fundOutcome,
      trace: fundEval.trace,
      executionTimeMs: fundEval.executionTimeMs,
    };

    if (!fundamental.passed) {
      // Short-circuit: skip the Product rule entirely (PRD 4.1).
      const violations: any[] = fundOutcome?.violations ?? [];
      return {
        haltedAtFundamental: true,
        fundamental,
        product: null,
        finalDecision: fundOutcome?.finalDecision ?? 'DECLINE',
        riskClass: fundOutcome?.riskClass ?? 'FUNDAMENTAL_KNOCKOUT',
        totalEmDebits: 0,
        loadingPct: 0,
        exclusions: [],
        missingDocuments: violations
          .filter((v) => v.fundamentalDecision === 'REQUEST_ADDITIONAL_INFO')
          .map((v) => ({ docCode: v.missingDoc ?? 'PROPOSAL_FORM', reason: v.reason })),
        isUncleanReferral: false,
        executionTimeMs: Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(3)),
      };
    }

    // ---- STAGE B: Per-Product Rule --------------------------------------------------
    const prodRule = await this.loadLive('PRODUCT', productCode);
    const prodEval = await this.evaluateLive(prodRule, applicant);
    const envelope = prodEval.result as UnderwritingEnvelope;
    const product: ProductStage = {
      ruleKey: prodRule.ruleKey,
      version: prodRule.version,
      productCode,
      envelope,
      trace: prodEval.trace,
      executionTimeMs: prodEval.executionTimeMs,
    };

    return {
      haltedAtFundamental: false,
      fundamental,
      product,
      finalDecision: envelope.step4UnderwritingDecision.finalDecision,
      riskClass: envelope.step3RiskClassification.riskClass,
      totalEmDebits: envelope.step2RiskAssessment.totalEmDebits,
      loadingPct: envelope.step4UnderwritingDecision.loadingPct,
      exclusions: envelope.step4UnderwritingDecision.exclusions ?? [],
      missingDocuments: envelope.step1SufficientInfo.missingDocuments ?? [],
      isUncleanReferral: envelope.step4UnderwritingDecision.isUncleanReferral === true,
      executionTimeMs: Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(3)),
    };
  }
}

let singleton: UwPipelineEngine | null = null;
export function getPipelineEngine(): UwPipelineEngine {
  if (!singleton) singleton = new UwPipelineEngine();
  return singleton;
}
