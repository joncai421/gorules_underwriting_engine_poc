import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { getEngine, STEP2_NODE_ID } from './engine/uwEngine';
import { createCopilot, extractMatchedNodesFromTrace } from './ai/uncleanCaseCopilot';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

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
  medicalConditions: z.array(z.string()),
  submittedDocuments: z.array(z.string()),
  avocations: z.array(z.string()).optional().default([]),
});

// The two 1-click onboarded stage-2 rows (PRD v2 section 6.2).
const DEFAULT_ONBOARD_ROWS = [
  {
    _id: 'ra-13',
    'ra-age': '', 'ra-bmi': '', 'ra-bp': '', 'ra-smoker': '', 'ra-inc-mult': '',
    'ra-surg': '', 'ra-med': '', 'ra-occ': '4', 'ra-avoc': '',
    'ra-out-id': '"RA_OCCUPATION_CLASS_4"',
    'ra-out-type': '"UNCLEAN_DEBIT"',
    'ra-out-debits': '50',
    'ra-out-excl': 'null',
    'ra-out-reason': '"Class 4 hazardous occupation requires occupational questionnaire & +50 EM loading"',
  },
  {
    _id: 'ra-14',
    'ra-age': '', 'ra-bmi': '', 'ra-bp': '', 'ra-smoker': '', 'ra-inc-mult': '',
    'ra-surg': '', 'ra-med': '', 'ra-occ': '', 'ra-avoc': 'contains($, "SKYDIVING")',
    'ra-out-id': '"RA_AVOCATION_EXTREME_SPORT"',
    'ra-out-type': '"UNCLEAN_DEBIT"',
    'ra-out-debits': '30',
    'ra-out-excl': 'null',
    'ra-out-reason': '"Extreme sport avocation (skydiving) requires hobby questionnaire & +30 EM loading"',
  },
];

// Excel header -> stage-2 decision-table cell id (PRD v2 section 6.1).
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
        jdmRow[cellId] = EXCEL_HEADER_TO_CELL[header] && ['ra-age', 'ra-bmi', 'ra-bp', 'ra-smoker', 'ra-inc-mult', 'ra-surg', 'ra-med', 'ra-occ'].includes(cellId)
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

async function main() {
  const engine = getEngine();
  const copilot = createCopilot();

  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ ok: true, activeRule: engine.getActiveId() }));

  // List available rule versions + the active one.
  app.get('/api/rules', async () => ({
    activeId: engine.getActiveId(),
    rules: engine.listRules(),
  }));

  // Fetch raw JDM JSON for a given rule id (Admin UI editor).
  app.get<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    try {
      return engine.readRaw(req.params.id);
    } catch (err: any) {
      reply.code(404);
      return { error: err.message };
    }
  });

  // Activate a rule version for subsequent /api/underwrite calls.
  app.post<{ Params: { id: string } }>('/api/rules/:id/activate', async (req, reply) => {
    try {
      engine.setActive(req.params.id);
      return { activeId: engine.getActiveId() };
    } catch (err: any) {
      reply.code(400);
      return { error: err.message };
    }
  });

  // Save updated JDM JSON (hot-reload). Optional ?activate=true to switch immediately.
  app.put<{ Params: { id: string }; Querystring: { activate?: string }; Body: any }>(
    '/api/rules/:id',
    async (req, reply) => {
      try {
        const summary = engine.saveRule(req.params.id, req.body);
        if (req.query.activate === 'true') engine.setActive(req.params.id);
        return { saved: summary, activeId: engine.getActiveId() };
      } catch (err: any) {
        reply.code(400);
        return { error: err.message };
      }
    },
  );

  // Create/append a rule version via API (1-click onboarding backend counterpart).
  app.post<{ Body: { sourceId?: string; newId?: string; rows?: unknown[]; activate?: boolean } }>(
    '/api/rules/onboard',
    async (req, reply) => {
      try {
        const sourceId = req.body?.sourceId ?? engine.getActiveId();
        const newId = req.body?.newId ?? 'v2-onboarded-rules';
        const rows = req.body?.rows ?? DEFAULT_ONBOARD_ROWS;
        const result = engine.onboard(sourceId, newId, rows);
        if (req.body?.activate !== false) engine.setActive(newId);
        return { onboarded: result, activeId: engine.getActiveId() };
      } catch (err: any) {
        reply.code(400);
        return { error: err.message };
      }
    },
  );

  // Excel (.xlsx) upload: replaces the stage-2 Risk Assessment rows of a rule version.
  app.post<{ Body: { base64?: string; fileName?: string; ruleId?: string; activate?: boolean } }>(
    '/api/rules/upload-excel',
    async (req, reply) => {
      try {
        const { base64, ruleId } = req.body ?? {};
        if (!base64) {
          reply.code(400);
          return { error: 'Body must contain base64-encoded .xlsx content' };
        }
        const buffer = Buffer.from(base64, 'base64');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const rules = sheetToJdmRules(workbook);
        if (rules.length === 0) {
          reply.code(400);
          return { error: 'No data rows found in the uploaded worksheet' };
        }

        const targetId = ruleId ?? engine.getActiveId();
        const jdm = engine.readRaw(targetId);
        const table = jdm.nodes.find((n: any) => n.id === STEP2_NODE_ID);
        if (!table) {
          reply.code(400);
          return { error: `Rule ${targetId} has no ${STEP2_NODE_ID} node` };
        }
        table.content.rules = rules;
        const saved = engine.saveRule(targetId, jdm);
        if (req.body?.activate === true) engine.setActive(targetId);

        return { uploaded: { ruleId: targetId, rowCount: rules.length }, saved, jdm, activeId: engine.getActiveId() };
      } catch (err: any) {
        reply.code(400);
        return { error: err.message };
      }
    },
  );

  // Headless underwriting evaluation (PRD v2 four-stage envelope).
  app.post<{ Body: any; Querystring: { aiAssist?: string; rule?: string } }>(
    '/api/underwrite',
    async (req, reply) => {
      const parsed = applicantSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid ApplicantRequest payload', issues: parsed.error.issues };
      }
      const applicant = parsed.data;
      const wantAi = String(req.query.aiAssist).toLowerCase() === 'true';

      try {
        const outcome = await engine.evaluate(applicant, req.query.rule);
        const response: any = {
          ...outcome.result,
          executionTimeMs: outcome.executionTimeMs,
          trace: outcome.trace,
          activeRule: outcome.activeRuleId,
        };

        // Requirement 6: the copilot fires ONLY for unclean referrals (incl. Step 1.1
        // evidence requests) and only when aiAssist is on. CLEAN/DECLINE bypass it.
        if (outcome.result.step4UnderwritingDecision?.isUncleanReferral && wantAi) {
          const snapshot = extractMatchedNodesFromTrace(outcome.trace);
          response.aiCopilotBrief = await copilot.analyze(outcome.result, applicant, snapshot);
        }
        return response;
      } catch (err: any) {
        reply.code(500);
        return { error: err.message };
      }
    },
  );

  await app.listen({ port: PORT, host: HOST });
  // eslint-disable-next-line no-console
  console.log(`[gorules-ts-engine] listening on http://localhost:${PORT} (active rule: ${engine.getActiveId()})`);
}

main().catch((err) => {
  console.error('Failed to start gorules-ts-engine:', err);
  process.exit(1);
});
