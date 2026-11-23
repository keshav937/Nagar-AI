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
  getMessagingProviderStatus,
  notifyLinkedCaregivers,
  retryCaregiverNotification,
  dispatchSms,
} from './server/notifications.ts';

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
  recordAudit(authUser.id, actualRole, 'user_login', 'user', authUser.id);
  res.json({ token, user: authUser });
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
app.get('/api/admin/overview', requireAuth, requireRole('admin'), (_req, res) => {
  const usersByRole = db
    .prepare(`SELECT role, COUNT(*) as count FROM users WHERE account_status = 'active' GROUP BY role`)
    .all() as Array<{ role: string; count: number }>;
  const reportsByStatus = db
    .prepare(`SELECT status, COUNT(*) as count FROM civic_reports GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;
  const totalUsers = (db.prepare(`SELECT COUNT(*) as c FROM users WHERE account_status = 'active'`).get() as { c: number }).c;
  const totalReports = (db.prepare(`SELECT COUNT(*) as c FROM civic_reports`).get() as { c: number }).c;
  const totalOfficers = (db.prepare(`SELECT COUNT(*) as c FROM officers`).get() as { c: number }).c;
  const activeSosCount = (db.prepare(`SELECT COUNT(*) as c FROM sos_incidents WHERE status = 'active'`).get() as { c: number }).c;
  const recentUsers = db
    .prepare(`SELECT id, name, email, phone, role, department_id, created_at FROM users WHERE account_status = 'active' ORDER BY created_at DESC LIMIT 50`)
    .all();
  const auditLogs = db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50`).all();

  res.json({
    totalUsers,
    totalReports,
    totalOfficers,
    activeSosCount,
    usersByRole,
    reportsByStatus,
    recentUsers,
    auditLogs,
    messagingProvider: getMessagingProviderStatus(),
    geminiConfigured: isGeminiConfigured(),
  });
});

app.post('/api/admin/officers', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
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
    INSERT INTO users (id, name, email, password_hash, recovery_key_hash, role, department_id, preferred_language, created_at)
    VALUES (?, ?, ?, ?, ?, 'authority', ?, 'en', ?)
  `).run(userId, name, email, hashPassword(password), hashPassword(recoveryKey), departmentId, nowIso);

  db.prepare(`INSERT INTO officers (id, user_id, department_id, name, badge_no, ward) VALUES (?, ?, ?, ?, ?, ?)`).run(
    officerId,
    userId,
    departmentId,
    name,
    badgeNo,
    ward
  );

  recordAudit(req.authUser!.id, 'admin', 'create_officer_account', 'officer', officerId, { departmentId, badgeNo });
  res.status(201).json({ userId, officerId, name, email, badgeNo, recoveryKey });
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
      `SELECT id, caregiver_name, caregiver_phone, status, notify_in_app, notify_sms, notify_whatsapp, created_at, updated_at
       FROM caregiver_relationships WHERE citizen_id = ? ORDER BY created_at DESC`
    )
    .all(userId);
  const activeTokens = db
    .prepare(
      `SELECT id, relationship_id, expires_at, revoked_at, last_accessed_at, created_at
       FROM caregiver_access_tokens WHERE citizen_id = ? AND revoked_at = '' ORDER BY created_at DESC`
    )
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
    activeSession: validSession,
    sosIncidents,
    caregiverNotifications,
    messagingProvider: getMessagingProviderStatus(),
  });
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

    const activeSession = db
      .prepare(
        `SELECT id, status, started_at, expires_at, last_lat, last_lng, last_accuracy_m, last_address, last_location_at
         FROM safety_sessions WHERE citizen_id = ? AND status = 'active' AND expires_at > ? ORDER BY started_at DESC LIMIT 1`
      )
      .get(String(rel.citizen_id), new Date().toISOString()) as Record<string, unknown> | undefined;

    const sosAlerts = db
      .prepare(
        `SELECT id, incident_code, status, trigger_lat, trigger_lng, trigger_accuracy_m, trigger_address, location_status, notes, created_at, updated_at
         FROM sos_incidents WHERE citizen_id = ? ORDER BY created_at DESC LIMIT 10`
      )
      .all(String(rel.citizen_id));

    const emergencyProfile = db
      .prepare(`SELECT blood_group, medical_notes, emergency_phone, home_ward FROM citizen_profiles WHERE user_id = ?`)
      .get(String(rel.citizen_id));

    recordAudit(caregiverId, 'caregiver', 'view_citizen_safety_data', 'citizen', String(rel.citizen_id));

    return {
      relationshipId: rel.id,
      citizenId: rel.citizen_id,
      citizenName: rel.citizen_name,
      citizenPhone: rel.citizen_phone,
      status: rel.status,
      authorized: true,
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

  const deptMap: Record<string, string> = {
    Potholes: 'dept-roads',
    'Damaged roads': 'dept-roads',
    'Damaged footpaths': 'dept-roads',
    'Garbage dumping': 'dept-sanitation',
    'Illegal dumping': 'dept-sanitation',
    'Broken streetlights': 'dept-lighting',
    'Water leakage': 'dept-water',
    'Drainage blockage': 'dept-water',
    'Open manholes': 'dept-water',
  };
  const departmentId = deptMap[category] || 'dept-roads';
  const dept = db.prepare(`SELECT sla_hours FROM departments WHERE id = ?`).get(departmentId) as { sla_hours: number } | undefined;
  const slaHours = dept?.sla_hours || 48;

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

app.patch('/api/civic/reports/:id/manage', requireAuth, requireRole('authority', 'admin'), (req: AuthenticatedRequest, res) => {
  const reportId = req.params.id;
  const { status, officerId, departmentId, severity, comment, resolutionEvidenceUrls } = req.body || {};

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
  const nextResEv = Array.isArray(resolutionEvidenceUrls) ? JSON.stringify(resolutionEvidenceUrls) : String(report.resolution_evidence_urls_json);
  const nowIso = new Date().toISOString();

  db.prepare(`
    UPDATE civic_reports
    SET status = ?, officer_id = ?, department_id = ?, severity = ?, resolution_evidence_urls_json = ?, updated_at = ?
    WHERE id = ?
  `).run(nextStatus, nextOfficer, nextDept, nextSev, nextResEv, nowIso, reportId);

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
    String(comment || `Status updated to ${nextStatus}.`),
    nowIso
  );

  db.prepare(`
    INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
    VALUES (?, ?, 'citizen', 'status_changed', ?, ?, ?, ?, 0, ?)
  `).run(
    `not-${crypto.randomUUID().slice(0, 8)}`,
    String(report.user_id),
    `Complaint ${report.report_code} → ${nextStatus}`,
    comment ? String(comment) : `Your complaint status has changed to ${nextStatus}.`,
    `आपकी शिकायत (${report.report_code}) की स्थिति बदलकर ${nextStatus} हो गई है।`,
    reportId,
    nowIso
  );

  recordAudit(req.authUser!.id, req.authUser!.role, 'manage_civic_report', 'civic_report', reportId, { nextStatus, nextOfficer });
  broadcastEvent('civic_updated', { action: 'managed', id: reportId, status: nextStatus });

  res.json({ ok: true, status: nextStatus });
});

app.get('/api/civic/departments', requireAuth, (_req, res) => {
  res.json({
    departments: db.prepare(`SELECT * FROM departments ORDER BY name ASC`).all(),
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
// USER-SCOPED NOTIFICATIONS & ANALYTICS
// ============================================================================
app.get('/api/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`)
    .all(req.authUser!.id);
  res.json({ notifications: rows });
});

app.patch('/api/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`).run(req.params.id, req.authUser!.id);
  res.json({ ok: true });
});

app.get('/api/analytics/summary', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const reports =
    user.role === 'citizen'
      ? (db.prepare(`SELECT category, ward, severity, status, sla_deadline FROM civic_reports WHERE user_id = ?`).all(user.id) as Array<Record<string, unknown>>)
      : (db.prepare(`SELECT category, ward, severity, status, sla_deadline FROM civic_reports`).all() as Array<Record<string, unknown>>);

  const routes = db.prepare(`SELECT verification_status, reliability_score FROM transit_routes`).all() as Array<Record<string, unknown>>;
  const vehicles = db.prepare(`SELECT status FROM transit_vehicles`).all() as Array<Record<string, unknown>>;
  const bins = db.prepare(`SELECT status FROM waste_bins`).all() as Array<Record<string, unknown>>;
  const collections = db.prepare(`SELECT status FROM waste_collections`).all() as Array<Record<string, unknown>>;

  const byCategory: Record<string, number> = {};
  const byWard: Record<string, number> = {};
  let overdueCount = 0;

  for (const r of reports) {
    const cat = String(r.category);
    const ward = String(r.ward);
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    byWard[ward] = (byWard[ward] || 0) + 1;
    if (!['Resolved', 'Rejected'].includes(String(r.status)) && new Date(String(r.sla_deadline)) < new Date()) {
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
