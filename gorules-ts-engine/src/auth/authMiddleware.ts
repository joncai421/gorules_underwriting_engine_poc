import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { getPool } from '../db/pool';

/** Req 7: JWT verification & RBAC role guards for all governance endpoints. */

export const JWT_SECRET = process.env.JWT_SECRET || 'uw-gorules-poc-dev-secret-change-me';
export const JWT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS || 8 * 60 * 60);

export type UserRole = 'VIEWER' | 'RULE_AUTHOR' | 'RULE_APPROVER' | 'ADMIN';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

/** Augmented requests carry the verified user once `attachUser` has run. */
export interface RequestWithUser extends FastifyRequest {
  user?: AuthUser;
}

// PoC-grade hashing must match the pgcrypto digest(...,'sha256') hex stored by 002_seed_initial_data.sql.
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function findUserByCredentials(username: string, password: string): Promise<AuthUser | null> {
  const res = await getPool().query(
    'SELECT id, username, display_name, role FROM users WHERE username = $1 AND password_hash = $2',
    [username, sha256Hex(password)],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return { id: r.id, username: r.username, displayName: r.display_name, role: r.role };
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, username: user.username, displayName: user.displayName, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_TTL_SECONDS,
  });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    return { id: payload.sub, username: payload.username, displayName: payload.displayName, role: payload.role };
  } catch {
    return null;
  }
}

function extractBearer(request: FastifyRequest): AuthUser | null {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  return verifyToken(match[1]);
}

/** PreHandler: requires a valid Bearer token of ANY role; attaches req.user. */
export async function attachUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = extractBearer(request);
  if (!user) {
    await reply.code(401).send({ error: 'Unauthorized: missing or invalid Bearer token' });
    return;
  }
  (request as RequestWithUser).user = user;
}

/** Req 7: RBAC guard factory — 401 without a valid token, 403 when the role is not entitled. */
export function requireRole(roles: UserRole[]) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = extractBearer(request);
    if (!user) {
      await reply.code(401).send({ error: 'Unauthorized: missing or invalid Bearer token' });
      return;
    }
    if (!roles.includes(user.role)) {
      await reply.code(403).send({
        error: `Forbidden: role ${user.role} is not permitted to perform this action (requires ${roles.join(' or ')})`,
      });
      return;
    }
    (request as RequestWithUser).user = user;
  };
}

export const AUTHOR_ROLES: UserRole[] = ['RULE_AUTHOR', 'ADMIN'];
export const APPROVER_ROLES: UserRole[] = ['RULE_APPROVER', 'ADMIN'];
export const ALL_ROLES: UserRole[] = ['VIEWER', 'RULE_AUTHOR', 'RULE_APPROVER', 'ADMIN'];

/** Best-effort identity for the open data-plane endpoint (records triggered_by when a token is present). */
export function optionalUser(request: FastifyRequest): AuthUser | null {
  return extractBearer(request);
}
