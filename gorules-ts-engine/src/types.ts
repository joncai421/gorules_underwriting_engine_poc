// Canonical PRD v2 data contracts shared across the whole PoC.

/** The 6 terminal dispositions of the Underwriting Decision stage (plus internal flags). */
export type FinalDecision =
  | 'REQUEST_ADDITIONAL_INFO'
  | 'ACCEPT_AS_PER_APPLICATION'
  | 'ACCEPT_WITH_LOADING'
  | 'ACCEPT_WITH_EXCLUSIONS'
  | 'POSTPONE'
  | 'DECLINE';

export type RiskClass =
  | 'INCOMPLETE_INFO'
  | 'UNINSURABLE'
  | 'TEMPORARY_DEFERRED'
  | 'STANDARD_WITH_EXCLUSION'
  | 'STANDARD'
  | 'SUBSTANDARD_TABLE_A'
  | 'SUBSTANDARD_TABLE_B'
  | 'SUBSTANDARD_TABLE_D';

export interface ApplicantRequest {
  applicantId: string;
  age: number;
  heightCm: number;
  weightKg: number;
  smoker: boolean;
  systolicBp: number;
  annualIncome: number;
  sumAssured: number;
  occupationClass: number;
  recentSurgeryMonthsAgo: number;
  medicalConditions: string[];
  submittedDocuments: string[];
  /** Optional PRD v2 extension consumed by the onboarded avocation rule. */
  avocations?: string[];
}

export interface DerivedMetrics {
  bmi: number;
  incomeMultiple: number;
}

export interface MissingDocument {
  docCode: string;
  reason: string;
}

export interface MatchedAssessmentRule {
  ruleId: string;
  outcome: 'DECLINE' | 'POSTPONE' | 'EXCLUSION' | 'DEBIT' | 'UNCLEAN_DEBIT';
  debits: number;
  exclusionCode?: string | null;
  reason: string;
}

/** Core envelope produced by the GoRules graph (and mirrored by the legacy Java service). */
export interface UnderwritingEnvelope {
  applicantId: string;
  derivedMetrics: DerivedMetrics;
  step1SufficientInfo: {
    isSufficient: boolean;
    missingDocuments: MissingDocument[];
  };
  step2RiskAssessment: {
    totalEmDebits: number;
    exclusionCodes: string[];
    hasDeclineTrigger: boolean;
    hasPostponeTrigger: boolean;
    hasComorbidityUncleanTrigger: boolean;
    matchedAssessmentRules: MatchedAssessmentRule[];
  };
  step3RiskClassification: {
    riskClass: RiskClass;
    actuarialTableRating: string;
    loadingPct: number;
  };
  step4UnderwritingDecision: {
    finalDecision: FinalDecision;
    isUncleanReferral: boolean;
    loadingPct: number;
    exclusions: string[];
    requestedAdditionalInfo: MissingDocument[];
  };
}

export interface UnderwritingResponse extends UnderwritingEnvelope {
  executionTimeMs: number;
  trace?: unknown;
  aiCopilotBrief?: AiCopilotBrief;
}

export type CopilotCaseType = 'REQUEST_ADDITIONAL_INFO' | 'UNCLEAN_RISK_ASSESSMENT';

export interface AiCopilotBrief {
  caseType: CopilotCaseType;
  riskSummary: string;
  recommendedDisposition: string;
  manualGuidelineRef: string;
  generatedBy?: 'mock' | 'live-llm';
}
