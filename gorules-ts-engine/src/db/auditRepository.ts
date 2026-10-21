import type { Pool, PoolClient } from 'pg';
import { getPool } from './pool';

/** Any object that can run parameterised queries (pool or a checked-out transaction client). */
export type Executor = Pool | PoolClient;

export type AuditAction =
  | 'CREATED_DRAFT'
  | 'UPDATED_DRAFT'
  | 'SUBMITTED_FOR_APPROVAL'
  | 'APPROVED_TO_LIVE'
  | 'REJECTED'
  | 'ARCHIVED'
  | 'EXCEL_IMPORTED'
  | 'WITHDRAWN';

export interface AuditEntry {
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
  metadata: unknown;
  createdAt: string;
}

/** Req 3: append-only writer for rule governance events. */
export async function logAudit(
  action: AuditAction,
  opts: {
    ruleKey: string;
    ruleVersion: number;
    actorId: string;
    actorRole: string;
    previousStatus?: string | null;
    newStatus?: string | null;
    comment?: string | null;
    metadata?: unknown;
  },
  executor?: Executor,
): Promise<void> {
  const db = executor ?? getPool();
  await db.query(
    `INSERT INTO rule_audit_logs
       (rule_key, rule_version, action, actor_id, actor_role, previous_status, new_status, comment, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      opts.ruleKey,
      opts.ruleVersion,
      action,
      opts.actorId,
      opts.actorRole,
      opts.previousStatus ?? null,
      opts.newStatus ?? null,
      opts.comment ?? null,
      opts.metadata === undefined ? null : JSON.stringify(opts.metadata),
    ],
  );
}

/** Chronological audit trail with user display names, filterable by ruleKey / action. */
export async function queryAuditLogs(filters: {
  ruleKey?: string;
  action?: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const params: unknown[] = [];
  const where: string[] = [];
  if (filters.ruleKey) {
    params.push(filters.ruleKey);
    where.push(`l.rule_key = $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    where.push(`l.action = $${params.length}`);
  }
  params.push(limit);

  const res = await getPool().query(
    `SELECT l.*, u.display_name AS actor_display_name
       FROM rule_audit_logs l
       LEFT JOIN users u ON u.id = l.actor_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return res.rows.map((r: any) => ({
    id: r.id,
    ruleKey: r.rule_key,
    ruleVersion: r.rule_version,
    action: r.action,
    actorId: r.actor_id,
    actorRole: r.actor_role,
    actorDisplayName: r.actor_display_name ?? r.actor_id,
    previousStatus: r.previous_status,
    newStatus: r.new_status,
    comment: r.comment,
    metadata: r.metadata,
    createdAt: r.created_at,
  }));
}
