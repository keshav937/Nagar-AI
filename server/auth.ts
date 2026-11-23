import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.ts';

export type UserRole =
  | 'citizen'
  | 'authority'
  | 'admin'
  | 'caregiver'
  | 'transit_driver'
  | 'sanitation_driver';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  departmentId: string;
  preferredLanguage: 'en' | 'hi';
}

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
export const SESSION_COOKIE_NAME = 'nagar_session';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, originalHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(originalHex, 'hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(derived, original);
}

export function hashAccessToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function signToken(payload: AuthUser, ttlSeconds = 60 * 60 * 12): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;

    // Verify user still exists and is active in DB
    const dbRow = db
      .prepare(`SELECT id, name, email, phone, role, department_id, preferred_language, account_status FROM users WHERE id = ?`)
      .get(parsed.id) as Record<string, unknown> | undefined;
    if (!dbRow || dbRow.account_status !== 'active') return null;

    return {
      id: String(dbRow.id),
      name: String(dbRow.name),
      email: String(dbRow.email),
      phone: String(dbRow.phone || ''),
      role: String(dbRow.role) as UserRole,
      departmentId: String(dbRow.department_id || ''),
      preferredLanguage: dbRow.preferred_language === 'hi' ? 'hi' : 'en',
    };
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie || '';
  const out: Record<string, string> = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

export function extractTokenFromRequest(req: Request): { token: string | null; viaCookie: boolean } {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return { token: header.slice(7).trim(), viaCookie: false };
  }
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE_NAME]) {
    return { token: cookies[SESSION_COOKIE_NAME], viaCookie: true };
  }
  return { token: null, viaCookie: false };
}

export function setSessionCookie(req: Request, res: Response, token: string) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    partitioned: isHttps,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(req: Request, res: Response) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    partitioned: isHttps,
    path: '/',
  });
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}

function verifyCsrfIfCookieAuth(req: Request, viaCookie: boolean): boolean {
  if (!viaCookie) return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.headers['x-requested-with'] === 'NAGAR-AI') return true;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin && host) {
    try {
      const u = new URL(origin);
      return u.host === host;
    } catch {
      return false;
    }
  }
  return false;
}

export function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const { token } = extractTokenFromRequest(req);
  if (token) {
    const user = verifyToken(token);
    if (user) req.authUser = user;
  }
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const { token, viaCookie } = extractTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in to continue.' });
  }
  if (!verifyCsrfIfCookieAuth(req, viaCookie)) {
    return res.status(403).json({ error: 'CSRF origin/header check failed.' });
  }
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  }
  req.authUser = user;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!roles.includes(req.authUser.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
}

export function getAdminConfigStatus(): { envConfigured: boolean; claimed: boolean } {
  const envConfigured = Boolean(process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim().length > 0);
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get('admin_passcode_hash') as { value: string } | undefined;
  return {
    envConfigured,
    claimed: Boolean(row?.value),
  };
}

export function verifyAdminPasscode(passcode: string): boolean {
  const envCode = process.env.ADMIN_PASSCODE?.trim();
  if (envCode) {
    const a = Buffer.from(passcode);
    const b = Buffer.from(envCode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get('admin_passcode_hash') as { value: string } | undefined;
  if (!row?.value) return false;
  return verifyPassword(passcode, row.value);
}

export function recordAudit(
  actorId: string,
  actorRole: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {}
) {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_id, actor_role, action, target_type, target_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `aud-${crypto.randomUUID().slice(0, 8)}`,
    actorId,
    actorRole,
    action,
    targetType,
    targetId,
    JSON.stringify(metadata),
    new Date().toISOString()
  );
}
