import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { db, initDatabase, haversineKm } from './server/db.ts';
import {
  hashPassword,
  verifyPassword,
  hashAccessToken,
  signToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireRole,
  getAdminConfigStatus,
  verifyAdminPasscode,
  recordAudit,
  getGoogleAuthConfigStatus,
  signOAuthState,
  verifyOAuthState,
  type AuthenticatedRequest,
  type UserRole,
} from './server/auth.ts';
import {
  checkElevenLabsStatus,
  listPermittedVoices,
  transcribeWithElevenLabs,
  synthesizeSpeechStream,
  getConvAiSignedUrl,
} from './server/elevenlabs.ts';
import {
  isGeminiConfigured,
  analyzeCivicSubmission,
  enhanceDescriptionWithAi,
  classifyWasteWithAi,
  runNagarSaathiTurn,
} from './server/ai.ts';
import { fetchNearbyFacilities, type FacilityCategory } from './server/places.ts';
import {
  searchMobilityDestination,
  computeRealRoute,
  fetchNearbyMobilityHubs,
  type MobilityMode,
} from './server/mobility.ts';
import {
  getMessagingProviderStatus,
  notifyLinkedCaregivers,
  retryCaregiverNotification,
  dispatchSms,
} from './server/notifications.ts';

function getAppConfigJson<T>(key: string, fallback: T): T {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as { value: string } | undefined;
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

function awardCitizenRewardPoints(params: {
  userId: string;
  action: string;
  points: number;
  refId: string;
  badge?: string;
}) {
  if (params.points <= 0) return false;
  const existing = db.prepare(`SELECT * FROM rewards WHERE user_id = ?`).get(params.userId) as
    | { id: string; points: number; badges_json: string; history_json: string }
    | undefined;
  const nowIso = new Date().toISOString();
  const entry = { date: nowIso, action: params.action, points: params.points, refId: params.refId };

  if (!existing) {
    const badges = params.badge ? [params.badge] : [];
    db.prepare(`
      INSERT INTO rewards (id, user_id, points, households_verified, streak_days, badges_json, history_json)
      VALUES (?, ?, ?, 0, 1, ?, ?)
    `).run(`rew-${crypto.randomUUID().slice(0, 6)}`, params.userId, params.points, JSON.stringify(badges), JSON.stringify([entry]));
    return true;
  }

  const history = JSON.parse(existing.history_json || '[]') as Array<{ refId?: string }>;
  if (history.some((h) => h.refId === params.refId)) {
    return false; // Idempotent: prevent duplicate award for the same verified action
  }
  const badges = JSON.parse(existing.badges_json || '[]') as string[];
  if (params.badge && !badges.includes(params.badge)) {
    badges.push(params.badge);
  }
  const nextPoints = existing.points + params.points;
  if (nextPoints >= 100 && !badges.includes('Civic Guardian')) badges.push('Civic Guardian');
  if (nextPoints >= 250 && !badges.includes('City Champion')) badges.push('City Champion');

  history.unshift(entry);
  db.prepare(`UPDATE rewards SET points = ?, badges_json = ?, history_json = ? WHERE user_id = ?`).run(
    nextPoints,
    JSON.stringify(badges),
    JSON.stringify(history.slice(0, 40)),
    params.userId
  );
  return true;
}

function resolvePublicBaseUrl(req: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured && configured !== 'MY_APP_URL') {
    return configured.replace(/\/+$/, '');
  }
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`);
  return `${proto}://${host}`;
}

initDatabase();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '10mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip || 'local'}:${req.baseUrl || req.path}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please wait a few seconds and retry.' });
    }
    bucket.count += 1;
    next();
  };
}

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Invalid audio file type.'));
    }
  },
});

const uploadEvidence = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image or video evidence files are allowed.'));
    }
  },
});

// Real-time Server-Sent Events (authenticated notifications/updates trigger client refresh)
const sseClients = new Set<Response>();
function broadcastEvent(type: string, payload: Record<string, unknown>) {
  const data = `event: ${type}\ndata: ${JSON.stringify({ ...payload, timestamp: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepalive);
    }
  }, 25_000);
  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

// ============================================================================
// PUBLIC SYSTEM OVERVIEW (Genuine aggregated counts only, zero fake numbers)
// ============================================================================
app.get('/api/public/overview', (_req, res) => {
  const repTotal = (db.prepare(`SELECT COUNT(*) as c FROM civic_reports`).get() as { c: number }).c;
  const repResolved = (db.prepare(`SELECT COUNT(*) as c FROM civic_reports WHERE status = 'Resolved'`).get() as { c: number }).c;
  const routesCount = (db.prepare(`SELECT COUNT(*) as c FROM transit_routes WHERE verification_status = 'verified'`).get() as { c: number }).c;
  const vehiclesCount = (db.prepare(`SELECT COUNT(*) as c FROM transit_vehicles WHERE status = 'active'`).get() as { c: number }).c;
  const binsCount = (db.prepare(`SELECT COUNT(*) as c FROM waste_bins`).get() as { c: number }).c;
  const binsOverflow = (db.prepare(`SELECT COUNT(*) as c FROM waste_bins WHERE status = 'overflowing'`).get() as { c: number }).c;

  res.json({
    civic: { total: repTotal, resolved: repResolved, active: repTotal - repResolved },
    transit: { verifiedRoutes: routesCount, activeVehicles: vehiclesCount },
    waste: { totalBins: binsCount, overflowingBins: binsOverflow },
    geminiConfigured: isGeminiConfigured(),
  });
});

// ============================================================================
// COMPLETE ROLE-BASED AUTHENTICATION & SESSION MANAGEMENT
// ============================================================================
app.get('/api/auth/admin-status', (_req, res) => {
  res.json(getAdminConfigStatus());
});

app.post('/api/auth/claim-admin', rateLimit(10, 60_000), (req, res) => {
  const status = getAdminConfigStatus();
  if (status.envConfigured) {
    return res.status(409).json({ error: 'ADMIN_PASSCODE is configured via environment secrets.' });
  }
  if (status.claimed) {
    return res.status(409).json({ error: 'Administrator passcode has already been claimed.' });
  }
  const passcode = String(req.body?.passcode || '').trim();
  const name = String(req.body?.name || 'System Administrator').trim();
  const email = String(req.body?.email || 'admin@nagar.gov.in').trim().toLowerCase();

  if (passcode.length < 8) {
    return res.status(400).json({ error: 'Administrator passcode must be at least 8 characters.' });
  }

  const hash = hashPassword(passcode);
  db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('admin_passcode_hash', ?)`).run(hash);

  const recoveryKey = crypto.randomBytes(6).toString('hex').toUpperCase();
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string } | undefined;
  const userId = existing?.id || `adm-${crypto.randomUUID().slice(0, 8)}`;

  if (!existing) {
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, recovery_key_hash, role, preferred_language, created_at)
      VALUES (?, ?, ?, ?, ?, 'admin', 'en', ?)
    `).run(userId, name, email, hash, hashPassword(recoveryKey), new Date().toISOString());
  }

  const authUser = {
    id: userId,
    name,
    email,
    phone: '',
    role: 'admin' as UserRole,
    departmentId: '',
    preferredLanguage: 'en' as const,
  };
  const token = signToken(authUser);
  setSessionCookie(req, res, token);
  recordAudit(userId, 'admin', 'admin_claimed', 'system', 'admin_passcode');
  res.json({ token, user: authUser, recoveryKey });
});

app.post('/api/auth/admin-login', rateLimit(15, 60_000), (req, res) => {
  const passcode = String(req.body?.passcode || '');
  if (!verifyAdminPasscode(passcode)) {
    return res.status(401).json({ error: 'Invalid administrator passcode.' });
  }
  const email = 'admin@nagar.gov.in';
  let user = db.prepare(`SELECT * FROM users WHERE role = 'admin' AND account_status = 'active' LIMIT 1`).get() as
    | Record<string, unknown>
    | undefined;
  if (!user) {
    const id = `adm-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, preferred_language, created_at)
      VALUES (?, 'System Administrator', ?, ?, 'admin', 'en', ?)
    `).run(id, email, hashPassword(crypto.randomBytes(16).toString('hex')), new Date().toISOString());
    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Record<string, unknown>;
  }
  const authUser = {
    id: String(user.id),
    name: String(user.name),
    email: String(user.email),
    phone: String(user.phone || ''),
    role: 'admin' as UserRole,
    departmentId: '',
    preferredLanguage: (String(user.preferred_language) === 'hi' ? 'hi' : 'en') as 'en' | 'hi',
  };
  const token = signToken(authUser);
  setSessionCookie(req, res, token);
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(new Date().toISOString(), authUser.id);
  recordAudit(authUser.id, 'admin', 'admin_login', 'user', authUser.id);
  res.json({ token, user: authUser });
});

app.post('/api/auth/register', rateLimit(15, 60_000), (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const phone = String(req.body?.phone || '').trim();
  const password = String(req.body?.password || '');
  const role = String(req.body?.role || 'citizen') as UserRole;
  const preferredLanguage = req.body?.preferredLanguage === 'hi' ? 'hi' : 'en';

  if (!name || !email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid full name and email address are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (!['citizen', 'caregiver', 'transit_driver', 'sanitation_driver'].includes(role)) {
    return res.status(403).json({
      error: 'Self-registration is available for Citizens, Caregivers, Transport Drivers, and Sanitation Workers. Officer accounts are provisioned by an Administrator.',
    });
  }
  if (role === 'caregiver' && phone.replace(/[^0-9+]/g, '').length < 8) {
    return res.status(400).json({ error: 'Caregiver registration requires a valid mobile phone number to verify citizen links.' });
  }

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
  const nowIso = new Date().toISOString();
  const recoveryKey = crypto.randomBytes(6).toString('hex').toUpperCase();

  db.prepare(`
    INSERT INTO users (id, name, email, phone, password_hash, recovery_key_hash, role, preferred_language, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, phone, hashPassword(password), hashPassword(recoveryKey), role, preferredLanguage, nowIso);

  if (role === 'citizen') {
    db.prepare(`INSERT INTO citizen_profiles (user_id, emergency_phone, updated_at) VALUES (?, ?, ?)`).run(id, phone, nowIso);
    db.prepare(`INSERT INTO rewards (id, user_id, points) VALUES (?, ?, 0)`).run(`rew-${crypto.randomUUID().slice(0, 8)}`, id);
  }

  // If a caregiver registers with a phone number already added by a citizen, link caregiver_user_id automatically
  if (role === 'caregiver' && phone) {
    const cleanPhone = phone.replace(/\s+/g, '');
    db.prepare(`UPDATE caregiver_relationships SET caregiver_user_id = ? WHERE REPLACE(caregiver_phone, ' ', '') = ?`).run(
      id,
      cleanPhone
    );
  }

  const authUser = {
    id,
    name,
    email,
    phone,
    role,
    departmentId: '',
    preferredLanguage: preferredLanguage as 'en' | 'hi',
  };
  const token = signToken(authUser);
  setSessionCookie(req, res, token);
  recordAudit(id, role, 'user_registered', 'user', id);
  res.status(201).json({ token, user: authUser, recoveryKey });
});

app.post('/api/auth/login', rateLimit(20, 60_000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const expectedPortalRole = req.body?.portalRole ? String(req.body.portalRole) : null;

  const user = db.prepare(`SELECT * FROM users WHERE email = ? AND account_status = 'active'`).get(email) as
    | Record<string, unknown>
    | undefined;

  if (!user || !verifyPassword(password, String(user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const actualRole = String(user.role) as UserRole;
  if (expectedPortalRole && expectedPortalRole !== actualRole) {
    return res.status(403).json({
      error: `This account is registered as "${actualRole.replace('_', ' ')}", not "${expectedPortalRole.replace('_', ' ')}". Please select the matching portal.`,
    });
  }

  const authUser = {
    id: String(user.id),
    name: String(user.name),
    email: String(user.email),
    phone: String(user.phone || ''),
    role: actualRole,
    departmentId: String(user.department_id || ''),
    preferredLanguage: (String(user.preferred_language) === 'hi' ? 'hi' : 'en') as 'en' | 'hi',
  };
  const token = signToken(authUser);
  setSessionCookie(req, res, token);
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(new Date().toISOString(), authUser.id);
  recordAudit(authUser.id, actualRole, 'user_login', 'user', authUser.id);
  res.json({ token, user: authUser });
});

app.get('/api/auth/google/config', (req, res) => {
  const status = getGoogleAuthConfigStatus();
  const baseUrl = resolvePublicBaseUrl(req);
  res.json({
    ...status,
    redirectUri: `${baseUrl}/api/auth/google/callback`,
  });
});

app.get('/api/auth/google/url', (req, res) => {
  const portal = String(req.query.portal || 'citizen');
  if (!['citizen', 'caregiver', 'authority', 'admin'].includes(portal)) {
    return res.status(400).json({ error: 'Invalid portal role specified for Google Sign-In.' });
  }
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return res.status(503).json({
      error: 'Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are not configured on the server.',
      code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
    });
  }

  const baseUrl = resolvePublicBaseUrl(req);
  const redirectUri = `${baseUrl}/api/auth/google/callback`;
  const state = signOAuthState({
    portal,
    nonce: crypto.randomBytes(12).toString('hex'),
    origin: String(req.headers.origin || baseUrl),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });

  res.json({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    redirectUri,
  });
});

function renderGoogleCallbackPage(payload: { ok: boolean; error?: string; token?: string; user?: Record<string, unknown> }) {
  const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>NAGAR AI — Google Sign-In</title></head>
<body style="font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="text-align:center;max-width:380px;padding:24px">
    <p style="font-size:15px;font-weight:600;margin:0 0 8px">${payload.ok ? 'Sign-in verified' : 'Sign-in could not complete'}</p>
    <p style="font-size:13px;color:#94a3b8;margin:0">${payload.ok ? 'Returning to NAGAR AI...' : (payload.error || 'Authentication error.')}</p>
  </div>
  <script>
    (function(){
      var data = ${serialized};
      if (window.opener) {
        window.opener.postMessage({ type: data.ok ? 'NAGAR_GOOGLE_AUTH_SUCCESS' : 'NAGAR_GOOGLE_AUTH_ERROR', payload: data }, '*');
      }
      setTimeout(function(){ window.close(); }, 350);
    })();
  </script>
</body>
</html>`;
}

app.get(['/api/auth/google/callback', '/api/auth/google/callback/'], async (req, res) => {
  const code = String(req.query.code || '');
  const stateRaw = String(req.query.state || '');
  const errParam = String(req.query.error || '');

  if (errParam) {
    return res.status(400).send(renderGoogleCallbackPage({ ok: false, error: `Google sign-in cancelled (${errParam}).` }));
  }
  const state = verifyOAuthState(stateRaw);
  if (!state || !code) {
    return res.status(400).send(renderGoogleCallbackPage({ ok: false, error: 'Invalid or expired OAuth verification state.' }));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return res.status(503).send(renderGoogleCallbackPage({ ok: false, error: 'Google OAuth credentials missing on server.' }));
  }

  try {
    const baseUrl = resolvePublicBaseUrl(req);
    const redirectUri = `${baseUrl}/api/auth/google/callback`;
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const tokenData = (await tokenResp.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenResp.ok || !tokenData.access_token) {
      return res
        .status(401)
        .send(renderGoogleCallbackPage({ ok: false, error: tokenData.error_description || 'Failed to exchange Google authorization code.' }));
    }

    const profileResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(8000),
    });
    const profile = (await profileResp.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!profileResp.ok || !profile.email || !profile.email_verified) {
      return res.status(401).send(renderGoogleCallbackPage({ ok: false, error: 'Verified Google email address is required.' }));
    }

    const email = profile.email.trim().toLowerCase();
    const googleSub = String(profile.sub || '');
    const displayName = String(profile.name || email.split('@')[0]);
    const avatarUrl = String(profile.picture || '');
    const portal = state.portal as 'citizen' | 'caregiver' | 'authority' | 'admin';
    const nowIso = new Date().toISOString();

    let userRow = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as Record<string, unknown> | undefined;

    if (userRow && userRow.account_status !== 'active') {
      return res.status(403).send(renderGoogleCallbackPage({ ok: false, error: 'This account is suspended or inactive.' }));
    }

    if (portal === 'admin') {
      const superEmail = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
      if (!userRow && superEmail && email === superEmail) {
        const id = `adm-${crypto.randomUUID().slice(0, 8)}`;
        db.prepare(`
          INSERT INTO users (id, name, email, password_hash, role, preferred_language, auth_provider, google_sub, avatar_url, last_login_at, created_at)
          VALUES (?, ?, ?, ?, 'admin', 'en', 'google', ?, ?, ?, ?)
        `).run(id, displayName, email, hashPassword(crypto.randomBytes(16).toString('hex')), googleSub, avatarUrl, nowIso, nowIso);
        userRow = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Record<string, unknown>;
      } else if (!userRow || userRow.role !== 'admin') {
        return res.status(403).send(
          renderGoogleCallbackPage({
            ok: false,
            error: 'Admin Google Sign-In is restricted to pre-authorized Administrator emails.',
          })
        );
      }
    } else if (portal === 'authority') {
      if (!userRow || !['authority', 'transit_driver', 'sanitation_driver'].includes(String(userRow.role))) {
        return res.status(403).send(
          renderGoogleCallbackPage({
            ok: false,
            error: 'Officer Google Sign-In requires a pre-authorized officer account provisioned by an Administrator.',
          })
        );
      }
    } else if (portal === 'caregiver') {
      const secCfg = getAppConfigJson('security_settings', { allowCaregiverGoogleSignup: true, allowCitizenGoogleSignup: true });
      if (!userRow) {
        if (!secCfg.allowCaregiverGoogleSignup) {
          return res.status(403).send(renderGoogleCallbackPage({ ok: false, error: 'Google caregiver sign-up is disabled by administrator.' }));
        }
        const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
        const recoveryKey = crypto.randomBytes(6).toString('hex').toUpperCase();
        db.prepare(`
          INSERT INTO users (id, name, email, phone, password_hash, recovery_key_hash, role, preferred_language, auth_provider, google_sub, avatar_url, last_login_at, created_at)
          VALUES (?, ?, ?, '', ?, ?, 'caregiver', 'en', 'google', ?, ?, ?, ?)
        `).run(id, displayName, email, hashPassword(crypto.randomBytes(16).toString('hex')), hashPassword(recoveryKey), googleSub, avatarUrl, nowIso, nowIso);
        userRow = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Record<string, unknown>;
      } else if (userRow.role !== 'caregiver') {
        return res.status(403).send(
          renderGoogleCallbackPage({
            ok: false,
            error: `This Google email is registered under the "${String(userRow.role)}" role. Switch to the matching portal.`,
          })
        );
      }
    } else {
      const secCfg = getAppConfigJson('security_settings', { allowCaregiverGoogleSignup: true, allowCitizenGoogleSignup: true });
      if (!userRow) {
        if (!secCfg.allowCitizenGoogleSignup) {
          return res.status(403).send(renderGoogleCallbackPage({ ok: false, error: 'Google citizen sign-up is disabled by administrator.' }));
        }
        const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
        const recoveryKey = crypto.randomBytes(6).toString('hex').toUpperCase();
        db.prepare(`
          INSERT INTO users (id, name, email, phone, password_hash, recovery_key_hash, role, preferred_language, auth_provider, google_sub, avatar_url, last_login_at, created_at)
          VALUES (?, ?, ?, '', ?, ?, 'citizen', 'en', 'google', ?, ?, ?, ?)
        `).run(id, displayName, email, hashPassword(crypto.randomBytes(16).toString('hex')), hashPassword(recoveryKey), googleSub, avatarUrl, nowIso, nowIso);
        db.prepare(`INSERT INTO citizen_profiles (user_id, updated_at) VALUES (?, ?)`).run(id, nowIso);
        db.prepare(`INSERT INTO rewards (id, user_id, points) VALUES (?, ?, 0)`).run(`rew-${crypto.randomUUID().slice(0, 8)}`, id);
        userRow = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Record<string, unknown>;
      } else if (userRow.role !== 'citizen') {
        return res.status(403).send(
          renderGoogleCallbackPage({
            ok: false,
            error: `This Google email is registered under the "${String(userRow.role)}" role. Switch to the matching portal.`,
          })
        );
      }
    }

    db.prepare(`UPDATE users SET google_sub = COALESCE(NULLIF(google_sub, ''), ?), avatar_url = COALESCE(NULLIF(?, ''), avatar_url), last_login_at = ? WHERE id = ?`).run(
      googleSub,
      avatarUrl,
      nowIso,
      String(userRow.id)
    );

    const authUser = {
      id: String(userRow.id),
      name: String(userRow.name),
      email: String(userRow.email),
      phone: String(userRow.phone || ''),
      role: String(userRow.role) as UserRole,
      departmentId: String(userRow.department_id || ''),
      preferredLanguage: (String(userRow.preferred_language) === 'hi' ? 'hi' : 'en') as 'en' | 'hi',
    };
    const token = signToken(authUser);
    setSessionCookie(req, res, token);
    recordAudit(authUser.id, authUser.role, 'google_oauth_login', 'user', authUser.id, { portal });
    return res.send(renderGoogleCallbackPage({ ok: true, token, user: authUser }));
  } catch (err) {
    return res
      .status(500)
      .send(renderGoogleCallbackPage({ ok: false, error: err instanceof Error ? err.message : 'Google authentication failed.' }));
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/reset-password', rateLimit(10, 60_000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const recoveryKey = String(req.body?.recoveryKey || '').trim().toUpperCase();
  const newPassword = String(req.body?.newPassword || '');

  if (!email || !recoveryKey || newPassword.length < 6) {
    return res.status(400).json({ error: 'Email, account recovery key, and a new password (6+ chars) are required.' });
  }

  const user = db.prepare(`SELECT id, recovery_key_hash, role FROM users WHERE email = ? AND account_status = 'active'`).get(email) as
    | { id: string; recovery_key_hash: string; role: string }
    | undefined;

  if (!user || !user.recovery_key_hash || !verifyPassword(recoveryKey, user.recovery_key_hash)) {
    return res.status(401).json({ error: 'Invalid email or recovery key. Contact an Administrator if you lost your recovery key.' });
  }

  const nextRecoveryKey = crypto.randomBytes(6).toString('hex').toUpperCase();
  db.prepare(`UPDATE users SET password_hash = ?, recovery_key_hash = ? WHERE id = ?`).run(
    hashPassword(newPassword),
    hashPassword(nextRecoveryKey),
    user.id
  );
  recordAudit(user.id, user.role, 'password_reset', 'user', user.id);
  res.json({ ok: true, newRecoveryKey: nextRecoveryKey });
});

app.post('/api/auth/regenerate-recovery-key', requireAuth, (req: AuthenticatedRequest, res) => {
  const nextKey = crypto.randomBytes(6).toString('hex').toUpperCase();
  db.prepare(`UPDATE users SET recovery_key_hash = ? WHERE id = ?`).run(hashPassword(nextKey), req.authUser!.id);
  recordAudit(req.authUser!.id, req.authUser!.role, 'recovery_key_rotated', 'user', req.authUser!.id);
  res.json({ recoveryKey: nextKey });
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = db.prepare(`SELECT * FROM users WHERE id = ? AND account_status = 'active'`).get(req.authUser!.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return res.status(404).json({ error: 'Account not found.' });
  res.json({
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone || '',
      role: row.role,
      departmentId: row.department_id || '',
      preferredLanguage: row.preferred_language,
    },
    preferences: {
      voiceSettings: JSON.parse(String(row.voice_settings_json || '{}')),
      accessibility: JSON.parse(String(row.accessibility_json || '{}')),
      notifications: JSON.parse(String(row.notification_prefs_json || '{}')),
    },
  });
});

app.patch('/api/auth/preferences', requireAuth, (req: AuthenticatedRequest, res) => {
  const { preferredLanguage, voiceSettings, accessibility, notifications } = req.body || {};
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.authUser!.id) as Record<string, unknown>;
  if (!row) return res.status(404).json({ error: 'User not found.' });

  const lang = preferredLanguage === 'hi' ? 'hi' : preferredLanguage === 'en' ? 'en' : String(row.preferred_language);
  const vs = voiceSettings ? JSON.stringify(voiceSettings) : String(row.voice_settings_json);
  const acc = accessibility ? JSON.stringify(accessibility) : String(row.accessibility_json);
  const np = notifications ? JSON.stringify(notifications) : String(row.notification_prefs_json);

  db.prepare(`
    UPDATE users SET preferred_language = ?, voice_settings_json = ?, accessibility_json = ?, notification_prefs_json = ? WHERE id = ?
  `).run(lang, vs, acc, np, req.authUser!.id);

  res.json({ ok: true, preferredLanguage: lang });
});

app.delete('/api/auth/account', requireAuth, (req: AuthenticatedRequest, res) => {
  db.prepare(`UPDATE users SET account_status = 'deleted', email = ? WHERE id = ?`).run(
    `deleted-${req.authUser!.id}@removed.local`,
    req.authUser!.id
  );
  clearSessionCookie(req, res);
  recordAudit(req.authUser!.id, req.authUser!.role, 'account_deleted', 'user', req.authUser!.id);
  res.json({ ok: true });
});

// ============================================================================
// ADMINISTRATOR DASHBOARD APIs (STRICTLY role === 'admin')
// ============================================================================
app.get('/api/admin/overview', requireAuth, requireRole('admin'), async (_req, res) => {
  const usersByRole = db
    .prepare(`SELECT role, COUNT(*) as count FROM users WHERE account_status != 'deleted' GROUP BY role`)
    .all() as Array<{ role: string; count: number }>;
  const reportsByStatus = db
    .prepare(`SELECT status, COUNT(*) as count FROM civic_reports GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;
  const totalUsers = (db.prepare(`SELECT COUNT(*) as c FROM users WHERE account_status != 'deleted'`).get() as { c: number }).c;
  const totalReports = (db.prepare(`SELECT COUNT(*) as c FROM civic_reports`).get() as { c: number }).c;
  const totalOfficers = (db.prepare(`SELECT COUNT(*) as c FROM officers`).get() as { c: number }).c;
  const activeSosCount = (db.prepare(`SELECT COUNT(*) as c FROM sos_incidents WHERE status = 'active'`).get() as { c: number }).c;
  const totalGrievances = (db.prepare(`SELECT COUNT(*) as c FROM authority_grievances`).get() as { c: number }).c;
  const openGrievances = (db.prepare(`SELECT COUNT(*) as c FROM authority_grievances WHERE status NOT IN ('Resolved', 'Dismissed')`).get() as { c: number }).c;
  const totalMedicalRequests = (db.prepare(`SELECT COUNT(*) as c FROM medical_requests`).get() as { c: number }).c;
  const activeMedicalRequests = (db.prepare(`SELECT COUNT(*) as c FROM medical_requests WHERE status NOT IN ('Resolved', 'Cancelled')`).get() as { c: number }).c;
  const recentUsers = db
    .prepare(`SELECT id, name, email, phone, role, department_id, account_status, auth_provider, last_login_at, created_at FROM users WHERE account_status != 'deleted' ORDER BY created_at DESC LIMIT 100`)
    .all();
  const auditLogs = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100`).all();
  const departments = db.prepare(`SELECT * FROM departments ORDER BY name ASC`).all();
  const officers = db
    .prepare(`SELECT o.*, d.name as department_name, u.email as account_email, u.account_status FROM officers o JOIN departments d ON o.department_id = d.id LEFT JOIN users u ON o.user_id = u.id ORDER BY o.name ASC`)
    .all();
  const slaRules = db
    .prepare(`SELECT s.*, d.name as department_name FROM sla_rules s JOIN departments d ON s.department_id = d.id ORDER BY s.category ASC`)
    .all();
  const caregiverLinks = db
    .prepare(
      `SELECT cr.*, u.name as citizen_name, u.email as citizen_email
       FROM caregiver_relationships cr JOIN users u ON cr.citizen_id = u.id
       ORDER BY cr.updated_at DESC LIMIT 80`
    )
    .all();
  const grievances = (db
    .prepare(
      `SELECT g.*, u.name as citizen_name, u.email as citizen_email, d.name as department_name
       FROM authority_grievances g
       JOIN users u ON g.citizen_id = u.id
       LEFT JOIN departments d ON g.target_department_id = d.id
       ORDER BY g.created_at DESC LIMIT 80`
    )
    .all() as Array<Record<string, unknown>>)
    .map((g) => ({
      ...g,
      evidenceUrls: JSON.parse(String(g.evidence_urls_json || '[]')),
      resolutionEvidenceUrls: JSON.parse(String(g.resolution_evidence_urls_json || '[]')),
    }));
  const medicalRequests = db
    .prepare(
      `SELECT m.*, u.name as citizen_name, u.phone as citizen_phone
       FROM medical_requests m JOIN users u ON m.citizen_id = u.id
       ORDER BY m.created_at DESC LIMIT 80`
    )
    .all();
  const smsLogs = db
    .prepare(`SELECT id, event_type, caregiver_phone, sms_status, sms_error, whatsapp_status, created_at FROM caregiver_notifications ORDER BY created_at DESC LIMIT 40`)
    .all();

  const elevenStatus = await checkElevenLabsStatus(false);

  res.json({
    totalUsers,
    totalReports,
    totalOfficers,
    activeSosCount,
    totalGrievances,
    openGrievances,
    totalMedicalRequests,
    activeMedicalRequests,
    usersByRole,
    reportsByStatus,
    recentUsers,
    departments,
    officers,
    slaRules,
    caregiverLinks,
    grievances,
    medicalRequests,
    smsLogs,
    auditLogs,
    rewardConfig: getAppConfigJson('reward_config', {
      verifiedReportPoints: 20,
      resolutionConfirmedPoints: 30,
      segregationPoints: 25,
      maxDailyClaims: 10,
    }),
    securitySettings: getAppConfigJson('security_settings', {
      sessionTtlHours: 12,
      allowCitizenGoogleSignup: true,
      allowCaregiverGoogleSignup: true,
    }),
    messagingProvider: getMessagingProviderStatus(),
    geminiConfigured: isGeminiConfigured(),
    elevenLabsConfigured: elevenStatus.configured,
    googleOAuth: getGoogleAuthConfigStatus(),
  });
});

app.post('/api/admin/officers', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const phone = String(req.body?.phone || '').trim();
  const password = String(req.body?.password || '');
  const departmentId = String(req.body?.departmentId || '').trim();
  const badgeNo = String(req.body?.badgeNo || '').trim().toUpperCase();
  const ward = String(req.body?.ward || 'Central Ward').trim();

  if (!name || !email || !email.includes('@') || password.length < 6 || !departmentId || !badgeNo) {
    return res.status(400).json({ error: 'Name, email, password (6+ chars), department, and badge number are required.' });
  }
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  const userId = `usr-${crypto.randomUUID().slice(0, 8)}`;
  const officerId = `off-${crypto.randomUUID().slice(0, 6)}`;
  const recoveryKey = crypto.randomBytes(6).toString('hex').toUpperCase();
  const nowIso = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (id, name, email, phone, password_hash, recovery_key_hash, role, department_id, preferred_language, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'authority', ?, 'en', ?)
  `).run(userId, name, email, phone, hashPassword(password), hashPassword(recoveryKey), departmentId, nowIso);

  db.prepare(`INSERT INTO officers (id, user_id, department_id, name, badge_no, ward, email, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`).run(
    officerId,
    userId,
    departmentId,
    name,
    badgeNo,
    ward,
    email,
    phone
  );

  recordAudit(req.authUser!.id, 'admin', 'create_officer_account', 'officer', officerId, { departmentId, badgeNo });
  res.status(201).json({ userId, officerId, name, email, badgeNo, recoveryKey });
});

app.post('/api/admin/admins', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || crypto.randomBytes(12).toString('hex'));

  if (!name || !email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid administrator name and email address are required.' });
  }
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  const userId = `adm-${crypto.randomUUID().slice(0, 8)}`;
  const recoveryKey = crypto.randomBytes(6).toString('hex').toUpperCase();
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, recovery_key_hash, role, preferred_language, created_at)
    VALUES (?, ?, ?, ?, ?, 'admin', 'en', ?)
  `).run(userId, name, email, hashPassword(password), hashPassword(recoveryKey), new Date().toISOString());

  recordAudit(req.authUser!.id, 'admin', 'authorize_admin_email', 'user', userId, { email });
  res.status(201).json({ id: userId, name, email, recoveryKey });
});

app.patch('/api/admin/users/:id/status', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const status = ['active', 'suspended'].includes(req.body?.accountStatus) ? req.body.accountStatus : null;
  if (!status) return res.status(400).json({ error: 'Status must be active or suspended.' });
  if (req.params.id === req.authUser!.id) {
    return res.status(400).json({ error: 'You cannot suspend your own administrator account.' });
  }
  db.prepare(`UPDATE users SET account_status = ? WHERE id = ?`).run(status, req.params.id);
  db.prepare(`UPDATE officers SET status = ? WHERE user_id = ?`).run(status, req.params.id);
  recordAudit(req.authUser!.id, 'admin', 'update_user_status', 'user', req.params.id, { status });
  res.json({ ok: true, accountStatus: status });
});

app.post('/api/admin/departments', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const name = String(req.body?.name || '').trim();
  const code = String(req.body?.code || '').trim().toUpperCase();
  const slaHours = Math.max(4, Math.min(720, Number(req.body?.slaHours) || 48));
  const headName = String(req.body?.headName || 'Department Head').trim();
  if (!name || !code) return res.status(400).json({ error: 'Department name and code are required.' });
  const id = `dept-${crypto.randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO departments (id, name, code, sla_hours, head_name, is_active) VALUES (?, ?, ?, ?, ?, 1)`).run(
    id,
    name,
    code,
    slaHours,
    headName
  );
  recordAudit(req.authUser!.id, 'admin', 'create_department', 'department', id, { name, code, slaHours });
  res.status(201).json({ id, name, code, slaHours, headName });
});

app.patch('/api/admin/departments/:id', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const dept = db.prepare(`SELECT * FROM departments WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!dept) return res.status(404).json({ error: 'Department not found.' });
  const name = req.body?.name ? String(req.body.name).trim() : String(dept.name);
  const slaHours = req.body?.slaHours ? Math.max(4, Math.min(720, Number(req.body.slaHours))) : Number(dept.sla_hours);
  const headName = req.body?.headName ? String(req.body.headName).trim() : String(dept.head_name);
  const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : Number(dept.is_active ?? 1);

  db.prepare(`UPDATE departments SET name = ?, sla_hours = ?, head_name = ?, is_active = ? WHERE id = ?`).run(
    name,
    slaHours,
    headName,
    isActive,
    req.params.id
  );
  recordAudit(req.authUser!.id, 'admin', 'update_department', 'department', req.params.id, { name, slaHours, isActive });
  res.json({ ok: true });
});

app.put('/api/admin/sla-rules', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
  const nowIso = new Date().toISOString();
  const stmt = db.prepare(`UPDATE sla_rules SET department_id = ?, sla_hours = ?, escalation_hours = ?, updated_at = ? WHERE id = ?`);
  for (const r of rules) {
    if (r?.id && r?.departmentId) {
      stmt.run(String(r.departmentId), Math.max(4, Number(r.slaHours) || 48), Math.max(1, Number(r.escalationHours) || 24), nowIso, String(r.id));
    }
  }
  recordAudit(req.authUser!.id, 'admin', 'update_sla_rules', 'system', 'sla_rules');
  res.json({ ok: true });
});

app.put('/api/admin/reward-config', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const next = {
    verifiedReportPoints: Math.max(0, Math.min(500, Number(req.body?.verifiedReportPoints) || 20)),
    resolutionConfirmedPoints: Math.max(0, Math.min(500, Number(req.body?.resolutionConfirmedPoints) || 30)),
    segregationPoints: Math.max(0, Math.min(500, Number(req.body?.segregationPoints) || 25)),
    maxDailyClaims: Math.max(1, Math.min(50, Number(req.body?.maxDailyClaims) || 10)),
  };
  db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('reward_config', ?)`).run(JSON.stringify(next));
  recordAudit(req.authUser!.id, 'admin', 'update_reward_config', 'system', 'reward_config', next);
  res.json({ ok: true, rewardConfig: next });
});

app.put('/api/admin/security-settings', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const next = {
    sessionTtlHours: Math.max(1, Math.min(168, Number(req.body?.sessionTtlHours) || 12)),
    allowCitizenGoogleSignup: Boolean(req.body?.allowCitizenGoogleSignup ?? true),
    allowCaregiverGoogleSignup: Boolean(req.body?.allowCaregiverGoogleSignup ?? true),
  };
  db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('security_settings', ?)`).run(JSON.stringify(next));
  recordAudit(req.authUser!.id, 'admin', 'update_security_settings', 'system', 'security_settings', next);
  res.json({ ok: true, securitySettings: next });
});

app.post('/api/admin/notifications/broadcast', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const targetRole = String(req.body?.targetRole || 'citizen');
  const title = String(req.body?.title || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!title || !message) return res.status(400).json({ error: 'Broadcast title and message are required.' });

  const users =
    targetRole === 'all'
      ? (db.prepare(`SELECT id, role FROM users WHERE account_status = 'active'`).all() as Array<{ id: string; role: string }>)
      : (db.prepare(`SELECT id, role FROM users WHERE account_status = 'active' AND role = ?`).all(targetRole) as Array<{
          id: string;
          role: string;
        }>);

  const nowIso = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, ?, 'admin_broadcast', ?, ?, ?, '', 0, ?)
  `);
  for (const u of users) {
    ins.run(`not-${crypto.randomUUID().slice(0, 8)}`, u.id, u.role, title, message, message, nowIso);
  }
  recordAudit(req.authUser!.id, 'admin', 'broadcast_notification', 'notification', targetRole, { count: users.length, title });
  broadcastEvent('notification_broadcast', { targetRole, title });
  res.json({ ok: true, sentCount: users.length });
});

app.post('/api/admin/caregiver-links/:id/revoke', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const nowIso = new Date().toISOString();
  db.prepare(`UPDATE caregiver_relationships SET status = 'revoked', updated_at = ? WHERE id = ?`).run(nowIso, req.params.id);
  db.prepare(`UPDATE caregiver_access_tokens SET revoked_at = ? WHERE relationship_id = ? AND revoked_at = ''`).run(nowIso, req.params.id);
  recordAudit(req.authUser!.id, 'admin', 'admin_revoke_caregiver_link', 'caregiver_relationship', req.params.id);
  res.json({ ok: true });
});

// ============================================================================
// GEOLOCATION & NEARBY PUBLIC PLACES / MEDICAL ASSISTANCE (OVERPASS API)
// ============================================================================
app.get('/api/geo/reverse', rateLimit(40, 60_000), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid latitude or longitude coordinates.' });
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'NAGAR-AI-SmartCity/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error('Reverse geocoding service unavailable');
    const data = (await resp.json()) as { display_name?: string; address?: Record<string, string> };
    res.json({
      lat,
      lng,
      address: data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      ward: data.address?.suburb || data.address?.city_district || data.address?.neighbourhood || 'Local Ward',
    });
  } catch {
    res.json({
      lat,
      lng,
      address: `Coordinates ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      ward: 'Detected Zone',
      geocodingFallback: true,
    });
  }
});

app.get('/api/geo/search', rateLimit(30, 60_000), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'NAGAR-AI-SmartCity/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return res.json({ results: [] });
    const list = (await resp.json()) as Array<{ display_name: string; lat: string; lon: string }>;
    res.json({
      results: list.map((item) => ({
        name: item.display_name,
        lat: Number(item.lat),
        lng: Number(item.lon),
      })),
    });
  } catch {
    res.json({ results: [] });
  }
});

app.get('/api/places/nearby', requireAuth, rateLimit(25, 60_000), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radiusKm) || 5;
  const category = String(req.query.category || 'all') as FacilityCategory;
  const query = String(req.query.q || '');
  const forceRefresh = req.query.refresh === 'true';

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Valid current GPS latitude and longitude are required to search nearby facilities.' });
  }

  const allowedCats: FacilityCategory[] = ['all', 'hospital', 'police', 'clinic', 'pharmacy', 'emergency'];
  const safeCat = allowedCats.includes(category) ? category : 'all';

  const result = await fetchNearbyFacilities({
    lat,
    lng,
    radiusKm,
    category: safeCat,
    query,
    forceRefresh,
  });

  res.json(result);
});

// ============================================================================
// WOMEN SAFETY, CAREGIVER LINKING, LIVE LOCATION & SOS EMERGENCY
// ============================================================================
app.get('/api/citizen/dashboard-summary', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const reports = db
    .prepare(`SELECT id, report_code, category, title, status, severity, address, updated_at FROM civic_reports WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as Array<Record<string, unknown>>;
  const grievances = db
    .prepare(`SELECT id, grievance_code, title, status, updated_at FROM authority_grievances WHERE citizen_id = ? ORDER BY created_at DESC`)
    .all(userId) as Array<Record<string, unknown>>;
  const medicalRequests = db
    .prepare(`SELECT id, request_code, request_type, urgency, status, selected_facility_name, updated_at FROM medical_requests WHERE citizen_id = ? ORDER BY created_at DESC`)
    .all(userId) as Array<Record<string, unknown>>;
  const activeSos = db
    .prepare(`SELECT id, incident_code, status, trigger_address, created_at FROM sos_incidents WHERE citizen_id = ? AND status IN ('active', 'acknowledged') ORDER BY created_at DESC LIMIT 1`)
    .get(userId);
  const activeSession = db
    .prepare(`SELECT id, status, expires_at, last_address, last_location_at FROM safety_sessions WHERE citizen_id = ? AND status = 'active' AND expires_at > ? ORDER BY started_at DESC LIMIT 1`)
    .get(userId, new Date().toISOString());
  const caregiversCount = (
    db.prepare(`SELECT COUNT(*) as c FROM caregiver_relationships WHERE citizen_id = ? AND status = 'active'`).get(userId) as { c: number }
  ).c;
  const rewards = db.prepare(`SELECT points, badges_json, streak_days FROM rewards WHERE user_id = ?`).get(userId) as
    | { points: number; badges_json: string; streak_days: number }
    | undefined;
  const unreadNotifications = (
    db.prepare(`SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0`).get(userId) as { c: number }
  ).c;

  res.json({
    reports: {
      total: reports.length,
      pending: reports.filter((r) => ['Submitted', 'Under Review', 'Verified', 'Assigned', 'In Progress', 'Reopened', 'Escalated'].includes(String(r.status))).length,
      resolved: reports.filter((r) => r.status === 'Resolved').length,
      recent: reports.slice(0, 4),
    },
    grievances: {
      total: grievances.length,
      open: grievances.filter((g) => !['Resolved', 'Dismissed'].includes(String(g.status))).length,
      recent: grievances.slice(0, 3),
    },
    medical: {
      total: medicalRequests.length,
      active: medicalRequests.filter((m) => !['Resolved', 'Cancelled'].includes(String(m.status))).length,
      recent: medicalRequests.slice(0, 3),
    },
    safety: {
      activeSession: activeSession || null,
      activeSos: activeSos || null,
      verifiedCaregivers: caregiversCount,
    },
    rewards: {
      points: rewards?.points || 0,
      badges: rewards ? JSON.parse(rewards.badges_json || '[]') : [],
      streakDays: rewards?.streak_days || 0,
    },
    unreadNotifications,
  });
});

app.get('/api/safety/dashboard', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const profile = db.prepare(`SELECT * FROM citizen_profiles WHERE user_id = ?`).get(userId) || {
    user_id: userId,
    blood_group: '',
    medical_notes: '',
    emergency_phone: req.authUser!.phone || '',
    home_ward: '',
  };
  const contacts = db.prepare(`SELECT * FROM emergency_contacts WHERE user_id = ? ORDER BY is_primary DESC, created_at DESC`).all(userId);
  const caregivers = db
    .prepare(
      `SELECT id, caregiver_name, caregiver_phone, status, notify_in_app, notify_sms, notify_whatsapp,
              can_view_location, can_receive_sos, can_view_profile, verified_at, created_at, updated_at
       FROM caregiver_relationships WHERE citizen_id = ? ORDER BY created_at DESC`
    )
    .all(userId);
  const activeTokens = db
    .prepare(
      `SELECT id, relationship_id, expires_at, revoked_at, last_accessed_at, created_at
       FROM caregiver_access_tokens WHERE citizen_id = ? AND revoked_at = '' ORDER BY created_at DESC`
    )
    .all(userId);
  const zones = db
    .prepare(`SELECT * FROM safety_zones WHERE citizen_id = ? ORDER BY created_at DESC`)
    .all(userId);
  const activeSession = db
    .prepare(`SELECT * FROM safety_sessions WHERE citizen_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`)
    .get(userId) as Record<string, unknown> | undefined;

  // Auto-expire session if duration elapsed
  let validSession = activeSession || null;
  if (activeSession && new Date(String(activeSession.expires_at)) <= new Date()) {
    db.prepare(`UPDATE safety_sessions SET status = 'expired' WHERE id = ?`).run(String(activeSession.id));
    validSession = null;
  }

  const sosIncidents = db
    .prepare(`SELECT * FROM sos_incidents WHERE citizen_id = ? ORDER BY created_at DESC LIMIT 20`)
    .all(userId);
  const caregiverNotifications = db
    .prepare(`SELECT * FROM caregiver_notifications WHERE citizen_id = ? ORDER BY created_at DESC LIMIT 30`)
    .all(userId);

  res.json({
    profile,
    contacts,
    caregivers,
    activeTokens,
    zones,
    activeSession: validSession,
    sosIncidents,
    caregiverNotifications,
    messagingProvider: getMessagingProviderStatus(),
  });
});

app.get('/api/safety/zones', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const zones = db.prepare(`SELECT * FROM safety_zones WHERE citizen_id = ? ORDER BY created_at DESC`).all(req.authUser!.id);
  res.json({ zones });
});

app.post('/api/safety/zones', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const name = String(req.body?.name || '').trim();
  const zoneType = req.body?.zoneType === 'alert_zone' ? 'alert_zone' : 'safe_zone';
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const radiusM = Math.max(50, Math.min(5000, Number(req.body?.radiusM) || 250));
  const address = String(req.body?.address || '').trim();
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Zone name and valid coordinates are required.' });
  }
  const id = `sz-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO safety_zones (id, citizen_id, name, zone_type, lat, lng, radius_m, address, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, req.authUser!.id, name, zoneType, lat, lng, radiusM, address, new Date().toISOString());
  res.status(201).json({ id });
});

app.delete('/api/safety/zones/:id', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  db.prepare(`DELETE FROM safety_zones WHERE id = ? AND citizen_id = ?`).run(req.params.id, req.authUser!.id);
  res.json({ ok: true });
});

app.put('/api/safety/profile', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const { bloodGroup, medicalNotes, emergencyPhone, homeWard } = req.body || {};
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO citizen_profiles (user_id, blood_group, medical_notes, emergency_phone, home_ward, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      blood_group = excluded.blood_group,
      medical_notes = excluded.medical_notes,
      emergency_phone = excluded.emergency_phone,
      home_ward = excluded.home_ward,
      updated_at = excluded.updated_at
  `).run(
    req.authUser!.id,
    String(bloodGroup || ''),
    String(medicalNotes || ''),
    String(emergencyPhone || ''),
    String(homeWard || ''),
    nowIso
  );
  res.json({ ok: true });
});

app.post('/api/safety/emergency-contacts', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const name = String(req.body?.name || '').trim();
  const relationship = String(req.body?.relationship || 'Family').trim();
  const phone = String(req.body?.phone || '').trim();
  const isPrimary = req.body?.isPrimary ? 1 : 0;
  if (!name || phone.length < 7) return res.status(400).json({ error: 'Contact name and valid phone number required.' });
  const id = `ec-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO emergency_contacts (id, user_id, name, relationship, phone, is_primary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.authUser!.id, name, relationship, phone, isPrimary, new Date().toISOString());
  res.status(201).json({ id });
});

app.delete('/api/safety/emergency-contacts/:id', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  db.prepare(`DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?`).run(req.params.id, req.authUser!.id);
  res.json({ ok: true });
});

app.post('/api/safety/caregivers', requireAuth, requireRole('citizen'), async (req: AuthenticatedRequest, res) => {
  const caregiverName = String(req.body?.caregiverName || '').trim();
  const caregiverPhone = String(req.body?.caregiverPhone || '').trim();
  const notifySms = req.body?.notifySms ? 1 : 0;
  const notifyWhatsapp = req.body?.notifyWhatsapp ? 1 : 0;

  if (!caregiverName || caregiverPhone.replace(/[^0-9+]/g, '').length < 8) {
    return res.status(400).json({ error: 'Caregiver name and a valid mobile number are required.' });
  }

  const cleanPhone = caregiverPhone.replace(/\s+/g, '');
  const matchedUser = db
    .prepare(`SELECT id FROM users WHERE REPLACE(phone, ' ', '') = ? AND role = 'caregiver' AND account_status = 'active'`)
    .get(cleanPhone) as { id: string } | undefined;

  const verificationCode = String(Math.floor(100000 + Math.random() * 900000));
  const id = `cg-${crypto.randomUUID().slice(0, 8)}`;
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO caregiver_relationships (
      id, citizen_id, caregiver_user_id, caregiver_name, caregiver_phone, status,
      verification_code_hash, verification_expires_at, notify_in_app, notify_sms, notify_whatsapp,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending_verification', ?, ?, 1, ?, ?, ?, ?)
  `).run(
    id,
    req.authUser!.id,
    matchedUser?.id || '',
    caregiverName,
    cleanPhone,
    hashPassword(verificationCode),
    expiresAt,
    notifySms,
    notifyWhatsapp,
    nowIso,
    nowIso
  );

  let smsResult: { status: string; error?: string } = { status: 'not_configured' };
  if (notifySms) {
    smsResult = await dispatchSms(
      cleanPhone,
      `NAGAR AI Caregiver Verification: ${req.authUser!.name} invited you as a safety caregiver. Enter verification code ${verificationCode} in the Caregiver Portal.`
    );
  }

  recordAudit(req.authUser!.id, 'citizen', 'add_caregiver', 'caregiver_relationship', id, { caregiverPhone: cleanPhone });
  res.status(201).json({
    id,
    status: 'pending_verification',
    smsDelivery: smsResult,
    verificationCode: smsResult.status === 'sent' ? undefined : verificationCode,
  });
});

app.post('/api/safety/caregivers/:id/approve', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const rel = db
    .prepare(`SELECT * FROM caregiver_relationships WHERE id = ? AND citizen_id = ?`)
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;

  if (!rel) return res.status(404).json({ error: 'Caregiver link not found.' });
  if (rel.status === 'pending_verification') {
    return res.status(400).json({ error: 'Caregiver must verify their identity in the Caregiver Portal before approval.' });
  }
  if (rel.status === 'revoked' || rel.status === 'disconnected') {
    return res.status(400).json({ error: 'This caregiver link was revoked. Add a new caregiver request.' });
  }

  const ttlHours = Math.max(1, Math.min(720, Number(req.body?.expiresHours) || 168));
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenId = `cat-${crypto.randomUUID().slice(0, 8)}`;
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  db.prepare(`UPDATE caregiver_relationships SET status = 'active', updated_at = ? WHERE id = ?`).run(nowIso, req.params.id);
  db.prepare(`
    INSERT INTO caregiver_access_tokens (id, relationship_id, citizen_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tokenId, req.params.id, req.authUser!.id, hashAccessToken(rawToken), expiresAt, nowIso);

  notifyLinkedCaregivers({
    citizenId: req.authUser!.id,
    onlyRelationshipId: req.params.id,
    eventType: 'safety_status_changed',
    title: 'Caregiver Link Approved',
    message: `${req.authUser!.name} approved your caregiver safety access.`,
  }).catch(() => {});

  recordAudit(req.authUser!.id, 'citizen', 'approve_caregiver', 'caregiver_relationship', req.params.id);
  res.json({ ok: true, accessToken: rawToken, expiresAt });
});

app.post('/api/safety/caregivers/:id/revoke', requireAuth, requireRole('citizen'), async (req: AuthenticatedRequest, res) => {
  const rel = db
    .prepare(`SELECT * FROM caregiver_relationships WHERE id = ? AND citizen_id = ?`)
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!rel) return res.status(404).json({ error: 'Caregiver link not found.' });

  const nowIso = new Date().toISOString();
  await notifyLinkedCaregivers({
    citizenId: req.authUser!.id,
    onlyRelationshipId: req.params.id,
    eventType: 'permission_revoked',
    title: 'Location Access Revoked',
    message: `${req.authUser!.name} revoked your caregiver location-sharing permission.`,
  });

  db.prepare(`UPDATE caregiver_relationships SET status = 'revoked', updated_at = ? WHERE id = ?`).run(nowIso, req.params.id);
  db.prepare(`UPDATE caregiver_access_tokens SET revoked_at = ? WHERE relationship_id = ? AND revoked_at = ''`).run(
    nowIso,
    req.params.id
  );

  recordAudit(req.authUser!.id, 'citizen', 'revoke_caregiver', 'caregiver_relationship', req.params.id);
  res.json({ ok: true });
});

app.patch('/api/safety/caregivers/:id/permissions', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const rel = db
    .prepare(`SELECT * FROM caregiver_relationships WHERE id = ? AND citizen_id = ?`)
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!rel) return res.status(404).json({ error: 'Caregiver link not found.' });

  const canViewLocation = req.body?.canViewLocation !== undefined ? (req.body.canViewLocation ? 1 : 0) : Number(rel.can_view_location ?? 1);
  const canReceiveSos = req.body?.canReceiveSos !== undefined ? (req.body.canReceiveSos ? 1 : 0) : Number(rel.can_receive_sos ?? 1);
  const canViewProfile = req.body?.canViewProfile !== undefined ? (req.body.canViewProfile ? 1 : 0) : Number(rel.can_view_profile ?? 1);
  const notifySms = req.body?.notifySms !== undefined ? (req.body.notifySms ? 1 : 0) : Number(rel.notify_sms ?? 0);
  const notifyWhatsapp = req.body?.notifyWhatsapp !== undefined ? (req.body.notifyWhatsapp ? 1 : 0) : Number(rel.notify_whatsapp ?? 0);
  const nowIso = new Date().toISOString();

  db.prepare(`
    UPDATE caregiver_relationships
    SET can_view_location = ?, can_receive_sos = ?, can_view_profile = ?, notify_sms = ?, notify_whatsapp = ?, updated_at = ?
    WHERE id = ? AND citizen_id = ?
  `).run(canViewLocation, canReceiveSos, canViewProfile, notifySms, notifyWhatsapp, nowIso, req.params.id, req.authUser!.id);

  recordAudit(req.authUser!.id, 'citizen', 'update_caregiver_permissions', 'caregiver_relationship', req.params.id, {
    canViewLocation,
    canReceiveSos,
    canViewProfile,
  });
  res.json({ ok: true });
});

app.post('/api/safety/caregiver-notifications/:id/retry', requireAuth, requireRole('citizen'), async (req: AuthenticatedRequest, res) => {
  try {
    const result = await retryCaregiverNotification(req.params.id, req.authUser!.id);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Retry failed.' });
  }
});

app.post('/api/safety/session/start', requireAuth, requireRole('citizen'), async (req: AuthenticatedRequest, res) => {
  const durationMinutes = Math.max(5, Math.min(480, Number(req.body?.durationMinutes) || 60));
  const lat = Number.isFinite(Number(req.body?.lat)) ? Number(req.body.lat) : null;
  const lng = Number.isFinite(Number(req.body?.lng)) ? Number(req.body.lng) : null;
  const accuracyM = Number.isFinite(Number(req.body?.accuracyM)) ? Number(req.body.accuracyM) : null;
  const address = String(req.body?.address || '');
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();

  // Close any prior active session cleanly
  db.prepare(`UPDATE safety_sessions SET status = 'stopped', stopped_at = ? WHERE citizen_id = ? AND status = 'active'`).run(
    nowIso,
    req.authUser!.id
  );

  const sessionId = `ss-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO safety_sessions (id, citizen_id, status, duration_minutes, started_at, expires_at, last_lat, last_lng, last_accuracy_m, last_address, last_location_at)
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, req.authUser!.id, durationMinutes, nowIso, expiresAt, lat, lng, accuracyM, address, lat !== null ? nowIso : '');

  if (lat !== null && lng !== null) {
    db.prepare(`
      INSERT INTO location_updates (id, session_id, citizen_id, lat, lng, accuracy_m, address, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'gps', ?)
    `).run(`lu-${crypto.randomUUID().slice(0, 8)}`, sessionId, req.authUser!.id, lat, lng, accuracyM, address, nowIso);
  }

  const notified = await notifyLinkedCaregivers({
    citizenId: req.authUser!.id,
    eventType: 'safety_activated',
    title: 'Women Safety Mode Activated',
    message: `${req.authUser!.name} enabled live safety location sharing for ${durationMinutes} min${address ? ` near ${address}` : ''}.`,
  });

  recordAudit(req.authUser!.id, 'citizen', 'start_safety_session', 'safety_session', sessionId, { durationMinutes });
  broadcastEvent('safety_updated', { citizenId: req.authUser!.id });
  res.status(201).json({ sessionId, expiresAt, notifiedCount: notified.length });
});

app.post('/api/safety/session/location', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracyM = Number.isFinite(Number(req.body?.accuracyM)) ? Number(req.body.accuracyM) : null;
  const address = String(req.body?.address || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Valid GPS latitude and longitude required.' });
  }

  const session = db
    .prepare(`SELECT id, expires_at FROM safety_sessions WHERE citizen_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`)
    .get(req.authUser!.id) as { id: string; expires_at: string } | undefined;

  if (!session) return res.status(404).json({ error: 'No active safety sharing session.' });
  if (new Date(session.expires_at) <= new Date()) {
    db.prepare(`UPDATE safety_sessions SET status = 'expired' WHERE id = ?`).run(session.id);
    return res.status(410).json({ error: 'Safety sharing session has expired.' });
  }

  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE safety_sessions SET last_lat = ?, last_lng = ?, last_accuracy_m = ?, last_address = ?, last_location_at = ? WHERE id = ?
  `).run(lat, lng, accuracyM, address, nowIso, session.id);

  db.prepare(`
    INSERT INTO location_updates (id, session_id, citizen_id, lat, lng, accuracy_m, address, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'gps', ?)
  `).run(`lu-${crypto.randomUUID().slice(0, 8)}`, session.id, req.authUser!.id, lat, lng, accuracyM, address, nowIso);

  broadcastEvent('safety_updated', { citizenId: req.authUser!.id });
  res.json({ ok: true, updatedAt: nowIso });
});

app.post('/api/safety/session/stop', requireAuth, requireRole('citizen'), async (req: AuthenticatedRequest, res) => {
  const nowIso = new Date().toISOString();
  const active = db
    .prepare(`SELECT id FROM safety_sessions WHERE citizen_id = ? AND status = 'active'`)
    .get(req.authUser!.id) as { id: string } | undefined;

  if (!active) return res.json({ ok: true });

  db.prepare(`UPDATE safety_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?`).run(nowIso, active.id);
  await notifyLinkedCaregivers({
    citizenId: req.authUser!.id,
    eventType: 'location_sharing_stopped',
    title: 'Live Location Sharing Stopped',
    message: `${req.authUser!.name} ended their Women Safety live location sharing session.`,
  });

  recordAudit(req.authUser!.id, 'citizen', 'stop_safety_session', 'safety_session', active.id);
  broadcastEvent('safety_updated', { citizenId: req.authUser!.id });
  res.json({ ok: true });
});

// ============================================================================
// SOS EMERGENCY SYSTEM
// ============================================================================
app.post('/api/sos', requireAuth, requireRole('citizen'), async (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const now = new Date();
  const nowIso = now.toISOString();

  // Deduplicate rapid accidental double-clicks within 30s
  const recent = db
    .prepare(`SELECT * FROM sos_incidents WHERE citizen_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`)
    .get(userId) as Record<string, unknown> | undefined;
  if (recent && now.getTime() - new Date(String(recent.created_at)).getTime() < 30_000) {
    return res.json({ incident: recent, deduplicated: true });
  }

  const lat = Number.isFinite(Number(req.body?.lat)) ? Number(req.body.lat) : null;
  const lng = Number.isFinite(Number(req.body?.lng)) ? Number(req.body.lng) : null;
  const accuracyM = Number.isFinite(Number(req.body?.accuracyM)) ? Number(req.body.accuracyM) : null;
  const address = String(req.body?.address || '');
  const locationStatus = req.body?.locationStatus === 'live' && lat !== null && lng !== null
    ? 'live'
    : lat !== null && lng !== null
      ? 'last_known'
      : 'unavailable';
  const notes = String(req.body?.notes || 'Emergency SOS activated by citizen.');

  // Ensure an active 4-hour safety location session exists
  let session = db
    .prepare(`SELECT id FROM safety_sessions WHERE citizen_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`)
    .get(userId) as { id: string } | undefined;

  if (!session) {
    const sid = `ss-${crypto.randomUUID().slice(0, 8)}`;
    const exp = new Date(now.getTime() + 240 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO safety_sessions (id, citizen_id, status, duration_minutes, started_at, expires_at, last_lat, last_lng, last_accuracy_m, last_address, last_location_at)
      VALUES (?, ?, 'active', 240, ?, ?, ?, ?, ?, ?, ?)
    `).run(sid, userId, nowIso, exp, lat, lng, accuracyM, address, lat !== null ? nowIso : '');
    session = { id: sid };
  }

  const id = `sos-${crypto.randomUUID().slice(0, 8)}`;
  const incidentCode = `SOS-${now.getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

  db.prepare(`
    INSERT INTO sos_incidents (
      id, incident_code, citizen_id, safety_session_id, status,
      trigger_lat, trigger_lng, trigger_accuracy_m, trigger_address, location_status,
      notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, incidentCode, userId, session.id, lat, lng, accuracyM, address, locationStatus, notes, nowIso, nowIso);

  const locSummary =
    lat !== null && lng !== null
      ? `${address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`} (${locationStatus === 'live' ? 'Live GPS' : 'Last Known GPS'})`
      : 'GPS unavailable';

  const notificationsDispatched = await notifyLinkedCaregivers({
    citizenId: userId,
    eventType: 'sos_activated',
    title: `EMERGENCY SOS (${incidentCode})`,
    message: `${req.authUser!.name} triggered an SOS alert at ${now.toLocaleTimeString()}. Location: ${locSummary}. Note: ${notes}`,
    sosIncidentId: id,
  });

  recordAudit(userId, 'citizen', 'trigger_sos', 'sos_incident', id, { incidentCode, locationStatus });
  broadcastEvent('safety_updated', { citizenId: userId, sosId: id });
  const created = db.prepare(`SELECT * FROM sos_incidents WHERE id = ?`).get(id);
  res.status(201).json({ incident: created, notificationsDispatched });
});

app.patch('/api/sos/:id', requireAuth, requireRole('citizen'), async (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare(`SELECT * FROM sos_incidents WHERE id = ? AND citizen_id = ?`)
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'SOS incident not found.' });

  const status = ['active', 'resolved', 'cancelled'].includes(req.body?.status) ? req.body.status : String(row.status);
  const notes = req.body?.notes !== undefined ? String(req.body.notes) : String(row.notes);
  const nowIso = new Date().toISOString();
  const resolvedAt = status === 'resolved' || status === 'cancelled' ? nowIso : String(row.resolved_at || '');

  db.prepare(`UPDATE sos_incidents SET status = ?, notes = ?, updated_at = ?, resolved_at = ? WHERE id = ?`).run(
    status,
    notes,
    nowIso,
    resolvedAt,
    req.params.id
  );

  await notifyLinkedCaregivers({
    citizenId: req.authUser!.id,
    eventType: 'emergency_updated',
    title: `SOS ${row.incident_code} Updated → ${status.toUpperCase()}`,
    message: `${req.authUser!.name} updated their SOS status to ${status}. Note: ${notes}`,
    sosIncidentId: req.params.id,
  });

  recordAudit(req.authUser!.id, 'citizen', 'update_sos', 'sos_incident', req.params.id, { status });
  broadcastEvent('safety_updated', { citizenId: req.authUser!.id });
  res.json({ ok: true, status });
});

// ============================================================================
// CAREGIVER ACCESS PORTAL APIs (STRICTLY role === 'caregiver')
// ============================================================================
app.post('/api/caregiver/verify-identity', requireAuth, requireRole('caregiver'), (req: AuthenticatedRequest, res) => {
  const code = String(req.body?.verificationCode || '').trim();
  if (!code) return res.status(400).json({ error: 'Verification code is required.' });

  const cleanPhone = req.authUser!.phone.replace(/\s+/g, '');
  const pending = db
    .prepare(`SELECT * FROM caregiver_relationships WHERE REPLACE(caregiver_phone, ' ', '') = ? AND status = 'pending_verification'`)
    .all(cleanPhone) as Array<Record<string, unknown>>;

  const matched = pending.find((rel) => verifyPassword(code, String(rel.verification_code_hash)));
  if (!matched) {
    return res.status(400).json({ error: 'Invalid verification code or no matching pending caregiver request for your phone number.' });
  }
  if (matched.verification_expires_at && new Date(String(matched.verification_expires_at)) < new Date()) {
    return res.status(410).json({ error: 'Verification code has expired. Ask the citizen to send a new link.' });
  }

  db.prepare(`
    UPDATE caregiver_relationships
    SET status = 'verified_awaiting_approval', caregiver_user_id = ?, updated_at = ?
    WHERE id = ?
  `).run(req.authUser!.id, new Date().toISOString(), String(matched.id));

  recordAudit(req.authUser!.id, 'caregiver', 'caregiver_identity_verified', 'caregiver_relationship', String(matched.id));
  res.json({ ok: true, message: 'Identity verified. Waiting for citizen final approval.' });
});

app.post('/api/caregiver/access-by-token', requireAuth, requireRole('caregiver'), (req: AuthenticatedRequest, res) => {
  const rawToken = String(req.body?.token || '').trim();
  if (!rawToken) return res.status(400).json({ error: 'Access token is required.' });

  const tokenHash = hashAccessToken(rawToken);
  const tok = db
    .prepare(`SELECT * FROM caregiver_access_tokens WHERE token_hash = ?`)
    .get(tokenHash) as Record<string, unknown> | undefined;

  if (!tok || tok.revoked_at) {
    return res.status(403).json({ error: 'This caregiver access link has been revoked or is invalid.' });
  }
  if (new Date(String(tok.expires_at)) <= new Date()) {
    return res.status(403).json({ error: 'This caregiver access link has expired.' });
  }

  const rel = db
    .prepare(`SELECT * FROM caregiver_relationships WHERE id = ? AND status = 'active'`)
    .get(String(tok.relationship_id)) as Record<string, unknown> | undefined;
  if (!rel) return res.status(403).json({ error: 'Caregiver link is no longer active.' });

  // Bind caregiver user ID if phone matches or if relationship had no user bound yet
  const cleanCaregiverPhone = req.authUser!.phone.replace(/\s+/g, '');
  if (rel.caregiver_user_id && rel.caregiver_user_id !== req.authUser!.id) {
    return res.status(403).json({ error: 'This caregiver token is bound to another verified caregiver account.' });
  }
  if (!rel.caregiver_user_id && cleanCaregiverPhone !== String(rel.caregiver_phone).replace(/\s+/g, '')) {
    return res.status(403).json({ error: 'Your registered mobile number does not match the linked caregiver number.' });
  }

  db.prepare(`UPDATE caregiver_relationships SET caregiver_user_id = ? WHERE id = ?`).run(req.authUser!.id, String(rel.id));
  db.prepare(`UPDATE caregiver_access_tokens SET last_accessed_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    String(tok.id)
  );
  recordAudit(req.authUser!.id, 'caregiver', 'caregiver_token_redeemed', 'caregiver_access_token', String(tok.id));
  res.json({ ok: true, citizenId: tok.citizen_id });
});

app.get('/api/caregiver/portal', requireAuth, requireRole('caregiver'), (req: AuthenticatedRequest, res) => {
  const caregiverId = req.authUser!.id;
  const cleanPhone = req.authUser!.phone.replace(/\s+/g, '');

  const relationships = db
    .prepare(
      `SELECT r.*, u.name as citizen_name, u.phone as citizen_phone
       FROM caregiver_relationships r
       JOIN users u ON r.citizen_id = u.id
       WHERE (r.caregiver_user_id = ? OR REPLACE(r.caregiver_phone, ' ', '') = ?)
         AND r.status IN ('pending_verification', 'verified_awaiting_approval', 'active')
       ORDER BY r.updated_at DESC`
    )
    .all(caregiverId, cleanPhone) as Array<Record<string, unknown>>;

  const linkedCitizens = relationships.map((rel) => {
    const isActive = rel.status === 'active';
    const hasValidToken = Boolean(
      db
        .prepare(
          `SELECT id FROM caregiver_access_tokens WHERE relationship_id = ? AND revoked_at = '' AND expires_at > ? LIMIT 1`
        )
        .get(String(rel.id), new Date().toISOString())
    );

    if (!isActive || !hasValidToken) {
      return {
        relationshipId: rel.id,
        citizenId: rel.citizen_id,
        citizenName: rel.citizen_name,
        status: rel.status,
        authorized: false,
      };
    }

    const canViewLocation = Number(rel.can_view_location ?? 1) === 1;
    const canReceiveSos = Number(rel.can_receive_sos ?? 1) === 1;
    const canViewProfile = Number(rel.can_view_profile ?? 1) === 1;

    const activeSession = canViewLocation
      ? (db
          .prepare(
            `SELECT id, status, started_at, expires_at, last_lat, last_lng, last_accuracy_m, last_address, last_location_at
             FROM safety_sessions WHERE citizen_id = ? AND status = 'active' AND expires_at > ? ORDER BY started_at DESC LIMIT 1`
          )
          .get(String(rel.citizen_id), new Date().toISOString()) as Record<string, unknown> | undefined)
      : undefined;

    const sosAlerts = canReceiveSos
      ? db
          .prepare(
            `SELECT id, incident_code, status, trigger_lat, trigger_lng, trigger_accuracy_m, trigger_address, location_status, notes, response_notes, created_at, updated_at
             FROM sos_incidents WHERE citizen_id = ? ORDER BY created_at DESC LIMIT 10`
          )
          .all(String(rel.citizen_id))
      : [];

    const emergencyProfile = canViewProfile
      ? db.prepare(`SELECT blood_group, medical_notes, emergency_phone, home_ward FROM citizen_profiles WHERE user_id = ?`).get(String(rel.citizen_id))
      : null;

    recordAudit(caregiverId, 'caregiver', 'view_citizen_safety_data', 'citizen', String(rel.citizen_id));

    return {
      relationshipId: rel.id,
      citizenId: rel.citizen_id,
      citizenName: rel.citizen_name,
      citizenPhone: rel.citizen_phone,
      status: rel.status,
      authorized: true,
      permissions: {
        canViewLocation,
        canReceiveSos,
        canViewProfile,
      },
      activeSession: activeSession || null,
      sosAlerts,
      emergencyProfile: emergencyProfile || null,
    };
  });

  const notifications = db
    .prepare(
      `SELECT cn.*
       FROM caregiver_notifications cn
       JOIN caregiver_relationships cr ON cn.relationship_id = cr.id
       WHERE (cr.caregiver_user_id = ? OR REPLACE(cr.caregiver_phone, ' ', '') = ?)
       ORDER BY cn.created_at DESC LIMIT 40`
    )
    .all(caregiverId, cleanPhone);

  res.json({ linkedCitizens, notifications });
});

app.post('/api/caregiver/relationships/:id/respond', requireAuth, requireRole('caregiver'), (req: AuthenticatedRequest, res) => {
  const action = req.body?.action === 'reject' ? 'reject' : 'accept';
  const code = String(req.body?.verificationCode || '').trim();
  const cleanPhone = req.authUser!.phone.replace(/\s+/g, '');

  const rel = db
    .prepare(
      `SELECT * FROM caregiver_relationships
       WHERE id = ? AND (caregiver_user_id = ? OR REPLACE(caregiver_phone, ' ', '') = ?)`
    )
    .get(req.params.id, req.authUser!.id, cleanPhone) as Record<string, unknown> | undefined;

  if (!rel) return res.status(404).json({ error: 'Caregiver link request not found for your account.' });
  const nowIso = new Date().toISOString();

  if (action === 'reject') {
    db.prepare(`UPDATE caregiver_relationships SET status = 'disconnected', updated_at = ? WHERE id = ?`).run(nowIso, String(rel.id));
    db.prepare(`UPDATE caregiver_access_tokens SET revoked_at = ? WHERE relationship_id = ? AND revoked_at = ''`).run(nowIso, String(rel.id));
    recordAudit(req.authUser!.id, 'caregiver', 'reject_caregiver_link', 'caregiver_relationship', String(rel.id));
    return res.json({ ok: true, status: 'disconnected' });
  }

  if (rel.status === 'pending_verification') {
    if (!code || !verifyPassword(code, String(rel.verification_code_hash))) {
      return res.status(400).json({ error: 'Valid 6-digit verification code from the citizen is required to accept this request.' });
    }
    db.prepare(`
      UPDATE caregiver_relationships
      SET status = 'verified_awaiting_approval', caregiver_user_id = ?, verified_at = ?, updated_at = ?
      WHERE id = ?
    `).run(req.authUser!.id, nowIso, nowIso, String(rel.id));
    recordAudit(req.authUser!.id, 'caregiver', 'accept_verify_caregiver_link', 'caregiver_relationship', String(rel.id));
    return res.json({ ok: true, status: 'verified_awaiting_approval' });
  }

  return res.json({ ok: true, status: rel.status });
});

app.post('/api/caregiver/relationships/:id/unlink', requireAuth, requireRole('caregiver'), (req: AuthenticatedRequest, res) => {
  const cleanPhone = req.authUser!.phone.replace(/\s+/g, '');
  const rel = db
    .prepare(
      `SELECT * FROM caregiver_relationships
       WHERE id = ? AND (caregiver_user_id = ? OR REPLACE(caregiver_phone, ' ', '') = ?)`
    )
    .get(req.params.id, req.authUser!.id, cleanPhone) as Record<string, unknown> | undefined;
  if (!rel) return res.status(404).json({ error: 'Caregiver link not found.' });

  const nowIso = new Date().toISOString();
  db.prepare(`UPDATE caregiver_relationships SET status = 'disconnected', updated_at = ? WHERE id = ?`).run(nowIso, String(rel.id));
  db.prepare(`UPDATE caregiver_access_tokens SET revoked_at = ? WHERE relationship_id = ? AND revoked_at = ''`).run(nowIso, String(rel.id));
  recordAudit(req.authUser!.id, 'caregiver', 'caregiver_unlinked', 'caregiver_relationship', String(rel.id));
  res.json({ ok: true });
});

app.patch('/api/caregiver/notifications/:id/read', requireAuth, requireRole('caregiver'), (req: AuthenticatedRequest, res) => {
  db.prepare(`UPDATE caregiver_notifications SET in_app_read = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ============================================================================
// MODULE 1: CIVIC ISSUE MANAGEMENT (STRICT USER & ROLE ISOLATION)
// ============================================================================
app.get('/api/civic/reports', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radiusKm);
  const statusFilter = String(req.query.status || '').trim();
  const categoryFilter = String(req.query.category || '').trim();

  let rows: Array<Record<string, unknown> & { lat: number; lng: number; id: string }> = [];

  if (user.role === 'citizen') {
    // Citizen dashboard strictly sees ONLY their own reports
    rows = db
      .prepare(
        `SELECT r.*, d.name as department_name, o.name as officer_name
         FROM civic_reports r
         LEFT JOIN departments d ON r.department_id = d.id
         LEFT JOIN officers o ON r.officer_id = o.id
         WHERE r.user_id = ?
         ORDER BY r.created_at DESC`
      )
      .all(user.id) as typeof rows;
  } else if (user.role === 'authority') {
    // Authority/Officer sees reports in their assigned department or assigned directly to them
    rows = db
      .prepare(
        `SELECT r.*, d.name as department_name, o.name as officer_name
         FROM civic_reports r
         LEFT JOIN departments d ON r.department_id = d.id
         LEFT JOIN officers o ON r.officer_id = o.id
         WHERE (? = '' OR r.department_id = ? OR o.user_id = ?)
         ORDER BY r.is_emergency DESC, r.created_at DESC`
      )
      .all(user.departmentId, user.departmentId, user.id) as typeof rows;
  } else if (user.role === 'admin') {
    rows = db
      .prepare(
        `SELECT r.*, d.name as department_name, o.name as officer_name
         FROM civic_reports r
         LEFT JOIN departments d ON r.department_id = d.id
         LEFT JOIN officers o ON r.officer_id = o.id
         ORDER BY r.is_emergency DESC, r.created_at DESC`
      )
      .all() as typeof rows;
  } else {
    rows = [];
  }

  let list = rows.map((r) => {
    const dist = Number.isFinite(lat) && Number.isFinite(lng) ? haversineKm(lat, lng, r.lat, r.lng) : null;
    const activities = db
      .prepare(`SELECT * FROM complaint_activity WHERE report_id = ? ORDER BY created_at ASC`)
      .all(r.id);
    const overdue = !['Resolved', 'Rejected'].includes(String(r.status)) && new Date(String(r.sla_deadline)) < new Date();
    return {
      ...r,
      evidenceUrls: JSON.parse(String(r.evidence_urls_json || '[]')),
      beforePhotoUrls: JSON.parse(String(r.before_photo_urls_json || '[]')),
      resolutionEvidenceUrls: JSON.parse(String(r.resolution_evidence_urls_json || '[]')),
      aiVerification: JSON.parse(String(r.ai_verification_json || '{}')),
      distanceKm: dist,
      isOverdue: overdue,
      activities,
    };
  });

  if (statusFilter) list = list.filter((r) => (r as Record<string, unknown>).status === statusFilter);
  if (categoryFilter) list = list.filter((r) => (r as Record<string, unknown>).category === categoryFilter);
  if (Number.isFinite(radiusKm) && radiusKm > 0 && Number.isFinite(lat) && Number.isFinite(lng)) {
    list = list.filter((r) => r.distanceKm !== null && r.distanceKm <= radiusKm);
  }

  res.json({ reports: list });
});

app.post('/api/civic/reports', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const body = req.body || {};
  const category = String(body.category || '').trim();
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const accuracyM = body.accuracyM ? Number(body.accuracyM) : null;
  const locationSource = String(body.locationSource || 'manual');
  const address = String(body.address || '').trim();
  const landmark = String(body.landmark || '').trim();
  const ward = String(body.ward || 'Local Ward').trim();
  const severity = ['low', 'medium', 'high', 'critical'].includes(body.severity) ? body.severity : 'medium';
  const isEmergency = body.isEmergency ? 1 : 0;
  const evidenceUrls = Array.isArray(body.evidenceUrls) ? body.evidenceUrls.slice(0, 4) : [];
  const aiVerification = body.aiVerification && typeof body.aiVerification === 'object' ? body.aiVerification : {};

  if (!category || !title || !description) {
    return res.status(400).json({ error: 'Category, title, and description are required.' });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Valid geographic coordinates are required. Enable GPS or place a map pin.' });
  }
  if (!address) {
    return res.status(400).json({ error: 'Address or location label is required.' });
  }

  const slaRule = db.prepare(`SELECT department_id, sla_hours FROM sla_rules WHERE category = ?`).get(category) as
    | { department_id: string; sla_hours: number }
    | undefined;

  const deptMap: Record<string, string> = {
    'Potholes and damaged roads': 'dept-roads',
    Potholes: 'dept-roads',
    'Damaged roads': 'dept-roads',
    'Damaged footpaths': 'dept-roads',
    'Garbage and waste management': 'dept-sanitation',
    'Garbage dumping': 'dept-sanitation',
    'Illegal dumping': 'dept-sanitation',
    'Street lighting and electrical faults': 'dept-lighting',
    'Broken streetlights': 'dept-lighting',
    'Blocked drains and waterlogging': 'dept-water',
    'Water leakage': 'dept-water',
    'Drainage blockage': 'dept-water',
    'Open manholes': 'dept-water',
    'Traffic problems and road obstructions': 'dept-mobility',
    'Other civic infrastructure problems': 'dept-roads',
  };
  const departmentId = slaRule?.department_id || deptMap[category] || 'dept-roads';
  const dept = db.prepare(`SELECT sla_hours FROM departments WHERE id = ?`).get(departmentId) as { sla_hours: number } | undefined;
  const slaHours = slaRule?.sla_hours || dept?.sla_hours || 48;

  const id = `rep-${crypto.randomUUID().slice(0, 8)}`;
  const reportCode = `NGR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const nowIso = new Date().toISOString();
  const slaDeadline = new Date(Date.now() + slaHours * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO civic_reports (
      id, report_code, user_id, category, title, description, ai_enhanced_description,
      evidence_urls_json, lat, lng, accuracy_m, location_source, address, landmark, ward,
      severity, is_emergency, status, department_id, sla_deadline, ai_verification_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?, ?, ?)
  `).run(
    id,
    reportCode,
    req.authUser!.id,
    category,
    title,
    description,
    String(body.aiEnhancedDescription || ''),
    JSON.stringify(evidenceUrls),
    lat,
    lng,
    accuracyM,
    locationSource,
    address,
    landmark,
    ward,
    severity,
    isEmergency,
    departmentId,
    slaDeadline,
    JSON.stringify(aiVerification),
    nowIso,
    nowIso
  );

  db.prepare(`
    INSERT INTO complaint_activity (id, report_id, previous_status, new_status, actor_id, actor_name, actor_role, comment, created_at)
    VALUES (?, ?, NULL, 'Submitted', ?, ?, ?, 'Complaint filed and logged with verified coordinates.', ?)
  `).run(`act-${crypto.randomUUID().slice(0, 8)}`, id, req.authUser!.id, req.authUser!.name, req.authUser!.role, nowIso);

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'complaint_submitted', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    req.authUser!.id,
    `Complaint ${reportCode} Logged`,
    `Your ${category} report "${title}" has been registered.`,
    `आपकी शिकायत "${title}" (${reportCode}) दर्ज हो गई है।`,
    id,
    nowIso
  );

  recordAudit(req.authUser!.id, req.authUser!.role, 'create_civic_report', 'civic_report', id, { reportCode, category });
  broadcastEvent('civic_updated', { action: 'created', id, reportCode });

  res.status(201).json({ id, reportCode, status: 'Submitted', slaDeadline });
});

app.post('/api/civic/reports/:id/comment', requireAuth, (req: AuthenticatedRequest, res) => {
  const reportId = req.params.id;
  const comment = String(req.body?.comment || '').trim();
  const feedback = String(req.body?.resolutionFeedback || '').trim();
  if (!comment && !feedback) return res.status(400).json({ error: 'Comment text is required.' });

  const report = db.prepare(`SELECT user_id, status FROM civic_reports WHERE id = ?`).get(reportId) as
    | { user_id: string; status: string }
    | undefined;
  if (!report) return res.status(404).json({ error: 'Complaint not found.' });
  if (req.authUser!.role === 'citizen' && report.user_id !== req.authUser!.id) {
    return res.status(403).json({ error: 'You may only comment on your own reports.' });
  }

  if (feedback) {
    db.prepare(`UPDATE civic_reports SET resolution_feedback = ? WHERE id = ?`).run(feedback, reportId);
  }
  if (comment) {
    db.prepare(`
      INSERT INTO complaint_activity (id, report_id, previous_status, new_status, actor_id, actor_name, actor_role, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `act-${crypto.randomUUID().slice(0, 8)}`,
      reportId,
      report.status,
      report.status,
      req.authUser!.id,
      req.authUser!.name,
      req.authUser!.role,
      comment,
      new Date().toISOString()
    );
  }

  broadcastEvent('civic_updated', { action: 'commented', id: reportId });
  res.json({ ok: true });
});

app.post('/api/civic/reports/:id/evidence', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const report = db.prepare(`SELECT user_id, evidence_urls_json, status FROM civic_reports WHERE id = ?`).get(req.params.id) as
    | { user_id: string; evidence_urls_json: string; status: string }
    | undefined;
  if (!report) return res.status(404).json({ error: 'Complaint not found.' });
  if (report.user_id !== req.authUser!.id) return res.status(403).json({ error: 'You may only upload evidence to your own complaint.' });

  const newUrls = Array.isArray(req.body?.evidenceUrls) ? req.body.evidenceUrls.filter((u: unknown) => typeof u === 'string') : [];
  if (newUrls.length === 0) return res.status(400).json({ error: 'No evidence files provided.' });

  const current = JSON.parse(report.evidence_urls_json || '[]') as string[];
  const merged = [...current, ...newUrls].slice(0, 8);
  const nowIso = new Date().toISOString();
  db.prepare(`UPDATE civic_reports SET evidence_urls_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), nowIso, req.params.id);
  db.prepare(`
    INSERT INTO complaint_activity (id, report_id, previous_status, new_status, actor_id, actor_name, actor_role, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `act-${crypto.randomUUID().slice(0, 8)}`,
    req.params.id,
    report.status,
    report.status,
    req.authUser!.id,
    req.authUser!.name,
    'citizen',
    `Citizen uploaded ${newUrls.length} additional evidence attachment(s).`,
    nowIso
  );
  broadcastEvent('civic_updated', { action: 'evidence_added', id: req.params.id });
  res.json({ ok: true, evidenceUrls: merged });
});

app.post('/api/civic/reports/:id/feedback', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const report = db.prepare(`SELECT user_id, status FROM civic_reports WHERE id = ?`).get(req.params.id) as
    | { user_id: string; status: string }
    | undefined;
  if (!report) return res.status(404).json({ error: 'Complaint not found.' });
  if (report.user_id !== req.authUser!.id) return res.status(403).json({ error: 'Only the complaint owner can rate resolution.' });

  const rating = Math.max(1, Math.min(5, Number(req.body?.rating) || 5));
  const feedback = String(req.body?.feedback || '').trim();
  const nowIso = new Date().toISOString();
  db.prepare(`UPDATE civic_reports SET citizen_rating = ?, resolution_feedback = ?, updated_at = ? WHERE id = ?`).run(
    rating,
    feedback,
    nowIso,
    req.params.id
  );
  res.json({ ok: true, rating });
});

app.patch('/api/civic/reports/:id/manage', requireAuth, requireRole('authority', 'admin'), (req: AuthenticatedRequest, res) => {
  const reportId = req.params.id;
  const { status, officerId, departmentId, severity, comment, resolutionNotes, beforePhotoUrls, resolutionEvidenceUrls } = req.body || {};

  const report = db.prepare(`SELECT * FROM civic_reports WHERE id = ?`).get(reportId) as Record<string, unknown> | undefined;
  if (!report) return res.status(404).json({ error: 'Complaint not found.' });

  if (req.authUser!.role === 'authority' && req.authUser!.departmentId && report.department_id !== req.authUser!.departmentId) {
    return res.status(403).json({ error: 'Officers can only manage complaints assigned to their department.' });
  }

  const allowedStatuses = ['Submitted', 'Under Review', 'Verified', 'Assigned', 'In Progress', 'Resolved', 'Rejected', 'Reopened', 'Escalated'];
  const nextStatus = allowedStatuses.includes(status) ? status : String(report.status);
  const nextOfficer = officerId !== undefined ? officerId : report.officer_id;
  const nextDept = departmentId || report.department_id;
  const nextSev = ['low', 'medium', 'high', 'critical'].includes(severity) ? severity : String(report.severity);
  const nextBeforeEv = Array.isArray(beforePhotoUrls) ? JSON.stringify(beforePhotoUrls) : String(report.before_photo_urls_json || '[]');
  const nextResEv = Array.isArray(resolutionEvidenceUrls) ? JSON.stringify(resolutionEvidenceUrls) : String(report.resolution_evidence_urls_json || '[]');
  const nextResNotes = resolutionNotes !== undefined ? String(resolutionNotes) : String(report.resolution_notes || '');
  const nowIso = new Date().toISOString();
  const resolvedAt = nextStatus === 'Resolved' ? String(report.resolved_at || nowIso) : String(report.resolved_at || '');
  const escalatedAt = nextStatus === 'Escalated' ? String(report.escalated_at || nowIso) : String(report.escalated_at || '');

  db.prepare(`
    UPDATE civic_reports
    SET status = ?, officer_id = ?, department_id = ?, severity = ?,
        before_photo_urls_json = ?, resolution_evidence_urls_json = ?, resolution_notes = ?,
        resolved_at = ?, escalated_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nextStatus, nextOfficer, nextDept, nextSev, nextBeforeEv, nextResEv, nextResNotes, resolvedAt, escalatedAt, nowIso, reportId);

  // Sync officer active/resolved counters
  if (nextOfficer && nextOfficer !== report.officer_id) {
    db.prepare(`UPDATE officers SET active_count = active_count + 1 WHERE id = ?`).run(String(nextOfficer));
  }
  if (nextStatus === 'Resolved' && report.status !== 'Resolved' && nextOfficer) {
    db.prepare(`UPDATE officers SET resolved_count = resolved_count + 1, active_count = MAX(0, active_count - 1) WHERE id = ?`).run(String(nextOfficer));
  }

  // Award verified citizen points (idempotent per milestone, never on Rejected)
  const rewardCfg = getAppConfigJson('reward_config', {
    verifiedReportPoints: 20,
    resolutionConfirmedPoints: 30,
    segregationPoints: 25,
    maxDailyClaims: 10,
  });
  let awardedPoints = 0;
  if (nextStatus === 'Verified') {
    const awarded = awardCitizenRewardPoints({
      userId: String(report.user_id),
      action: `Verified Civic Report (${report.report_code})`,
      points: rewardCfg.verifiedReportPoints,
      refId: `verify:${reportId}`,
      badge: 'Verified Contributor',
    });
    if (awarded) awardedPoints += rewardCfg.verifiedReportPoints;
  } else if (nextStatus === 'Resolved') {
    const awarded = awardCitizenRewardPoints({
      userId: String(report.user_id),
      action: `Resolved Civic Report (${report.report_code})`,
      points: rewardCfg.resolutionConfirmedPoints,
      refId: `resolve:${reportId}`,
      badge: 'Resolution Partner',
    });
    if (awarded) awardedPoints += rewardCfg.resolutionConfirmedPoints;
  }

  db.prepare(`
    INSERT INTO complaint_activity (id, report_id, previous_status, new_status, actor_id, actor_name, actor_role, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `act-${crypto.randomUUID().slice(0, 8)}`,
    reportId,
    String(report.status),
    nextStatus,
    req.authUser!.id,
    req.authUser!.name,
    req.authUser!.role,
    String(comment || nextResNotes || `Status updated to ${nextStatus}.`),
    nowIso
  );

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'status_changed', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    String(report.user_id),
    `Complaint ${report.report_code} → ${nextStatus}`,
    comment
      ? `${comment}${awardedPoints > 0 ? ` (+${awardedPoints} reward points)` : ''}`
      : `Your complaint status has changed to ${nextStatus}.${awardedPoints > 0 ? ` (+${awardedPoints} reward points)` : ''}`,
    `आपकी शिकायत (${report.report_code}) की स्थिति बदलकर ${nextStatus} हो गई है।`,
    reportId,
    nowIso
  );

  recordAudit(req.authUser!.id, req.authUser!.role, 'manage_civic_report', 'civic_report', reportId, { nextStatus, nextOfficer, awardedPoints });
  broadcastEvent('civic_updated', { action: 'managed', id: reportId, status: nextStatus });

  res.json({ ok: true, status: nextStatus, awardedPoints });
});

app.get('/api/civic/departments', requireAuth, (_req, res) => {
  res.json({
    departments: db.prepare(`SELECT * FROM departments WHERE COALESCE(is_active, 1) = 1 ORDER BY name ASC`).all(),
    officers: db
      .prepare(`SELECT o.*, d.name as department_name FROM officers o JOIN departments d ON o.department_id = d.id ORDER BY o.name ASC`)
      .all(),
  });
});

app.get('/api/civic/export.csv', requireAuth, requireRole('authority', 'admin'), (_req, res) => {
  const rows = db
    .prepare(`SELECT report_code, category, title, ward, severity, status, address, created_at, sla_deadline FROM civic_reports ORDER BY created_at DESC`)
    .all() as Array<Record<string, unknown>>;

  const header = 'report_code,category,title,ward,severity,status,address,created_at,sla_deadline';
  const lines = rows.map((r) =>
    [r.report_code, r.category, r.title, r.ward, r.severity, r.status, r.address, r.created_at, r.sla_deadline]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
      .join(',')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="nagar-civic-reports.csv"');
  res.send([header, ...lines].join('\n'));
});

// ============================================================================
// MODULE 2: SMART INFORMAL PUBLIC TRANSPORT (REAL DB ONLY)
// ============================================================================
app.get('/api/transit/overview', requireAuth, (_req, res) => {
  const routes = db.prepare(`SELECT * FROM transit_routes ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>;
  const vehicles = db.prepare(`SELECT * FROM transit_vehicles ORDER BY last_updated DESC`).all();

  res.json({
    routes: routes.map((r) => ({
      ...r,
      geometry: JSON.parse(String(r.geometry_json || '[]')),
      stops: JSON.parse(String(r.stops_json || '[]')),
    })),
    vehicles,
  });
});

app.post('/api/transit/routes', requireAuth, (req: AuthenticatedRequest, res) => {
  const { name, origin, destination, vehicleCategory, operatingHours, baseFareInr, stops, geometry } = req.body || {};
  if (!name || !origin || !destination) {
    return res.status(400).json({ error: 'Route name, origin, and destination are required.' });
  }
  const cat = ['shared_auto', 'mini_bus', 'e_rickshaw'].includes(vehicleCategory) ? vehicleCategory : 'shared_auto';
  const isAuth = req.authUser!.role === 'authority' || req.authUser!.role === 'admin';
  const id = `rt-${crypto.randomUUID().slice(0, 6)}`;
  const routeCode = `${cat === 'mini_bus' ? 'MB' : cat === 'e_rickshaw' ? 'ER' : 'SA'}-${Math.floor(100 + Math.random() * 899)}`;
  const parsedStops = Array.isArray(stops) ? stops : [];
  const parsedGeom = Array.isArray(geometry) ? geometry : [];

  db.prepare(`
    INSERT INTO transit_routes (
      id, route_code, name, origin, destination, vehicle_category, geometry_json, stops_json,
      operating_hours, base_fare_inr, fare_source, est_duration_min, distance_km, verification_status,
      submitted_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    routeCode,
    String(name),
    String(origin),
    String(destination),
    cat,
    JSON.stringify(parsedGeom),
    JSON.stringify(parsedStops),
    String(operatingHours || '06:30 – 22:00'),
    Math.max(5, Number(baseFareInr) || 15),
    isAuth ? 'verified' : 'community',
    Math.max(5, Number(req.body?.estDurationMin) || 18),
    Math.max(0.5, Number(req.body?.distanceKm) || 3.5),
    isAuth ? 'verified' : 'pending',
    req.authUser!.id,
    new Date().toISOString()
  );

  broadcastEvent('transit_updated', { action: 'route_added', id });
  res.status(201).json({ id, routeCode, verificationStatus: isAuth ? 'verified' : 'pending' });
});

app.patch('/api/transit/routes/:id/verify', requireAuth, requireRole('authority', 'admin'), (req, res) => {
  const status = ['verified', 'flagged', 'pending'].includes(req.body?.verificationStatus) ? req.body.verificationStatus : 'verified';
  db.prepare(`UPDATE transit_routes SET verification_status = ? WHERE id = ?`).run(status, req.params.id);
  broadcastEvent('transit_updated', { action: 'route_verified', id: req.params.id, status });
  res.json({ ok: true, status });
});

app.post('/api/transit/routes/:id/delay', requireAuth, (req, res) => {
  db.prepare(`UPDATE transit_routes SET delay_reports = delay_reports + 1 WHERE id = ?`).run(req.params.id);
  broadcastEvent('transit_updated', { action: 'delay_reported', id: req.params.id });
  res.json({ ok: true });
});

app.patch('/api/transit/vehicles/:id/location', requireAuth, requireRole('transit_driver', 'authority', 'admin'), (req, res) => {
  const { lat, lng, availableSeats, status } = req.body || {};
  const row = db.prepare(`SELECT * FROM transit_vehicles WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Vehicle not found.' });
  const nextLat = Number.isFinite(Number(lat)) ? Number(lat) : Number(row.lat);
  const nextLng = Number.isFinite(Number(lng)) ? Number(lng) : Number(row.lng);
  const nextSeats = Number.isFinite(Number(availableSeats))
    ? Math.max(0, Math.min(Number(row.capacity), Number(availableSeats)))
    : Number(row.available_seats);
  const nextStatus = ['active', 'idle', 'maintenance'].includes(status) ? status : String(row.status);

  db.prepare(`UPDATE transit_vehicles SET lat = ?, lng = ?, available_seats = ?, status = ?, last_updated = ? WHERE id = ?`).run(
    nextLat,
    nextLng,
    nextSeats,
    nextStatus,
    new Date().toISOString(),
    req.params.id
  );
  broadcastEvent('transit_updated', { action: 'vehicle_updated', id: req.params.id });
  res.json({ ok: true });
});

// ============================================================================
// MODULE 3: INTELLIGENT WASTE MANAGEMENT (REAL DB ONLY)
// ============================================================================
app.get('/api/waste/overview', requireAuth, (req: AuthenticatedRequest, res) => {
  const bins = db.prepare(`SELECT * FROM waste_bins ORDER BY fill_level_pct DESC`).all();
  const collections = db
    .prepare(
      `SELECT c.*, b.bin_code, b.address, b.ward, b.lat, b.lng
       FROM waste_collections c JOIN waste_bins b ON c.bin_id = b.id
       ORDER BY c.scheduled_time ASC`
    )
    .all();
  const recyclingCentres = db.prepare(`SELECT * FROM recycling_centres`).all() as Array<Record<string, unknown>>;
  const leaderboard = db
    .prepare(
      `SELECT r.points, r.households_verified, r.streak_days, u.name, u.role
       FROM rewards r JOIN users u ON r.user_id = u.id
       ORDER BY r.points DESC LIMIT 10`
    )
    .all();

  let myRewards = null;
  const rw = db.prepare(`SELECT * FROM rewards WHERE user_id = ?`).get(req.authUser!.id) as Record<string, unknown> | undefined;
  if (rw) {
    myRewards = {
      ...rw,
      badges: JSON.parse(String(rw.badges_json || '[]')),
      history: JSON.parse(String(rw.history_json || '[]')),
    };
  }

  res.json({
    bins,
    collections,
    recyclingCentres: recyclingCentres.map((rc) => ({
      ...rc,
      acceptedTypes: JSON.parse(String(rc.accepted_types_json || '[]')),
    })),
    leaderboard,
    myRewards,
  });
});

app.post('/api/waste/bins', requireAuth, requireRole('authority', 'admin', 'sanitation_driver'), (req, res) => {
  const { binCode, ward, address, lat, lng, capacityL, wasteType } = req.body || {};
  if (!binCode || !address || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return res.status(400).json({ error: 'Bin code, address, and valid coordinates are required.' });
  }
  const id = `bin-${crypto.randomUUID().slice(0, 6)}`;
  db.prepare(`
    INSERT INTO waste_bins (id, bin_code, ward, address, lat, lng, capacity_l, fill_level_pct, waste_type, sensor_type, battery_pct, connectivity, status, last_collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'ultrasonic', 100, 'online', 'normal', ?)
  `).run(
    id,
    String(binCode).toUpperCase(),
    String(ward || 'Local Ward'),
    String(address),
    Number(lat),
    Number(lng),
    Math.max(60, Number(capacityL) || 240),
    String(wasteType || 'mixed'),
    new Date().toISOString()
  );
  broadcastEvent('waste_updated', { action: 'bin_registered', id });
  res.status(201).json({ id });
});

app.patch('/api/waste/collections/:id', requireAuth, requireRole('sanitation_driver', 'authority', 'admin'), (req, res) => {
  const { status, beforePhoto, afterPhoto, notes } = req.body || {};
  const col = db.prepare(`SELECT * FROM waste_collections WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!col) return res.status(404).json({ error: 'Collection task not found.' });

  const nextStatus = ['scheduled', 'in_progress', 'completed', 'missed'].includes(status) ? status : String(col.status);
  const completedAt = nextStatus === 'completed' ? new Date().toISOString() : String(col.completed_at || '');

  db.prepare(`UPDATE waste_collections SET status = ?, completed_at = ?, before_photo = ?, after_photo = ?, notes = ? WHERE id = ?`).run(
    nextStatus,
    completedAt,
    String(beforePhoto || col.before_photo || ''),
    String(afterPhoto || col.after_photo || ''),
    String(notes || col.notes || ''),
    req.params.id
  );

  if (nextStatus === 'completed') {
    db.prepare(`UPDATE waste_bins SET fill_level_pct = 8, status = 'normal', last_collected_at = ? WHERE id = ?`).run(
      completedAt,
      String(col.bin_id)
    );
  }

  broadcastEvent('waste_updated', { action: 'collection_updated', id: req.params.id, status: nextStatus });
  res.json({ ok: true, status: nextStatus });
});

app.post('/api/waste/segregation-log', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const itemNote = String(req.body?.itemNote || 'Daily Wet & Dry Segregation').trim();
  const existing = db.prepare(`SELECT * FROM rewards WHERE user_id = ?`).get(req.authUser!.id) as Record<string, unknown> | undefined;
  const entry = { date: new Date().toISOString(), action: `Logged: ${itemNote}`, points: 25 };

  if (!existing) {
    db.prepare(`
      INSERT INTO rewards (id, user_id, points, households_verified, streak_days, badges_json, history_json)
      VALUES (?, ?, 25, 1, 1, '["Segregation Starter"]', ?)
    `).run(`rew-${crypto.randomUUID().slice(0, 6)}`, req.authUser!.id, JSON.stringify([entry]));
  } else {
    const history = JSON.parse(String(existing.history_json || '[]'));
    history.unshift(entry);
    db.prepare(`UPDATE rewards SET points = points + 25, households_verified = households_verified + 1, streak_days = streak_days + 1, history_json = ? WHERE user_id = ?`).run(
      JSON.stringify(history.slice(0, 20)),
      req.authUser!.id
    );
  }
  res.json({ ok: true, pointsAwarded: 25 });
});

// ============================================================================
// AI INTELLIGENCE ROUTES (SERVER-SIDE GEMINI)
// ============================================================================
app.post('/api/ai/civic/analyze', requireAuth, rateLimit(20, 60_000), async (req, res) => {
  try {
    const result = await analyzeCivicSubmission({
      category: String(req.body?.category || 'Other civic issues'),
      title: String(req.body?.title || 'Civic Issue'),
      description: String(req.body?.description || ''),
      lat: Number(req.body?.lat) || 0,
      lng: Number(req.body?.lng) || 0,
      imageBase64: req.body?.imageBase64,
      imageMimeType: req.body?.imageMimeType,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'AI analysis failed.';
    if (msg === 'GEMINI_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured. Add it in Settings > Secrets.' });
    }
    res.status(500).json({ error: msg });
  }
});

app.post('/api/ai/civic/enhance-description', requireAuth, rateLimit(20, 60_000), async (req, res) => {
  try {
    const result = await enhanceDescriptionWithAi(
      String(req.body?.draft || ''),
      String(req.body?.category || 'Civic Issue'),
      req.body?.language === 'hi' ? 'hi' : 'en'
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'AI assistant failed.';
    res.status(msg === 'GEMINI_NOT_CONFIGURED' ? 503 : 500).json({ error: msg });
  }
});

app.post('/api/ai/waste/classify', requireAuth, rateLimit(20, 60_000), async (req, res) => {
  try {
    const result = await classifyWasteWithAi({
      description: req.body?.description,
      imageBase64: req.body?.imageBase64,
      imageMimeType: req.body?.imageMimeType,
      language: req.body?.language === 'hi' ? 'hi' : 'en',
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Waste classification failed.';
    res.status(msg === 'GEMINI_NOT_CONFIGURED' ? 503 : 500).json({ error: msg });
  }
});

// ============================================================================
// ELEVENLABS VOICE ENGINE + NAGAR SAATHI CONVERSATIONAL ASSISTANT
// ============================================================================
app.get('/api/voice/status', async (req, res) => {
  const status = await checkElevenLabsStatus(req.query.refresh === 'true');
  res.json({
    ...status,
    geminiConfigured: isGeminiConfigured(),
  });
});

app.get('/api/voice/voices', requireAuth, async (_req, res) => {
  const result = await listPermittedVoices();
  if (result.error && result.voices.length === 0) {
    return res.status(503).json({ voices: [], error: result.error });
  }
  res.json(result);
});

app.post('/api/voice/stt', requireAuth, rateLimit(30, 60_000), uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file || req.file.size === 0) {
      return res.status(400).json({ error: 'No audio recording received.' });
    }
    const lang = req.body?.language === 'hi' ? 'hi' : req.body?.language === 'en' ? 'en' : 'auto';
    const result = await transcribeWithElevenLabs(req.file.buffer, req.file.mimetype, lang);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Speech-to-text transcription failed.';
    const statusCode = (err as Error & { statusCode?: number }).statusCode;
    if (msg === 'ELEVENLABS_NOT_CONFIGURED') {
      return res.status(503).json({
        error: 'ELEVENLABS_API_KEY is not configured on the server. Use text input or ask an administrator to configure ElevenLabs.',
        code: 'ELEVENLABS_NOT_CONFIGURED',
      });
    }
    res.status(statusCode || 502).json({ error: msg });
  }
});

app.post('/api/voice/tts', requireAuth, rateLimit(40, 60_000), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text is required for speech synthesis.' });

  try {
    const upstream = await synthesizeSpeechStream(text, {
      voiceId: req.body?.voiceId,
      speed: Number(req.body?.speed) || 1.0,
      language: req.body?.language === 'hi' ? 'hi' : 'en',
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.body) return res.status(502).json({ error: 'Empty audio stream from ElevenLabs.' });

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) {
        await reader.cancel();
        break;
      }
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'ElevenLabs TTS failed.';
    const statusCode = (err as Error & { statusCode?: number }).statusCode;
    if (!res.headersSent) {
      res.status(msg === 'ELEVENLABS_NOT_CONFIGURED' ? 503 : statusCode || 502).json({ error: msg });
    } else {
      res.end();
    }
  }
});

app.get('/api/voice/signed-url', requireAuth, rateLimit(15, 60_000), async (_req, res) => {
  try {
    const data = await getConvAiSignedUrl();
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : 'Unable to create signed URL.' });
  }
});

app.post('/api/saathi/chat', requireAuth, rateLimit(35, 60_000), async (req: AuthenticatedRequest, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message text cannot be empty.' });

  try {
    const result = await runNagarSaathiTurn({
      message,
      history: Array.isArray(req.body?.history) ? req.body.history : [],
      language: req.body?.language === 'hi' ? 'hi' : 'en',
      activeModule: String(req.body?.activeModule || 'overview'),
      location: req.body?.location || null,
      user: req.authUser!,
    });

    if (result.createdReport) {
      broadcastEvent('civic_updated', { action: 'created_via_saathi', report: result.createdReport });
    }
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Nagar Saathi processing failed.';
    res.status(msg === 'GEMINI_NOT_CONFIGURED' ? 503 : 500).json({ error: msg });
  }
});

app.post('/api/uploads/evidence', requireAuth, uploadEvidence.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid image or video file provided.' });
  const base64 = req.file.buffer.toString('base64');
  res.json({
    dataUrl: `data:${req.file.mimetype};base64,${base64}`,
    mimeType: req.file.mimetype,
    base64,
    sizeBytes: req.file.size,
  });
});

// ============================================================================
// AUTHORITY GRIEVANCES (SEPARATE COMPLAINT BOX FOR OFFICER / DEPT GRIEVANCES)
// ============================================================================
app.get('/api/grievances', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  let rows: Array<Record<string, unknown>> = [];

  if (user.role === 'citizen') {
    rows = db
      .prepare(
        `SELECT g.*, d.name as department_name
         FROM authority_grievances g LEFT JOIN departments d ON g.target_department_id = d.id
         WHERE g.citizen_id = ? ORDER BY g.created_at DESC`
      )
      .all(user.id) as typeof rows;
  } else if (user.role === 'admin') {
    rows = db
      .prepare(
        `SELECT g.*, u.name as citizen_name, u.email as citizen_email, d.name as department_name
         FROM authority_grievances g
         JOIN users u ON g.citizen_id = u.id
         LEFT JOIN departments d ON g.target_department_id = d.id
         ORDER BY g.created_at DESC`
      )
      .all() as typeof rows;
  } else if (user.role === 'authority') {
    // Authority portal supervisory grievance log shows redacted supervisory summary for their department only
    rows = db
      .prepare(
        `SELECT g.id, g.grievance_code, g.category, g.related_report_code, g.target_department_id, g.title, g.status, g.resolution_notes, g.created_at, g.updated_at, d.name as department_name
         FROM authority_grievances g
         LEFT JOIN departments d ON g.target_department_id = d.id
         WHERE (? = '' OR g.target_department_id = ?)
         ORDER BY g.created_at DESC`
      )
      .all(user.departmentId, user.departmentId) as typeof rows;
  }

  res.json({
    grievances: rows.map((r) => ({
      ...r,
      evidenceUrls: JSON.parse(String(r.evidence_urls_json || '[]')),
      resolutionEvidenceUrls: JSON.parse(String(r.resolution_evidence_urls_json || '[]')),
    })),
  });
});

app.post('/api/grievances', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const category = String(req.body?.category || 'Service Delay / Negligence').trim();
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const relatedReportCode = String(req.body?.relatedReportCode || '').trim().toUpperCase();
  const targetDepartmentId = String(req.body?.targetDepartmentId || '').trim();
  const targetOfficerName = String(req.body?.targetOfficerName || '').trim();
  const evidenceUrls = Array.isArray(req.body?.evidenceUrls) ? req.body.evidenceUrls.slice(0, 4) : [];

  if (!title || !description) {
    return res.status(400).json({ error: 'Grievance subject title and description are required.' });
  }

  const id = `grv-${crypto.randomUUID().slice(0, 8)}`;
  const grievanceCode = `GRV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const nowIso = new Date().toISOString();

  db.prepare(`
    INSERT INTO authority_grievances (
      id, grievance_code, citizen_id, category, related_report_code, target_department_id, target_officer_name,
      title, description, evidence_urls_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?)
  `).run(
    id,
    grievanceCode,
    req.authUser!.id,
    category,
    relatedReportCode,
    targetDepartmentId,
    targetOfficerName,
    title,
    description,
    JSON.stringify(evidenceUrls),
    nowIso,
    nowIso
  );

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'grievance_submitted', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    req.authUser!.id,
    `Authority Grievance ${grievanceCode} Filed`,
    `Your supervisory grievance "${title}" has been escalated to the Administration Portal.`,
    `आपकी शिकायत (${grievanceCode}) प्रशासन पोर्टल में दर्ज की गई है।`,
    id,
    nowIso
  );

  recordAudit(req.authUser!.id, 'citizen', 'create_authority_grievance', 'authority_grievance', id, { grievanceCode });
  broadcastEvent('grievance_updated', { action: 'created', id, grievanceCode });
  res.status(201).json({ id, grievanceCode, status: 'Submitted' });
});

app.patch('/api/grievances/:id', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const row = db.prepare(`SELECT * FROM authority_grievances WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Grievance not found.' });

  const allowed = ['Submitted', 'Under Review', 'Investigating', 'Resolved', 'Dismissed'];
  const status = allowed.includes(req.body?.status) ? req.body.status : String(row.status);
  const resolutionNotes = req.body?.resolutionNotes !== undefined ? String(req.body.resolutionNotes) : String(row.resolution_notes || '');
  const resolutionEvidenceUrls = Array.isArray(req.body?.resolutionEvidenceUrls)
    ? JSON.stringify(req.body.resolutionEvidenceUrls)
    : String(row.resolution_evidence_urls_json || '[]');
  const nowIso = new Date().toISOString();
  const resolvedAt = status === 'Resolved' || status === 'Dismissed' ? nowIso : String(row.resolved_at || '');

  db.prepare(`
    UPDATE authority_grievances
    SET status = ?, assigned_admin_id = ?, resolution_notes = ?, resolution_evidence_urls_json = ?, updated_at = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, req.authUser!.id, resolutionNotes, resolutionEvidenceUrls, nowIso, resolvedAt, req.params.id);

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'grievance_updated', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    String(row.citizen_id),
    `Grievance ${row.grievance_code} → ${status}`,
    resolutionNotes || `Administration updated your grievance status to ${status}.`,
    `आपकी प्रशासनिक शिकायत (${row.grievance_code}) की स्थिति अब ${status} है।`,
    req.params.id,
    nowIso
  );

  recordAudit(req.authUser!.id, 'admin', 'update_authority_grievance', 'authority_grievance', req.params.id, { status });
  broadcastEvent('grievance_updated', { action: 'updated', id: req.params.id, status });
  res.json({ ok: true, status });
});

// ============================================================================
// CITIZEN MEDICAL ASSISTANCE <-> OFFICER MEDICAL HELP <-> ADMIN MONITOR
// ============================================================================
app.get('/api/medical/requests', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  if (user.role === 'citizen') {
    const rows = db
      .prepare(`SELECT * FROM medical_requests WHERE citizen_id = ? ORDER BY created_at DESC`)
      .all(user.id);
    return res.json({ requests: rows });
  }
  if (user.role === 'authority' || user.role === 'admin') {
    const rows = db
      .prepare(
        `SELECT m.*, u.name as citizen_name, u.phone as citizen_phone, cp.blood_group, cp.medical_notes
         FROM medical_requests m
         JOIN users u ON m.citizen_id = u.id
         LEFT JOIN citizen_profiles cp ON m.citizen_id = cp.user_id
         ORDER BY CASE m.urgency WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, m.created_at DESC`
      )
      .all();
    return res.json({ requests: rows });
  }
  return res.status(403).json({ error: 'Access denied.' });
});

app.post('/api/medical/requests', requireAuth, requireRole('citizen'), (req: AuthenticatedRequest, res) => {
  const requestType = String(req.body?.requestType || 'Medical Assistance').trim();
  const urgency = ['normal', 'urgent', 'critical'].includes(req.body?.urgency) ? req.body.urgency : 'urgent';
  const description = String(req.body?.description || '').trim();
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracyM = Number.isFinite(Number(req.body?.accuracyM)) ? Number(req.body.accuracyM) : null;
  const address = String(req.body?.address || '').trim();
  const selectedFacilityName = String(req.body?.selectedFacilityName || '').trim();
  const selectedFacilityPhone = String(req.body?.selectedFacilityPhone || '').trim();
  const selectedFacilityAddress = String(req.body?.selectedFacilityAddress || '').trim();
  const linkedSosId = String(req.body?.linkedSosId || '').trim();

  if (!description || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Medical description and valid GPS/map coordinates are required.' });
  }

  const id = `med-${crypto.randomUUID().slice(0, 8)}`;
  const requestCode = `MED-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const nowIso = new Date().toISOString();

  db.prepare(`
    INSERT INTO medical_requests (
      id, request_code, citizen_id, request_type, urgency, description,
      lat, lng, accuracy_m, address, selected_facility_name, selected_facility_phone,
      selected_facility_address, status, linked_sos_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?)
  `).run(
    id,
    requestCode,
    req.authUser!.id,
    requestType,
    urgency,
    description,
    lat,
    lng,
    accuracyM,
    address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    selectedFacilityName,
    selectedFacilityPhone,
    selectedFacilityAddress,
    linkedSosId,
    nowIso,
    nowIso
  );

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'medical_request_submitted', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    req.authUser!.id,
    `Medical Request ${requestCode} Submitted`,
    `Your ${urgency} medical help request (${requestType}) was sent to the Authority Medical Help desk.`,
    `आपका मेडिकल सहायता अनुरोध (${requestCode}) अधिकारी मेडिकल डेस्क को भेज दिया गया है।`,
    id,
    nowIso
  );

  recordAudit(req.authUser!.id, 'citizen', 'create_medical_request', 'medical_request', id, { requestCode, urgency });
  broadcastEvent('medical_updated', { action: 'created', id, requestCode });
  const created = db.prepare(`SELECT * FROM medical_requests WHERE id = ?`).get(id);
  res.status(201).json({ request: created });
});

app.patch('/api/medical/requests/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = db.prepare(`SELECT * FROM medical_requests WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Medical request not found.' });

  const nowIso = new Date().toISOString();
  if (req.authUser!.role === 'citizen') {
    if (row.citizen_id !== req.authUser!.id) return res.status(403).json({ error: 'Access denied.' });
    if (req.body?.status !== 'Cancelled') return res.status(403).json({ error: 'Citizens can only cancel their medical request.' });
    db.prepare(`UPDATE medical_requests SET status = 'Cancelled', updated_at = ? WHERE id = ?`).run(nowIso, req.params.id);
    broadcastEvent('medical_updated', { action: 'cancelled', id: req.params.id });
    return res.json({ ok: true, status: 'Cancelled' });
  }

  if (!['authority', 'admin'].includes(req.authUser!.role)) {
    return res.status(403).json({ error: 'Unauthorized role.' });
  }

  const allowed = ['Submitted', 'Acknowledged', 'Dispatched', 'Coordinated', 'Resolved', 'Cancelled'];
  const status = allowed.includes(req.body?.status) ? req.body.status : String(row.status);
  const responderNotes = req.body?.responderNotes !== undefined ? String(req.body.responderNotes) : String(row.responder_notes || '');
  const assignedOfficerId = req.body?.assignedOfficerId || req.authUser!.id;
  const assignedOfficerName = req.body?.assignedOfficerName || req.authUser!.name;
  const resolvedAt = status === 'Resolved' ? nowIso : String(row.resolved_at || '');

  db.prepare(`
    UPDATE medical_requests
    SET status = ?, assigned_officer_id = ?, assigned_officer_name = ?, responder_notes = ?, updated_at = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, assignedOfficerId, assignedOfficerName, responderNotes, nowIso, resolvedAt, req.params.id);

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'medical_request_updated', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    String(row.citizen_id),
    `Medical Request ${row.request_code} → ${status}`,
    responderNotes ? `${responderNotes} (Updated by ${assignedOfficerName})` : `Status updated to ${status} by ${assignedOfficerName}.`,
    `आपका मेडिकल सहायता अनुरोध (${row.request_code}) अब ${status} है।`,
    req.params.id,
    nowIso
  );

  recordAudit(req.authUser!.id, req.authUser!.role, 'update_medical_request', 'medical_request', req.params.id, { status });
  broadcastEvent('medical_updated', { action: 'updated', id: req.params.id, status });
  res.json({ ok: true, status });
});

// ============================================================================
// SMART MOBILITY (REAL NOMINATIM + OSRM ROUTING + NEARBY TRANSIT HUBS)
// ============================================================================
app.get('/api/mobility/search', requireAuth, rateLimit(35, 60_000), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const lat = Number.isFinite(Number(req.query.lat)) ? Number(req.query.lat) : undefined;
  const lng = Number.isFinite(Number(req.query.lng)) ? Number(req.query.lng) : undefined;
  const result = await searchMobilityDestination(q, lat, lng);
  res.json(result);
});

app.get('/api/mobility/route', requireAuth, rateLimit(35, 60_000), async (req, res) => {
  const originLat = Number(req.query.originLat);
  const originLng = Number(req.query.originLng);
  const destLat = Number(req.query.destLat);
  const destLng = Number(req.query.destLng);
  const mode = String(req.query.mode || 'driving') as MobilityMode;

  if (![originLat, originLng, destLat, destLng].every((v) => Number.isFinite(v))) {
    return res.status(400).json({ error: 'Valid origin and destination coordinates are required for route computation.' });
  }
  try {
    const route = await computeRealRoute({ originLat, originLng, destLat, destLng, mode });
    res.json({ route });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Unable to compute real road route.' });
  }
});

app.get('/api/mobility/nearby', requireAuth, rateLimit(25, 60_000), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radiusKm) || 5;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Current GPS latitude and longitude required to discover nearby transport hubs.' });
  }
  const result = await fetchNearbyMobilityHubs(lat, lng, radiusKm);
  res.json(result);
});

// ============================================================================
// CITIZEN REWARDS & ACHIEVEMENTS (100% DB VERIFIED ACTIONS ONLY)
// ============================================================================
app.get('/api/rewards/overview', requireAuth, (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const row = db.prepare(`SELECT * FROM rewards WHERE user_id = ?`).get(userId) as Record<string, unknown> | undefined;
  const verifiedReports = (
    db.prepare(`SELECT COUNT(*) as c FROM civic_reports WHERE user_id = ? AND status IN ('Verified', 'Assigned', 'In Progress', 'Resolved')`).get(userId) as { c: number }
  ).c;
  const resolvedReports = (
    db.prepare(`SELECT COUNT(*) as c FROM civic_reports WHERE user_id = ? AND status = 'Resolved'`).get(userId) as { c: number }
  ).c;
  const leaderboard = (db
    .prepare(
      `SELECT r.points, r.streak_days, r.badges_json, u.name, u.id as user_id
       FROM rewards r JOIN users u ON r.user_id = u.id
       WHERE u.account_status = 'active' AND u.role = 'citizen'
       ORDER BY r.points DESC LIMIT 15`
    )
    .all() as Array<Record<string, unknown>>)
    .map((item) => ({
      ...item,
      badges: JSON.parse(String(item.badges_json || '[]')),
      isCurrentUser: item.user_id === userId,
    }));

  const points = Number(row?.points || 0);
  const rewardConfig = getAppConfigJson('reward_config', {
    verifiedReportPoints: 20,
    resolutionConfirmedPoints: 30,
    segregationPoints: 25,
    maxDailyClaims: 10,
  });

  res.json({
    points,
    streakDays: Number(row?.streak_days || 0),
    householdsVerified: Number(row?.households_verified || 0),
    badges: row ? JSON.parse(String(row.badges_json || '[]')) : [],
    history: row ? JSON.parse(String(row.history_json || '[]')) : [],
    verifiedReportsCount: verifiedReports,
    resolvedReportsCount: resolvedReports,
    nextTierPoints: points < 100 ? 100 : points < 250 ? 250 : points < 500 ? 500 : 1000,
    rewardConfig,
    leaderboard,
  });
});

// ============================================================================
// AUTHORITY / OFFICER PORTAL 15-MODULE ENDPOINTS
// ============================================================================
app.get('/api/authority/overview', requireAuth, requireRole('authority', 'admin'), (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const isDeptScoped = user.role === 'authority' && Boolean(user.departmentId);
  const reports = (
    isDeptScoped
      ? db.prepare(`SELECT * FROM civic_reports WHERE department_id = ? ORDER BY created_at DESC`).all(user.departmentId)
      : db.prepare(`SELECT * FROM civic_reports ORDER BY created_at DESC`).all()
  ) as Array<Record<string, unknown>>;

  const now = new Date();
  const pendingCount = reports.filter((r) => ['Submitted', 'Under Review'].includes(String(r.status))).length;
  const verifiedCount = reports.filter((r) => r.status === 'Verified').length;
  const assignedInProgressCount = reports.filter((r) => ['Assigned', 'In Progress', 'Reopened'].includes(String(r.status))).length;
  const resolvedCount = reports.filter((r) => r.status === 'Resolved').length;
  const rejectedCount = reports.filter((r) => r.status === 'Rejected').length;
  const overdueCount = reports.filter(
    (r) => !['Resolved', 'Rejected'].includes(String(r.status)) && new Date(String(r.sla_deadline)) < now
  ).length;
  const escalatedCount = reports.filter((r) => r.status === 'Escalated').length;

  const activeSosCount = (db.prepare(`SELECT COUNT(*) as c FROM sos_incidents WHERE status IN ('active', 'acknowledged')`).get() as { c: number }).c;
  const activeMedicalCount = (db.prepare(`SELECT COUNT(*) as c FROM medical_requests WHERE status NOT IN ('Resolved', 'Cancelled')`).get() as { c: number }).c;

  const recentActivity = db
    .prepare(
      `SELECT ca.*, cr.report_code, cr.title as report_title
       FROM complaint_activity ca JOIN civic_reports cr ON ca.report_id = cr.id
       ORDER BY ca.created_at DESC LIMIT 25`
    )
    .all();

  const recentEmergencies = db
    .prepare(
      `SELECT s.*, u.name as citizen_name, u.phone as citizen_phone
       FROM sos_incidents s JOIN users u ON s.citizen_id = u.id
       WHERE s.status IN ('active', 'acknowledged')
       ORDER BY s.created_at DESC LIMIT 10`
    )
    .all();

  res.json({
    metrics: {
      totalReports: reports.length,
      pendingCount,
      verifiedCount,
      assignedInProgressCount,
      resolvedCount,
      rejectedCount,
      overdueCount,
      escalatedCount,
      activeSosCount,
      activeMedicalCount,
    },
    recentActivity,
    recentEmergencies,
  });
});

app.post('/api/ai/civic/verify-report/:id', requireAuth, requireRole('authority', 'admin'), async (req, res) => {
  const report = db.prepare(`SELECT * FROM civic_reports WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!report) return res.status(404).json({ error: 'Complaint not found.' });

  try {
    const evidenceUrls = JSON.parse(String(report.evidence_urls_json || '[]')) as string[];
    const firstImg = evidenceUrls.find((u) => u.startsWith('data:image/'));
    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;
    if (firstImg) {
      const m = firstImg.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (m) {
        imageMimeType = m[1];
        imageBase64 = m[2];
      }
    }

    const analysis = await analyzeCivicSubmission({
      category: String(report.category),
      title: String(report.title),
      description: String(report.description),
      lat: Number(report.lat),
      lng: Number(report.lng),
      imageBase64,
      imageMimeType,
    });

    db.prepare(`UPDATE civic_reports SET ai_verification_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(analysis),
      new Date().toISOString(),
      req.params.id
    );

    res.json({ ok: true, aiVerification: analysis });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'AI verification failed.';
    res.status(msg === 'GEMINI_NOT_CONFIGURED' ? 503 : 500).json({ error: msg });
  }
});

app.get('/api/authority/sos', requireAuth, requireRole('authority', 'admin'), (_req, res) => {
  const incidents = (db
    .prepare(
      `SELECT s.*, u.name as citizen_name, u.phone as citizen_phone, cp.blood_group, cp.medical_notes
       FROM sos_incidents s
       JOIN users u ON s.citizen_id = u.id
       LEFT JOIN citizen_profiles cp ON s.citizen_id = cp.user_id
       ORDER BY CASE s.status WHEN 'active' THEN 1 WHEN 'acknowledged' THEN 2 ELSE 3 END, s.created_at DESC`
    )
    .all() as Array<Record<string, unknown>>)
    .map((inc) => {
      const caregivers = db
        .prepare(
          `SELECT caregiver_name, caregiver_phone, status
           FROM caregiver_relationships WHERE citizen_id = ? AND status = 'active' AND COALESCE(can_receive_sos, 1) = 1`
        )
        .all(String(inc.citizen_id));
      return { ...inc, caregivers };
    });

  res.json({ incidents });
});

app.patch('/api/authority/sos/:id', requireAuth, requireRole('authority', 'admin'), async (req: AuthenticatedRequest, res) => {
  const row = db.prepare(`SELECT * FROM sos_incidents WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'SOS incident not found.' });

  const status = ['active', 'acknowledged', 'resolved', 'cancelled'].includes(req.body?.status) ? req.body.status : String(row.status);
  const responseNotes = req.body?.responseNotes !== undefined ? String(req.body.responseNotes) : String(row.response_notes || '');
  const assignedOfficerId = req.body?.assignedOfficerId || req.authUser!.id;
  const assignedOfficerName = req.body?.assignedOfficerName || req.authUser!.name;
  const nowIso = new Date().toISOString();
  const resolvedAt = status === 'resolved' || status === 'cancelled' ? nowIso : String(row.resolved_at || '');

  db.prepare(`
    UPDATE sos_incidents
    SET status = ?, acknowledged_by = ?, assigned_officer_id = ?, assigned_officer_name = ?, response_notes = ?, updated_at = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, req.authUser!.name, assignedOfficerId, assignedOfficerName, responseNotes, nowIso, resolvedAt, req.params.id);

  await notifyLinkedCaregivers({
    citizenId: String(row.citizen_id),
    eventType: 'emergency_updated',
    title: `Authority Update on SOS ${row.incident_code}`,
    message: `Status: ${status.toUpperCase()}. Responder: ${assignedOfficerName}. ${responseNotes}`,
    sosIncidentId: req.params.id,
  });

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'sos_authority_update', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    String(row.citizen_id),
    `SOS ${row.incident_code} → ${status.toUpperCase()}`,
    `Responder ${assignedOfficerName} updated SOS status to ${status}. ${responseNotes}`,
    `आपके SOS अलर्ट (${row.incident_code}) पर अधिकारी ${assignedOfficerName} ने स्थिति ${status} अपडेट की है।`,
    req.params.id,
    nowIso
  );

  recordAudit(req.authUser!.id, req.authUser!.role, 'authority_update_sos', 'sos_incident', req.params.id, { status });
  broadcastEvent('safety_updated', { citizenId: row.citizen_id, sosId: req.params.id });
  res.json({ ok: true, status });
});

app.get('/api/authority/medical', requireAuth, requireRole('authority', 'admin'), (_req, res) => {
  const requests = db
    .prepare(
      `SELECT m.*, u.name as citizen_name, u.phone as citizen_phone, cp.blood_group, cp.medical_notes
       FROM medical_requests m
       JOIN users u ON m.citizen_id = u.id
       LEFT JOIN citizen_profiles cp ON m.citizen_id = cp.user_id
       ORDER BY CASE m.urgency WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, m.created_at DESC`
    )
    .all();
  res.json({ requests });
});

app.patch('/api/authority/medical/:id', requireAuth, requireRole('authority', 'admin'), (req: AuthenticatedRequest, res) => {
  const row = db.prepare(`SELECT * FROM medical_requests WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Medical request not found.' });

  const allowed = ['Submitted', 'Acknowledged', 'Dispatched', 'Coordinated', 'Resolved', 'Cancelled'];
  const status = allowed.includes(req.body?.status) ? req.body.status : String(row.status);
  const responderNotes = req.body?.responderNotes !== undefined ? String(req.body.responderNotes) : String(row.responder_notes || '');
  const assignedOfficerId = req.body?.assignedOfficerId || req.authUser!.id;
  const assignedOfficerName = req.body?.assignedOfficerName || req.authUser!.name;
  const nowIso = new Date().toISOString();
  const resolvedAt = status === 'Resolved' ? nowIso : String(row.resolved_at || '');

  db.prepare(`
    UPDATE medical_requests
    SET status = ?, assigned_officer_id = ?, assigned_officer_name = ?, responder_notes = ?, updated_at = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, assignedOfficerId, assignedOfficerName, responderNotes, nowIso, resolvedAt, req.params.id);

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'medical_request_updated', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    String(row.citizen_id),
    `Medical Help ${row.request_code} → ${status}`,
    responderNotes ? `${responderNotes} (${assignedOfficerName})` : `Status updated to ${status} by ${assignedOfficerName}.`,
    `आपका मेडिकल सहायता अनुरोध (${row.request_code}) अब ${status} है।`,
    req.params.id,
    nowIso
  );

  recordAudit(req.authUser!.id, req.authUser!.role, 'authority_update_medical', 'medical_request', req.params.id, { status });
  broadcastEvent('medical_updated', { action: 'updated', id: req.params.id, status });
  res.json({ ok: true, status });
});

app.get('/api/authority/performance', requireAuth, requireRole('authority', 'admin'), (_req, res) => {
  const departments = db.prepare(`SELECT * FROM departments ORDER BY name ASC`).all() as Array<Record<string, unknown>>;
  const reports = db.prepare(`SELECT department_id, officer_id, status, sla_deadline, created_at, resolved_at FROM civic_reports`).all() as Array<
    Record<string, unknown>
  >;
  const officers = db
    .prepare(`SELECT o.*, d.name as department_name FROM officers o JOIN departments d ON o.department_id = d.id ORDER BY o.name ASC`)
    .all() as Array<Record<string, unknown>>;

  const now = new Date();
  const departmentMetrics = departments.map((d) => {
    const deptReports = reports.filter((r) => r.department_id === d.id);
    const resolved = deptReports.filter((r) => r.status === 'Resolved');
    const overdue = deptReports.filter((r) => !['Resolved', 'Rejected'].includes(String(r.status)) && new Date(String(r.sla_deadline)) < now).length;
    const avgResolutionHours =
      resolved.length > 0
        ? Math.round(
            (resolved.reduce((sum, r) => {
              const end = r.resolved_at ? new Date(String(r.resolved_at)).getTime() : now.getTime();
              return sum + Math.max(0.5, (end - new Date(String(r.created_at)).getTime()) / 3600_000);
            }, 0) /
              resolved.length) *
              10
          ) / 10
        : 0;
    return {
      ...d,
      totalAssigned: deptReports.length,
      resolvedCount: resolved.length,
      pendingCount: deptReports.length - resolved.length - deptReports.filter((r) => r.status === 'Rejected').length,
      overdueCount: overdue,
      resolutionRatePct: deptReports.length ? Math.round((resolved.length / deptReports.length) * 100) : 0,
      avgResolutionHours,
    };
  });

  const officerLeaderboard = officers
    .map((o) => {
      const assigned = reports.filter((r) => r.officer_id === o.id);
      const resolved = assigned.filter((r) => r.status === 'Resolved');
      const overdue = assigned.filter((r) => !['Resolved', 'Rejected'].includes(String(r.status)) && new Date(String(r.sla_deadline)) < now).length;
      const score = resolved.length * 25 + assigned.length * 5 - overdue * 10;
      return {
        ...o,
        assignedTotal: assigned.length,
        resolvedTotal: resolved.length,
        overdueTotal: overdue,
        slaCompliancePct: assigned.length ? Math.round(((assigned.length - overdue) / assigned.length) * 100) : 100,
        performanceScore: Math.max(0, score),
      };
    })
    .sort((a, b) => b.performanceScore - a.performanceScore);

  res.json({ departmentMetrics, officerLeaderboard });
});

app.get('/api/authority/escalations', requireAuth, requireRole('authority', 'admin'), (_req, res) => {
  const nowIso = new Date().toISOString();
  const overdueOrEscalated = db
    .prepare(
      `SELECT r.*, d.name as department_name, o.name as officer_name
       FROM civic_reports r
       LEFT JOIN departments d ON r.department_id = d.id
       LEFT JOIN officers o ON r.officer_id = o.id
       WHERE r.status NOT IN ('Resolved', 'Rejected') AND (r.status = 'Escalated' OR r.sla_deadline < ?)
       ORDER BY r.sla_deadline ASC`
    )
    .all(nowIso);
  res.json({ escalations: overdueOrEscalated });
});

app.post('/api/authority/escalations/scan', requireAuth, requireRole('authority', 'admin'), (req: AuthenticatedRequest, res) => {
  const nowIso = new Date().toISOString();
  const overdueRows = db
    .prepare(
      `SELECT id, report_code, user_id, status FROM civic_reports
       WHERE status NOT IN ('Resolved', 'Rejected', 'Escalated') AND sla_deadline < ?`
    )
    .all(nowIso) as Array<{ id: string; report_code: string; user_id: string; status: string }>;

  for (const r of overdueRows) {
    db.prepare(`UPDATE civic_reports SET status = 'Escalated', escalated_at = ?, updated_at = ? WHERE id = ?`).run(nowIso, nowIso, r.id);
    db.prepare(`
      INSERT INTO complaint_activity (id, report_id, previous_status, new_status, actor_id, actor_name, actor_role, comment, created_at)
      VALUES (?, ?, ?, 'Escalated', ?, ?, ?, 'SLA deadline elapsed — automatically escalated for priority supervisory action.', ?)
    `).run(`act-${crypto.randomUUID().slice(0, 8)}`, r.id, r.status, req.authUser!.id, req.authUser!.name, req.authUser!.role, nowIso);
    db.prepare(`
      INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
      VALUES (?, ?, 'citizen', 'sla_escalated', ?, ?, ?, ?, 0, ?)
    `).run(
      `not-${crypto.randomUUID().slice(0, 8)}`,
      r.user_id,
      `Report ${r.report_code} Escalated`,
      `Your complaint ${r.report_code} exceeded its SLA target and was escalated to supervisory officers.`,
      `आपकी शिकायत (${r.report_code}) SLA समय सीमा के बाद उच्च अधिकारियों को एस्केलेट कर दी गई है।`,
      r.id,
      nowIso
    );
  }

  recordAudit(req.authUser!.id, req.authUser!.role, 'run_sla_escalation_scan', 'civic_report', 'batch', { escalatedCount: overdueRows.length });
  if (overdueRows.length > 0) broadcastEvent('civic_updated', { action: 'escalated', count: overdueRows.length });
  res.json({ escalatedCount: overdueRows.length });
});

app.get('/api/authority/security-audit', requireAuth, requireRole('authority', 'admin'), (_req, res) => {
  const auditLogs = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 60`).all();
  const smsLogs = db
    .prepare(`SELECT id, event_type, caregiver_phone, sms_status, sms_error, whatsapp_status, created_at FROM caregiver_notifications ORDER BY created_at DESC LIMIT 40`)
    .all();
  res.json({
    auditLogs,
    smsLogs,
    messagingProvider: getMessagingProviderStatus(),
  });
});

// ============================================================================
// USER-SCOPED NOTIFICATIONS & ANALYTICS
// ============================================================================
app.get('/api/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(req.authUser!.id);
  res.json({ notifications: rows });
});

app.patch('/api/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`).run(req.params.id, req.authUser!.id);
  res.json({ ok: true });
});

app.post('/api/notifications/mark-all-read', requireAuth, (req: AuthenticatedRequest, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`).run(req.authUser!.id);
  res.json({ ok: true });
});

app.get('/api/analytics/summary', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const reports =
    user.role === 'citizen'
      ? (db.prepare(`SELECT category, ward, severity, status, sla_deadline, department_id, created_at FROM civic_reports WHERE user_id = ?`).all(user.id) as Array<Record<string, unknown>>)
      : (db.prepare(`SELECT category, ward, severity, status, sla_deadline, department_id, created_at FROM civic_reports`).all() as Array<Record<string, unknown>>);

  const routes = db.prepare(`SELECT verification_status, reliability_score FROM transit_routes`).all() as Array<Record<string, unknown>>;
  const vehicles = db.prepare(`SELECT status FROM transit_vehicles`).all() as Array<Record<string, unknown>>;
  const bins = db.prepare(`SELECT status FROM waste_bins`).all() as Array<Record<string, unknown>>;
  const collections = db.prepare(`SELECT status FROM waste_collections`).all() as Array<Record<string, unknown>>;

  const byCategory: Record<string, number> = {};
  const byWard: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let overdueCount = 0;

  for (const r of reports) {
    const cat = String(r.category);
    const ward = String(r.ward);
    const st = String(r.status);
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    byWard[ward] = (byWard[ward] || 0) + 1;
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (!['Resolved', 'Rejected'].includes(st) && new Date(String(r.sla_deadline)) < new Date()) {
      overdueCount += 1;
    }
  }

  const completedCol = collections.filter((c) => c.status === 'completed').length;
  res.json({
    civic: {
      total: reports.length,
      resolved: reports.filter((r) => r.status === 'Resolved').length,
      overdue: overdueCount,
      overduePct: reports.length ? Math.round((overdueCount / reports.length) * 100) : 0,
      byCategory,
      byWard,
      byStatus,
    },
    transit: {
      totalRoutes: routes.length,
      verifiedRoutes: routes.filter((r) => r.verification_status === 'verified').length,
      activeVehicles: vehicles.filter((v) => v.status === 'active').length,
      avgReliabilityPct: routes.length
        ? Math.round((routes.reduce((s, r) => s + Number(r.reliability_score || 0), 0) / routes.length) * 100)
        : 0,
    },
    waste: {
      totalBins: bins.length,
      normalBins: bins.filter((b) => b.status === 'normal').length,
      nearlyFullBins: bins.filter((b) => b.status === 'nearly_full').length,
      overflowingBins: bins.filter((b) => b.status === 'overflowing').length,
      collectionCompletionPct: collections.length ? Math.round((completedCol / collections.length) * 100) : 0,
      estimatedCarbonSavedKg: completedCol * 18.4,
    },
  });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: err.message || 'Bad request.' });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NAGAR AI server listening on http://localhost:${PORT}`);
  });
}

startServer();
