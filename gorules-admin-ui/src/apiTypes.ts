/** Shared API DTO shapes (camelCase, mirroring gorules-ts-engine responses). */

export type RuleStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'LIVE' | 'REJECTED' | 'ARCHIVED' | 'WITHDRAWN';

export interface RuleVersion {
  id: string;
  ruleKey: string;
  ruleTier: 'FUNDAMENTAL' | 'PRODUCT';
  productCode: string | null;
  name: string;
  version: number;
  status: RuleStatus;
  jdmContent?: any;
  changeNotes: string | null;
  createdBy: string;
  createdByName?: string;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuleGroup {
  ruleKey: string;
  ruleTier: 'FUNDAMENTAL' | 'PRODUCT';
  productCode: string | null;
  name: string;
  versions: RuleVersion[];
}

export interface MissingDoc {
  docCode: string;
  reason: string;
}

export interface ProductEnvelope {
  applicantId: string;
  derivedMetrics: { bmi: number; incomeMultiple: number };
  step1SufficientInfo: { isSufficient: boolean; missingDocuments: MissingDoc[] };
  step2RiskAssessment: {
    totalEmDebits: number;
    exclusionCodes: string[];
    hasDeclineTrigger: boolean;
    hasPostponeTrigger: boolean;
    hasComorbidityUncleanTrigger: boolean;
    matchedAssessmentRules: { ruleId: string; outcome: string; debits: number; reason: string }[];
  };
  step3RiskClassification: { riskClass: string; actuarialTableRating: string; loadingPct: number };
  step4UnderwritingDecision: {
    finalDecision: string;
    isUncleanReferral: boolean;
    loadingPct: number;
    exclusions: string[];
    requestedAdditionalInfo: MissingDoc[];
  };
}

/** POST /api/underwrite response (two-tier pipeline + flat product envelope). */
export interface PipelineResponse extends Partial<ProductEnvelope> {
  decisionId: string;
  haltedAtFundamental: boolean;
  fundamental: { ruleKey: string; version: number; passed: boolean; outcome: any };
  product: { ruleKey: string; version: number; productCode: string } | null;
  finalDecision: string;
  riskClass: string;
  totalEmDebits: number;
  loadingPct: number;
  exclusions: string[];
  missingDocuments: MissingDoc[];
  isUncleanReferral: boolean;
  executionTimeMs: number;
  trace: { fundamental: any; product: any };
  aiCopilotBrief?: {
    caseType: string;
    riskSummary: string;
    recommendedDisposition: string;
    manualGuidelineRef: string;
    generatedBy?: string;
  } | null;
}

export interface UwDecision {
  id: string;
  applicantId: string;
  productCode: string;
  executionMode: string;
  fundamentalRuleKey: string;
  fundamentalRuleVersion: number;
  fundamentalPassed: boolean;
  productRuleKey: string | null;
  productRuleVersion: number | null;
  finalDecision: string;
  riskClass: string;
  totalEmDebits: number;
  loadingPct: number;
  exclusions: string[];
  missingDocuments: MissingDoc[];
  isUncleanReferral: boolean;
  requestPayload: any;
  fundamentalOutcome: any;
  productOutcome: ProductEnvelope | null;
  executionTrace: { fundamental: any; product: any };
  aiCopilotBrief: PipelineResponse['aiCopilotBrief'];
  executionTimeMs: number;
  triggeredBy: string | null;
  triggeredByUsername?: string | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  action: string;
  actorId: string;
  actorRole: string;
  actorDisplayName?: string;
  previousStatus: string | null;
  newStatus: string | null;
  comment: string | null;
  metadata: any;
  createdAt: string;
}

export const RULE_LABELS: Record<string, string> = {
  FUNDAMENTAL_ELIGIBILITY: '[Fundamental] Global Eligibility Rule',
  PRODUCT_TERM_LIFE: '[Product] Term Life Underwriting',
  PRODUCT_CRITICAL_ILLNESS: '[Product] Critical Illness Underwriting',
};
