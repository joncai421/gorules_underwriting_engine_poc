import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { getPipelineEngine } from './engine/uwPipelineEngine';
import { createCopilot, extractMatchedNodesFromTrace } from './ai/uncleanCaseCopilot';
import * as ruleRepo from './db/ruleRepository';
import { RuleGovernanceError } from './db/ruleRepository';
import { logAudit, queryAuditLogs } from './db/auditRepository';
import * as decisionRepo from './db/decisionRepository';
import {
  ALL_ROLES,
  AUTHOR_ROLES,
  APPROVER_ROLES,
  attachUser,
  findUserByCredentials,
  optionalUser,
  requireRole,
  signToken,
} from './auth/authMiddleware';
import type { AuthUser, RequestWithUser } from './auth/authMiddleware';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

// The stage-2 "Risk Assessment" table is the Excel upload target in every product graph.
const STEP2_NODE_ID = 'node-step2-risk-assessment';

const applicantSchema = z.object({
  applicantId: z.string(),
  age: z.number(),
  heightCm: z.number(),
  weightKg: z.number(),
  smoker: z.boolean(),
  systolicBp: z.number(),
  annualIncome: z.number(),
  sumAssured: z.number(),
  occupationClass: z.number(),
  recentSurgeryMonthsAgo: z.number(),
  residencyCountry: z.string().optional().default('DOMESTIC'),
  amlWatchlistHit: z.boolean().optional().default(false),
  medicalConditions: z.array(z.string()),
  submittedDocuments: z.array(z.string()),
  avocations: z.array(z.string()).optional().default([]),
});

const underwriteSchema = z.object({
  productCode: z.enum(['TERM_LIFE', 'CRITICAL_ILLNESS']),
  executionMode: z.enum(['PRODUCTION', 'SIMULATION']).optional().default('PRODUCTION'),
  aiAssist: z.boolean().optional().default(false),
  applicant: applicantSchema,
});

// Excel header -> stage-2 decision-table cell id (PRD v2 section 6.1, retained for Req 2 uploads).
const EXCEL_HEADER_TO_CELL: Record<string, string> = {
  RuleId: 'ra-out-id',
  Outcome: 'ra-out-type',
  Debits: 'ra-out-debits',
  ExclusionCode: 'ra-out-excl',
  Reason: 'ra-out-reason',
  Age: 'ra-age',
  BMI: 'ra-bmi',
  SystolicBP: 'ra-bp',
  Smoker: 'ra-smoker',
  IncomeMultiple: 'ra-inc-mult',
  SurgeryMonthsAgo: 'ra-surg',
  MedicalConditions: 'ra-med',
  OccupationClass: 'ra-occ',
  Avocations: 'ra-avoc',
};
const EXCEL_TEXT_CELLS = new Set(['ra-out-id', 'ra-out-type', 'ra-out-reason', 'ra-avoc', 'ra-med']);

/**
 * Converts an uploaded "RiskAssessment" worksheet into JDM stage-2 rows.
 * Condition cells are passed through as literal Zen unary-test text (e.g. ">= 28",
 * contains($, "FATTY_LIVER")); string outputs (ruleId/outcome/reason) are re-quoted as
 * Zen string literals, numeric outputs stay numeric, and a blank ExclusionCode maps to null.
 */
function sheetToJdmRules(workbook: XLSX.WorkBook): any[] {
  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase().includes('riskassessment')) ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('Workbook has no worksheet');
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map((row, idx) => {
    const jdmRow: Record<string, string> = { _id: `excel-${idx + 1}` };
    for (const headerId of Object.values(EXCEL_HEADER_TO_CELL)) jdmRow[headerId] = '';

    for (const [header, cellId] of Object.entries(EXCEL_HEADER_TO_CELL)) {
      const raw = row[header];
      const value = String(raw ?? '').trim();
      if (!value) continue;
      if (cellId === 'ra-out-excl') {
        jdmRow[cellId] = value === '-' ? 'null' : `"${value}"`;
      } else if (EXCEL_TEXT_CELLS.has(cellId)) {
        // Zen unary expressions (contains(...)) pass through; plain words become literals.
        jdmRow[cellId] = ['ra-age', 'ra-bmi', 'ra-bp', 'ra-smoker', 'ra-inc-mult', 'ra-surg', 'ra-med', 'ra-occ'].includes(cellId)
          ? value
          : /^[<>!=\[]|^\(.*\.\.|^and |^or |^not\(|^contains\(|^\$|^true$|^false$/.test(value)
            ? value
            : `"${value}"`;
      } else {
        jdmRow[cellId] = value;
      }
    }
    return jdmRow;
  });
}

function user(request: FastifyRequest): AuthUser {
  return (request as RequestWithUser).user!;
}

function parseVersion(raw: string): number {
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) throw new RuleGovernanceError(`Invalid rule version: ${raw}`, 400);
  return v;
}

async function main() {
  const pipeline = getPipelineEngine();
  const copilot = createCopilot();

  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  // Uniform error funnel: governance violations keep their intended HTTP status.
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof RuleGovernanceError) {
      reply.code(err.status).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: err.message ?? 'Internal error' });
  });

  // ---------------------------------------------------------------- Health (open)
  app.get('/api/health', async () => {
    let liveRules: string[] = [];
    try {
      const grouped = await ruleRepo.listRulesGrouped();
      liveRules = grouped.flatMap((g) => g.versions.filter((v) => v.status === 'LIVE').map((v) => `${v.ruleKey}@v${v.version}`));
    } catch {
      return { ok: false, db: 'down' };
    }
    return { ok: true, db: 'up', liveRules };
  });

  // ---------------------------------------------------------------- Auth (Req 7)
  app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      reply.code(400);
      return { error: 'Body must contain { username, password }' };
    }
    const found = await findUserByCredentials(username, password);
    if (!found) {
      reply.code(401);
      return { error: 'Invalid username or password' };
    }
    return { token: signToken(found), user: found };
  });

  app.get('/api/auth/me', { preHandler: attachUser }, async (req) => ({ user: user(req) }));

  // ---------------------------------------------------------------- Two-tier underwriting (Req 1 & 4)
  // Headless data plane: token-free for external callers (legacy Java, parity tooling);
  // a Bearer token, when present, is recorded as `triggered_by`.
  app.post<{ Body: any }>('/api/underwrite', async (req, reply) => {
    const parsed = underwriteSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid UnderwriteRequest payload', issues: parsed.error.issues };
    }
    const { productCode, executionMode, aiAssist, applicant } = parsed.data;

    let outcome;
    try {
      outcome = await pipeline.execute(applicant, productCode);
    } catch (err: any) {
      reply.code(500);
      return { error: err.message ?? 'Pipeline execution failed' };
    }

    // Req 6 AI copilot: only for unclean referrals when aiAssist is on (Stage B cases; fundamental
    // halts are eligibility knockouts and bypass the LLM brief).
    let aiCopilotBrief: unknown = null;
    if (!outcome.haltedAtFundamental && outcome.isUncleanReferral && aiAssist && outcome.product) {
      const snapshot = extractMatchedNodesFromTrace(outcome.product.trace);
      aiCopilotBrief = await copilot.analyze(outcome.product.envelope, applicant, snapshot);
    }

    // Persistence Guarantee (Req 4): EVERY execution lands in underwriting_decisions.
    const triggeredBy = optionalUser(req)?.id ?? null;
    const decisionId = await decisionRepo.insertDecision({
      applicantId: applicant.applicantId,
      productCode,
      executionMode,
      fundamentalRuleKey: outcome.fundamental.ruleKey,
      fundamentalRuleVersion: outcome.fundamental.version,
      fundamentalPassed: outcome.fundamental.passed,
      productRuleKey: outcome.product?.ruleKey ?? null,
      productRuleVersion: outcome.product?.version ?? null,
      finalDecision: outcome.finalDecision,
      riskClass: outcome.riskClass,
      totalEmDebits: outcome.totalEmDebits,
      loadingPct: outcome.loadingPct,
      exclusions: outcome.exclusions,
      missingDocuments: outcome.missingDocuments,
      isUncleanReferral: outcome.isUncleanReferral,
      requestPayload: { productCode, executionMode, aiAssist, applicant },
      fundamentalOutcome: outcome.fundamental.outcome,
      productOutcome: outcome.product?.envelope ?? null,
      executionTrace: { fundamental: outcome.fundamental.trace, product: outcome.product?.trace ?? null },
      aiCopilotBrief,
      executionTimeMs: outcome.executionTimeMs,
      triggeredBy,
    });

    const envelope = outcome.product?.envelope;
    return {
      decisionId,
      haltedAtFundamental: outcome.haltedAtFundamental,
      fundamental: {
        ruleKey: outcome.fundamental.ruleKey,
        version: outcome.fundamental.version,
        passed: outcome.fundamental.passed,
        outcome: outcome.fundamental.outcome,
      },
      product: outcome.product
        ? { ruleKey: outcome.product.ruleKey, version: outcome.product.version, productCode }
        : null,
      finalDecision: outcome.finalDecision,
      riskClass: outcome.riskClass,
      totalEmDebits: outcome.totalEmDebits,
      loadingPct: outcome.loadingPct,
      exclusions: outcome.exclusions,
      missingDocuments: outcome.missingDocuments,
      isUncleanReferral: outcome.isUncleanReferral,
      executionTimeMs: outcome.executionTimeMs,
      trace: { fundamental: outcome.fundamental.trace, product: outcome.product?.trace ?? null },
      aiCopilotBrief,
      // Flat PRD v2 four-stage envelope (backward compatibility for legacy callers & parity tooling).
      ...(envelope ?? {}),
    };
  });

  // ---------------------------------------------------------------- Rule governance reads (Req 2)
  app.get('/api/rules', { preHandler: attachUser }, async () => ({ rules: await ruleRepo.listRulesGrouped() }));

  app.get<{ Params: { ruleKey: string; version: string } }>(
    '/api/rules/:ruleKey/versions/:version',
    { preHandler: attachUser },
    async (req, reply) => {
      try {
        return await ruleRepo.getRuleVersion(req.params.ruleKey, parseVersion(req.params.version));
      } catch (err: any) {
        reply.code(err instanceof RuleGovernanceError ? err.status : 500);
        return { error: err.message };
      }
    },
  );

  // ---------------------------------------------------------------- Draft & submission (RULE_AUTHOR / ADMIN)
  app.post<{ Params: { ruleKey: string }; Body: { changeNotes?: string } }>(
    '/api/rules/:ruleKey/draft',
    { preHandler: requireRole(AUTHOR_ROLES) },
    async (req, reply) => {
      try {
        const { draft, created } = await ruleRepo.createOrUpdateDraft(req.params.ruleKey, user(req), req.body?.changeNotes);
        return { created, draft };
      } catch (err: any) {
        reply.code(err instanceof RuleGovernanceError ? err.status : 500);
        return { error: err.message };
      }
    },
  );

  app.put<{ Params: { ruleKey: string; version: string }; Body: any; Querystring: { changeNotes?: string } }>(
    '/api/rules/:ruleKey/versions/:version/draft',
    { preHandler: requireRole(AUTHOR_ROLES) },
    async (req, reply) => {
      try {
        pipeline.assertCompilable(req.body);
        const version = parseVersion(req.params.version);
        const saved = await ruleRepo.saveDraftJdm(req.params.ruleKey, version, req.body, user(req), {
          changeNotes: req.query.changeNotes,
        });
        return { saved };
      } catch (err: any) {
        reply.code(err instanceof RuleGovernanceError ? err.status : 400);
        return { error: err.message };
      }
    },
  );

  app.post<{ Params: { ruleKey: string; version: string } }>(
    '/api/rules/:ruleKey/versions/:version/submit',
    { preHandler: requireRole(AUTHOR_ROLES) },
    async (req, reply) => {
      try {
        return { submitted: await ruleRepo.submitDraft(req.params.ruleKey, parseVersion(req.params.version), user(req)) };
      } catch (err: any) {
        reply.code(err instanceof RuleGovernanceError ? err.status : 500);
        return { error: err.message };
      }
    },
  );

  // Excel (.xlsx) upload: replaces the stage-2 Risk Assessment rows of a DRAFT version in PostgreSQL.
  app.post<{ Params: { ruleKey: string }; Body: { base64?: string; fileName?: string; version?: number } }>(
    '/api/rules/:ruleKey/upload-excel',
    { preHandler: requireRole(AUTHOR_ROLES) },
    async (req, reply) => {
      try {
        const { base64, version } = req.body ?? {};
        if (!base64 || !version) {
          reply.code(400);
          return { error: 'Body must contain { base64 (.xlsx content), version (target DRAFT) }' };
        }
        const buffer = Buffer.from(base64, 'base64');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const rules = sheetToJdmRules(workbook);
        if (rules.length === 0) {
          reply.code(400);
          return { error: 'No data rows found in the uploaded worksheet' };
        }

        const target = parseVersion(String(version));
        const current = await ruleRepo.getRuleVersion(req.params.ruleKey, target);
        if (current.status !== 'DRAFT') {
          reply.code(409);
          return { error: `Excel import target must be a DRAFT version; v${target} is ${current.status}` };
        }
        const jdm = current.jdmContent;
        const table = (jdm?.nodes ?? []).find((n: any) => n.id === STEP2_NODE_ID);
        if (!table) {
          reply.code(400);
          return { error: `Rule ${req.params.ruleKey} v${target} has no ${STEP2_NODE_ID} node` };
        }
        table.content.rules = rules;
        pipeline.assertCompilable(jdm);
        const saved = await ruleRepo.saveDraftJdm(req.params.ruleKey, target, jdm, user(req), {
          changeNotes: `Excel import '${req.body?.fileName ?? 'upload.xlsx'}' -> ${rules.length} stage-2 rows`,
          auditAction: 'EXCEL_IMPORTED',
        });
        return { uploaded: { ruleKey: req.params.ruleKey, version: target, rowCount: rules.length }, saved };
      } catch (err: any) {
        reply.code(err instanceof RuleGovernanceError ? err.status : 400);
        return { error: err.message };
      }
    },
  );

  // ---------------------------------------------------------------- Approval (RULE_APPROVER / ADMIN, Maker-Checker)
  app.post<{ Params: { ruleKey: string; version: string }; Body: { comment?: string } }>(
    '/api/rules/:ruleKey/versions/:version/approve',
    { preHandler: requireRole(APPROVER_ROLES) },
    async (req, reply) => {
      try {
        const version = parseVersion(req.params.version);
        const actor = user(req);
        const target = await ruleRepo.getRuleVersion(req.params.ruleKey, version);

        // Maker-Checker Guard: an author cannot approve their own submission unless ADMIN.
        if (actor.role !== 'ADMIN' && target.submittedBy === actor.id) {
          reply.code(403);
          return { error: 'Forbidden (maker-checker): you submitted this version and cannot approve your own submission' };
        }

        const result = await ruleRepo.approveVersion(req.params.ruleKey, version, actor, req.body?.comment);
        // Immediate publication: drop the compiled ZenEngine cache for this rule_key.
        pipeline.invalidate(req.params.ruleKey);
        return {
          approved: { ...result.promoted, jdmContent: undefined },
          archivedVersion: result.archivedVersion,
        };
      } catch (err: any) {
        reply.code(err instanceof RuleGovernanceError ? err.status : 500);
        return { error: err.message };
      }
    },
  );

  app.post<{ Params: { ruleKey: string; version: string }; Body: { reviewComment?: string } }>(
    '/api/rules/:ruleKey/versions/:version/reject',
    { preHandler: requireRole(APPROVER_ROLES) },
    async (req, reply) => {
      try {
        const comment = req.body?.reviewComment?.trim();
        if (!comment) {
          reply.code(400);
          return { error: 'A rejection requires a non-empty reviewComment' };
        }
        const rejected = await ruleRepo.rejectVersion(req.params.ruleKey, parseVersion(req.params.version), user(req), comment);
        return { rejected: { ...rejected, jdmContent: undefined } };
      } catch (err: any) {
        reply.code(err instanceof RuleGovernanceError ? err.status : 500);
        return { error: err.message };
      }
    },
  );

  // Soft delete: mark a version WITHDRAWN (rows are never hard-deleted so audit references
  // stay meaningful and version numbers are never reused). Maker roles withdraw drafts &
  // submissions; retiring an ARCHIVED version is a checker action.
  app.post<{ Params: { ruleKey: string; version: string }; Body: { comment?: string } }>(
    '/api/rules/:ruleKey/versions/:version/withdraw',
    { preHandler: requireRole([...AUTHOR_ROLES, ...APPROVER_ROLES]) },
    async (req, reply) => {
      try {
        const actor = user(req);
        const version = parseVersion(req.params.version);
        const target = await ruleRepo.getRuleVersion(req.params.ruleKey, version);
        const allowed =
          actor.role === 'ADMIN' ||
          (target.status === 'ARCHIVED' ? actor.role === 'RULE_APPROVER' : actor.role === 'RULE_AUTHOR');
        if (!allowed) {
          reply.code(403);
          return {
            error: `Forbidden: role ${actor.role} cannot withdraw a ${target.status} version (${target.status === 'ARCHIVED' ? 'requires RULE_APPROVER or ADMIN' : 'requires RULE_AUTHOR or ADMIN'})`,
          };
        }
        const withdrawn = await ruleRepo.withdrawVersion(req.params.ruleKey, version, actor, req.body?.comment);
        return { withdrawn: { ...withdrawn, jdmContent: undefined } };
      } catch (err: any) {
        reply.code(err instanceof RuleGovernanceError ? err.status : 500);
        return { error: err.message };
      }
    },
  );

  // ---------------------------------------------------------------- Persisted decisions (Req 4)
  app.get<{ Querystring: { productCode?: string; finalDecision?: string; limit?: string } }>(
    '/api/decisions',
    { preHandler: attachUser },
    async (req) => ({
      decisions: await decisionRepo.listDecisions({
        productCode: req.query.productCode,
        finalDecision: req.query.finalDecision,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/decisions/:id',
    { preHandler: attachUser },
    async (req, reply) => {
      const record = await decisionRepo.getDecisionById(req.params.id);
      if (!record) {
        reply.code(404);
        return { error: `Decision ${req.params.id} not found` };
      }
      return record;
    },
  );

  // ---------------------------------------------------------------- Audit trail (Req 3)
  app.get<{ Querystring: { ruleKey?: string; action?: string; limit?: string } }>(
    '/api/audit-logs',
    { preHandler: attachUser },
    async (req) => ({
      logs: await queryAuditLogs({
        ruleKey: req.query.ruleKey,
        action: req.query.action,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    }),
  );

  await app.listen({ port: PORT, host: HOST });
  // eslint-disable-next-line no-console
  console.log(`[gorules-ts-engine v3] two-tier pipeline listening on http://localhost:${PORT} (roles: ${ALL_ROLES.join('/')})`);
}

main().catch((err) => {
  console.error('Failed to start gorules-ts-engine:', err);
  process.exit(1);
});
