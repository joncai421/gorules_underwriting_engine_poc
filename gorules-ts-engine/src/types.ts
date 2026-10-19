// Canonical data contracts shared across the whole PoC (see PRD section 3).

export type Decision = 'CLEAN' | 'UNCLEAN' | 'DECLINE';

export interface ApplicantRequest {
  applicantId: string;
  age: number;
  bmi: number;
  smoker: boolean;
  systolicBp: number;
  sumAssured: number;
  medicalConditions: string[];
  occupationClass: number;
}

export interface TriggeredRule {
  ruleId: string;
  category: string;
  reason: string;
}

export interface AiCopilotBrief {
  riskSummary: string;
  recommendedAction: string;
  requiredEvidence: string[];
  manualGuidelineRef: string;
  generatedBy?: 'mock' | 'live-llm';
}

// The core evaluation output produced by the GoRules aggregator (and the legacy Java service).
export interface UnderwritingCoreResult {
  decision: Decision;
  basePremiumLoadingPct: number;
  triggeredRules: TriggeredRule[];
}

// The full response returned by POST /api/underwrite.
export interface UnderwritingResponse extends UnderwritingCoreResult {
  executionTimeMs: number;
  trace?: unknown;
  aiCopilotBrief?: AiCopilotBrief;
}
