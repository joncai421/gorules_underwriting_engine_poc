import { getPool } from './pool';
import { logAudit } from './auditRepository';
import type { AuthUser } from '../auth/authMiddleware';

/** Lifecycle states from the PRD v3 section 5.1 state machine. */
export type RuleStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'LIVE' | 'REJECTED' | 'ARCHIVED';

export interface RuleVersionRow {
  id: string;
  ruleKey: string;
  ruleTier: 'FUNDAMENTAL' | 'PRODUCT';
  productCode: string | null;
  name: string;
  version: number;
  status: RuleStatus;
  jdmContent: any;
  changeNotes: string | null;
  createdBy: string;
  createdByName?: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Business-rule violation in the governance workflow; carries the intended HTTP status. */
export class RuleGovernanceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

function mapRow(r: any, includeJdm = false): RuleVersionRow {
  return {
    id: r.id,
    ruleKey: r.rule_key,
    ruleTier: r.rule_tier,
    productCode: r.product_code,
    name: r.name,
    version: r.version,
    status: r.status,
    jdmContent: includeJdm ? r.jdm_content : undefined,
    changeNotes: r.change_notes,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? undefined,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewComment: r.review_comment,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const VERSION_COLUMNS = `r.id, r.rule_key, r.rule_tier, r.product_code, r.name, r.version, r.status,
  r.change_notes, r.created_by, cu.display_name AS created_by_name, r.submitted_by, r.submitted_at,
  r.reviewed_by, r.reviewed_at, r.review_comment, r.created_at, r.updated_at`;

/** GET /api/rules — every rule_key with all of its versions (no JDM blobs). */
export async function listRulesGrouped(): Promise<
  { ruleKey: string; ruleTier: string; productCode: string | null; name: string; versions: RuleVersionRow[] }[]
> {
  const res = await getPool().query(
    `SELECT ${VERSION_COLUMNS}, r.jdm_content
       FROM rule_definitions r
       LEFT JOIN users cu ON cu.id = r.created_by
      ORDER BY r.rule_key, r.version DESC`,
  );
  const byKey = new Map<string, any>();
  for (const row of res.rows) {
    if (!byKey.has(row.rule_key)) {
      byKey.set(row.rule_key, {
        ruleKey: row.rule_key,
        ruleTier: row.rule_tier,
        productCode: row.product_code,
        name: row.name,
        versions: [],
      });
    }
    byKey.get(row.rule_key).versions.push(mapRow(row));
  }
  return [...byKey.values()];
}

/** GET /api/rules/:ruleKey/versions/:version — full row including jdm_content. */
export async function getRuleVersion(ruleKey: string, version: number): Promise<RuleVersionRow> {
  const res = await getPool().query(
    `SELECT ${VERSION_COLUMNS}, r.jdm_content
       FROM rule_definitions r
       LEFT JOIN users cu ON cu.id = r.created_by
      WHERE r.rule_key = $1 AND r.version = $2`,
    [ruleKey, version],
  );
  if (res.rowCount === 0) throw new RuleGovernanceError(`Rule ${ruleKey} v${version} not found`, 404);
  return mapRow(res.rows[0], true);
}

export async function getLiveRuleByTier(ruleTier: 'FUNDAMENTAL'): Promise<RuleVersionRow>;
export async function getLiveRuleByTier(ruleTier: 'PRODUCT', productCode: string): Promise<RuleVersionRow>;
export async function getLiveRuleByTier(ruleTier: 'FUNDAMENTAL' | 'PRODUCT', productCode?: string): Promise<RuleVersionRow> {
  const res = await getPool().query(
    `SELECT ${VERSION_COLUMNS}, r.jdm_content
       FROM rule_definitions r
       LEFT JOIN users cu ON cu.id = r.created_by
      WHERE r.rule_tier = $1 AND r.status = 'LIVE' ${productCode ? 'AND r.product_code = $2' : ''}`,
    productCode ? [ruleTier, productCode] : [ruleTier],
  );
  if (res.rowCount === 0) {
    throw new RuleGovernanceError(`No LIVE ${ruleTier} rule found${productCode ? ` for product ${productCode}` : ''}`, 404);
  }
  return mapRow(res.rows[0], true);
}

/**
 * POST /api/rules/:ruleKey/draft — Req 2.
 * Re-opens the existing DRAFT if one is already open for this rule_key; otherwise clones the
 * currently LIVE version (falling back to the newest version) into a new DRAFT at max(version)+1.
 */
export async function createOrUpdateDraft(
  ruleKey: string,
  user: AuthUser,
  changeNotes?: string,
): Promise<{ draft: RuleVersionRow; created: boolean }> {
  const pool = getPool();
  const existing = await pool.query(
    `SELECT ${VERSION_COLUMNS} FROM rule_definitions r
      LEFT JOIN users cu ON cu.id = r.created_by
      WHERE r.rule_key = $1 AND r.status = 'DRAFT'
      ORDER BY r.version DESC LIMIT 1`,
    [ruleKey],
  );
  if (existing.rowCount) {
    const draft = mapRow(existing.rows[0], false);
    await logAudit('UPDATED_DRAFT', {
      ruleKey,
      ruleVersion: draft.version,
      actorId: user.id,
      actorRole: user.role,
      previousStatus: 'DRAFT',
      newStatus: 'DRAFT',
      comment: changeNotes ?? 'Draft already open; re-opened for editing',
    });
    return { draft, created: false };
  }

  const allVersions = await pool.query(
    `SELECT r.version, r.status, r.jdm_content, r.rule_tier, r.product_code, r.name
       FROM rule_definitions r WHERE r.rule_key = $1 ORDER BY r.version DESC`,
    [ruleKey],
  );
  if (allVersions.rowCount === 0) throw new RuleGovernanceError(`Unknown rule_key: ${ruleKey}`, 404);
  const maxVersion = allVersions.rows[0].version as number;
  const base =
    (allVersions.rows.find((r: any) => r.status === 'LIVE') ?? allVersions.rows[0]) as any;

  const inserted = await pool.query(
    `INSERT INTO rule_definitions
       (rule_key, rule_tier, product_code, name, version, status, jdm_content, change_notes, created_by)
     VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6::jsonb, $7, $8)
     RETURNING id`,
    [ruleKey, base.rule_tier, base.product_code, base.name, maxVersion + 1, JSON.stringify(base.jdm_content), changeNotes ?? `Cloned from v${base.version} (${base.status})`, user.id],
  );
  const draft = await getRuleVersion(ruleKey, maxVersion + 1);
  await logAudit('CREATED_DRAFT', {
    ruleKey,
    ruleVersion: draft.version,
    actorId: user.id,
    actorRole: user.role,
    previousStatus: null,
    newStatus: 'DRAFT',
    comment: changeNotes ?? `Cloned from v${base.version} (${base.status})`,
    metadata: { clonedFromVersion: base.version, clonedFromStatus: base.status, id: inserted.rows[0].id },
  });
  return { draft, created: true };
}

/** PUT /api/rules/:ruleKey/versions/:version/draft — save edited JDM onto a DRAFT (or pull a REJECTED back to DRAFT). */
export async function saveDraftJdm(
  ruleKey: string,
  version: number,
  jdm: any,
  user: AuthUser,
  opts?: { changeNotes?: string; auditAction?: 'UPDATED_DRAFT' | 'EXCEL_IMPORTED' },
): Promise<RuleVersionRow> {
  const current = await getRuleVersion(ruleKey, version);
  if (current.status !== 'DRAFT' && current.status !== 'REJECTED') {
    throw new RuleGovernanceError(`Only DRAFT (or REJECTED) versions can be edited; v${version} is ${current.status}`, 409);
  }
  await getPool().query(
    `UPDATE rule_definitions
        SET jdm_content = $3::jsonb, status = 'DRAFT', updated_at = NOW(), change_notes = COALESCE($4, change_notes)
      WHERE rule_key = $1 AND version = $2`,
    [ruleKey, version, JSON.stringify(jdm), opts?.changeNotes ?? null],
  );
  await logAudit(opts?.auditAction ?? 'UPDATED_DRAFT', {
    ruleKey,
    ruleVersion: version,
    actorId: user.id,
    actorRole: user.role,
    previousStatus: current.status,
    newStatus: 'DRAFT',
    comment: opts?.changeNotes ?? null,
    metadata: { stage2RuleCount: (jdm?.nodes ?? []).find((n: any) => n.id === 'node-step2-risk-assessment')?.content?.rules?.length ?? null },
  });
  return getRuleVersion(ruleKey, version);
}

/** POST .../submit — DRAFT -> PENDING_APPROVAL. */
export async function submitDraft(ruleKey: string, version: number, user: AuthUser): Promise<RuleVersionRow> {
  const current = await getRuleVersion(ruleKey, version);
  if (current.status !== 'DRAFT') {
    throw new RuleGovernanceError(`Only DRAFT versions can be submitted; v${version} is ${current.status}`, 409);
  }
  await getPool().query(
    `UPDATE rule_definitions
        SET status = 'PENDING_APPROVAL', submitted_by = $3, submitted_at = NOW(), updated_at = NOW()
      WHERE rule_key = $1 AND version = $2`,
    [ruleKey, version, user.id],
  );
  await logAudit('SUBMITTED_FOR_APPROVAL', {
    ruleKey,
    ruleVersion: version,
    actorId: user.id,
    actorRole: user.role,
    previousStatus: 'DRAFT',
    newStatus: 'PENDING_APPROVAL',
  });
  return getRuleVersion(ruleKey, version);
}

/**
 * POST .../approve — Req 2 & 5. Inside a single PostgreSQL transaction: demote the current LIVE
 * version to ARCHIVED, promote this PENDING_APPROVAL version to LIVE, and write both audit rows.
 * (The maker-checker guard itself is enforced by the caller before invoking this.)
 */
export async function approveVersion(
  ruleKey: string,
  version: number,
  user: AuthUser,
  comment?: string,
): Promise<{ promoted: RuleVersionRow; archivedVersion: number | null }> {
  const pool = getPool();
  const client = await pool.connect();
  let archivedVersion: number | null = null;
  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT r.version, r.status FROM rule_definitions r
        WHERE r.rule_key = $1 AND r.version = $2 FOR UPDATE`,
      [ruleKey, version],
    );
    if (target.rowCount === 0) throw new RuleGovernanceError(`Rule ${ruleKey} v${version} not found`, 404);
    if (target.rows[0].status !== 'PENDING_APPROVAL') {
      throw new RuleGovernanceError(`Only PENDING_APPROVAL versions can be approved; v${version} is ${target.rows[0].status}`, 409);
    }

    const demoted = await client.query(
      `UPDATE rule_definitions SET status = 'ARCHIVED', updated_at = NOW()
        WHERE rule_key = $1 AND status = 'LIVE' RETURNING version`,
      [ruleKey],
    );
    archivedVersion = demoted.rowCount ? (demoted.rows[0].version as number) : null;

    await client.query(
      `UPDATE rule_definitions
          SET status = 'LIVE', reviewed_by = $3, reviewed_at = NOW(), review_comment = $4, updated_at = NOW()
        WHERE rule_key = $1 AND version = $2`,
      [ruleKey, version, user.id, comment ?? null],
    );

    if (archivedVersion !== null) {
      await logAudit('ARCHIVED', {
        ruleKey,
        ruleVersion: archivedVersion,
        actorId: user.id,
        actorRole: user.role,
        previousStatus: 'LIVE',
        newStatus: 'ARCHIVED',
        comment: `Superseded by v${version} approval`,
      }, client);
    }
    await logAudit('APPROVED_TO_LIVE', {
      ruleKey,
      ruleVersion: version,
      actorId: user.id,
      actorRole: user.role,
      previousStatus: 'PENDING_APPROVAL',
      newStatus: 'LIVE',
      comment: comment ?? null,
      metadata: { archivedVersion },
    }, client);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { promoted: await getRuleVersion(ruleKey, version), archivedVersion };
}

/** POST .../reject — PENDING_APPROVAL -> REJECTED with a mandatory comment. */
export async function rejectVersion(
  ruleKey: string,
  version: number,
  user: AuthUser,
  comment: string,
): Promise<RuleVersionRow> {
  const current = await getRuleVersion(ruleKey, version);
  if (current.status !== 'PENDING_APPROVAL') {
    throw new RuleGovernanceError(`Only PENDING_APPROVAL versions can be rejected; v${version} is ${current.status}`, 409);
  }
  await getPool().query(
    `UPDATE rule_definitions
        SET status = 'REJECTED', reviewed_by = $3, reviewed_at = NOW(), review_comment = $4, updated_at = NOW()
      WHERE rule_key = $1 AND version = $2`,
    [ruleKey, version, user.id, comment],
  );
  await logAudit('REJECTED', {
    ruleKey,
    ruleVersion: version,
    actorId: user.id,
    actorRole: user.role,
    previousStatus: 'PENDING_APPROVAL',
    newStatus: 'REJECTED',
    comment,
  });
  return getRuleVersion(ruleKey, version);
}
