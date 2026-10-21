import { getPool } from './pool';

/** Req 4: persistence & query service for underwriting evaluation outcomes. */

export interface DecisionInsert {
  applicantId: string;
  productCode: string;
  executionMode: 'PRODUCTION' | 'SIMULATION';
  fundamentalRuleKey: string;
  fundamentalRuleVersion: number;
  fundamentalPassed: boolean;
  productRuleKey: string | null;
  productRuleVersion: number | null;
  finalDecision: string;
  riskClass: string;
  totalEmDebits: number;
  loadingPct: number;
  exclusions: unknown;
  missingDocuments: unknown;
  isUncleanReferral: boolean;
  requestPayload: unknown;
  fundamentalOutcome: unknown;
  productOutcome: unknown | null;
  executionTrace: unknown;
  aiCopilotBrief: unknown | null;
  executionTimeMs: number;
  triggeredBy: string | null;
}

export interface DecisionRow extends DecisionInsert {
  id: string;
  createdAt: string;
  triggeredByUsername?: string | null;
}

function mapRow(r: any): DecisionRow {
  return {
    id: r.id,
    applicantId: r.applicant_id,
    productCode: r.product_code,
    executionMode: r.execution_mode,
    fundamentalRuleKey: r.fundamental_rule_key,
    fundamentalRuleVersion: r.fundamental_rule_version,
    fundamentalPassed: r.fundamental_passed,
    productRuleKey: r.product_rule_key,
    productRuleVersion: r.product_rule_version,
    finalDecision: r.final_decision,
    riskClass: r.risk_class,
    totalEmDebits: r.total_em_debits,
    loadingPct: r.loading_pct,
    exclusions: r.exclusions,
    missingDocuments: r.missing_documents,
    isUncleanReferral: r.is_unclean_referral,
    requestPayload: r.request_payload,
    fundamentalOutcome: r.fundamental_outcome,
    productOutcome: r.product_outcome,
    executionTrace: r.execution_trace,
    aiCopilotBrief: r.ai_copilot_brief,
    executionTimeMs: r.execution_time_ms,
    triggeredBy: r.triggered_by,
    triggeredByUsername: r.triggered_by_username ?? null,
    createdAt: r.created_at,
  };
}

// All columns are `d.`-qualified because both queries LEFT JOIN `users` (which also has id/created_at).
const COLUMNS = `d.id, d.applicant_id, d.product_code, d.execution_mode, d.fundamental_rule_key, d.fundamental_rule_version,
  d.fundamental_passed, d.product_rule_key, d.product_rule_version, d.final_decision, d.risk_class, d.total_em_debits,
  d.loading_pct, d.exclusions, d.missing_documents, d.is_unclean_referral, d.request_payload, d.fundamental_outcome,
  d.product_outcome, d.execution_trace, d.ai_copilot_brief, d.execution_time_ms, d.triggered_by, d.created_at`;

/** Insert one executed evaluation and return the generated decision UUID. */
export async function insertDecision(d: DecisionInsert): Promise<string> {
  const res = await getPool().query(
    `INSERT INTO underwriting_decisions
       (applicant_id, product_code, execution_mode, fundamental_rule_key, fundamental_rule_version,
        fundamental_passed, product_rule_key, product_rule_version, final_decision, risk_class,
        total_em_debits, loading_pct, exclusions, missing_documents, is_unclean_referral,
        request_payload, fundamental_outcome, product_outcome, execution_trace, ai_copilot_brief,
        execution_time_ms, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22)
     RETURNING id`,
    [
      d.applicantId, d.productCode, d.executionMode, d.fundamentalRuleKey, d.fundamentalRuleVersion,
      d.fundamentalPassed, d.productRuleKey, d.productRuleVersion, d.finalDecision, d.riskClass,
      d.totalEmDebits, d.loadingPct, JSON.stringify(d.exclusions), JSON.stringify(d.missingDocuments),
      d.isUncleanReferral, JSON.stringify(d.requestPayload), JSON.stringify(d.fundamentalOutcome),
      d.productOutcome === null ? null : JSON.stringify(d.productOutcome),
      JSON.stringify(d.executionTrace),
      d.aiCopilotBrief === null ? null : JSON.stringify(d.aiCopilotBrief),
      d.executionTimeMs, d.triggeredBy,
    ],
  );
  return res.rows[0].id as string;
}

/** GET /api/decisions — paginated list (latest first). Heavy snapshot columns are omitted. */
export async function listDecisions(filters: {
  productCode?: string;
  finalDecision?: string;
  limit?: number;
}): Promise<DecisionRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const params: unknown[] = [];
  const where: string[] = [];
  if (filters.productCode) {
    params.push(filters.productCode);
    where.push(`d.product_code = $${params.length}`);
  }
  if (filters.finalDecision) {
    params.push(filters.finalDecision);
    where.push(`d.final_decision = $${params.length}`);
  }
  params.push(limit);

  const res = await getPool().query(
    `SELECT ${COLUMNS}, u.username AS triggered_by_username
       FROM underwriting_decisions d
       LEFT JOIN users u ON u.id = d.triggered_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(mapRow);
}

/** GET /api/decisions/:id — full record including all JSONB snapshots. */
export async function getDecisionById(id: string): Promise<DecisionRow | null> {
  const res = await getPool().query(
    `SELECT ${COLUMNS}, u.username AS triggered_by_username
       FROM underwriting_decisions d
       LEFT JOIN users u ON u.id = d.triggered_by
      WHERE d.id = $1`,
    [id],
  );
  return res.rowCount ? mapRow(res.rows[0]) : null;
}
