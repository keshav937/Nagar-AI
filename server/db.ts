import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'nagar.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      recovery_key_hash TEXT DEFAULT '',
      role TEXT NOT NULL CHECK(role IN ('citizen', 'authority', 'admin', 'caregiver', 'transit_driver', 'sanitation_driver')),
      department_id TEXT DEFAULT '',
      preferred_language TEXT NOT NULL DEFAULT 'en',
      voice_settings_json TEXT NOT NULL DEFAULT '{}',
      accessibility_json TEXT NOT NULL DEFAULT '{}',
      notification_prefs_json TEXT NOT NULL DEFAULT '{}',
      account_status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS citizen_profiles (
      user_id TEXT PRIMARY KEY,
      blood_group TEXT DEFAULT '',
      medical_notes TEXT DEFAULT '',
      emergency_phone TEXT DEFAULT '',
      home_ward TEXT DEFAULT '',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      sla_hours INTEGER NOT NULL DEFAULT 48,
      head_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS officers (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      department_id TEXT NOT NULL,
      name TEXT NOT NULL,
      badge_no TEXT UNIQUE NOT NULL,
      ward TEXT NOT NULL,
      active_count INTEGER NOT NULL DEFAULT 0,
      resolved_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(department_id) REFERENCES departments(id)
    );

    CREATE TABLE IF NOT EXISTS civic_reports (
      id TEXT PRIMARY KEY,
      report_code TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      ai_enhanced_description TEXT DEFAULT '',
      evidence_urls_json TEXT NOT NULL DEFAULT '[]',
      resolution_evidence_urls_json TEXT NOT NULL DEFAULT '[]',
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy_m REAL,
      location_source TEXT NOT NULL DEFAULT 'manual',
      address TEXT NOT NULL,
      landmark TEXT DEFAULT '',
      ward TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      is_emergency INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('Submitted', 'Under Review', 'Verified', 'Assigned', 'In Progress', 'Resolved', 'Rejected', 'Reopened', 'Escalated')),
      department_id TEXT,
      officer_id TEXT,
      sla_deadline TEXT NOT NULL,
      ai_verification_json TEXT NOT NULL DEFAULT '{}',
      community_confirmations INTEGER NOT NULL DEFAULT 0,
      upvotes INTEGER NOT NULL DEFAULT 0,
      resolution_feedback TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS complaint_activity (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(report_id) REFERENCES civic_reports(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS complaint_votes (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      vote_type TEXT NOT NULL CHECK(vote_type IN ('upvote', 'confirm', 'flag_incorrect')),
      severity_vote TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(report_id, user_id, vote_type),
      FOREIGN KEY(report_id) REFERENCES civic_reports(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS caregiver_relationships (
      id TEXT PRIMARY KEY,
      citizen_id TEXT NOT NULL,
      caregiver_user_id TEXT DEFAULT '',
      caregiver_name TEXT NOT NULL,
      caregiver_phone TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_verification', 'verified_awaiting_approval', 'active', 'revoked', 'disconnected')),
      verification_code_hash TEXT DEFAULT '',
      verification_expires_at TEXT DEFAULT '',
      notify_in_app INTEGER NOT NULL DEFAULT 1,
      notify_sms INTEGER NOT NULL DEFAULT 0,
      notify_whatsapp INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(citizen_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS caregiver_access_tokens (
      id TEXT PRIMARY KEY,
      relationship_id TEXT NOT NULL,
      citizen_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '["location","sos","safety_status","emergency_profile"]',
      expires_at TEXT NOT NULL,
      revoked_at TEXT DEFAULT '',
      last_accessed_at TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(relationship_id) REFERENCES caregiver_relationships(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS safety_sessions (
      id TEXT PRIMARY KEY,
      citizen_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'stopped', 'expired')),
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      stopped_at TEXT DEFAULT '',
      last_lat REAL,
      last_lng REAL,
      last_accuracy_m REAL,
      last_address TEXT DEFAULT '',
      last_location_at TEXT DEFAULT '',
      FOREIGN KEY(citizen_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS location_updates (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      citizen_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy_m REAL,
      address TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'gps',
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES safety_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sos_incidents (
      id TEXT PRIMARY KEY,
      incident_code TEXT UNIQUE NOT NULL,
      citizen_id TEXT NOT NULL,
      safety_session_id TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('active', 'acknowledged', 'resolved', 'cancelled')),
      trigger_lat REAL,
      trigger_lng REAL,
      trigger_accuracy_m REAL,
      trigger_address TEXT DEFAULT '',
      location_status TEXT NOT NULL CHECK(location_status IN ('live', 'last_known', 'unavailable')),
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT DEFAULT '',
      FOREIGN KEY(citizen_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS caregiver_notifications (
      id TEXT PRIMARY KEY,
      relationship_id TEXT NOT NULL,
      citizen_id TEXT NOT NULL,
      caregiver_phone TEXT NOT NULL,
      caregiver_user_id TEXT DEFAULT '',
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      sos_incident_id TEXT DEFAULT '',
      in_app_read INTEGER NOT NULL DEFAULT 0,
      sms_status TEXT NOT NULL DEFAULT 'skipped',
      sms_provider_id TEXT DEFAULT '',
      sms_error TEXT DEFAULT '',
      whatsapp_status TEXT NOT NULL DEFAULT 'skipped',
      whatsapp_provider_id TEXT DEFAULT '',
      whatsapp_error TEXT DEFAULT '',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(relationship_id) REFERENCES caregiver_relationships(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS emergency_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      relationship TEXT NOT NULL,
      phone TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS medical_facility_cache (
      id TEXT PRIMARY KEY,
      cache_key TEXT UNIQUE NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      radius_km REAL NOT NULL,
      facility_type TEXT NOT NULL,
      results_json TEXT NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transit_routes (
      id TEXT PRIMARY KEY,
      route_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      vehicle_category TEXT NOT NULL CHECK(vehicle_category IN ('shared_auto', 'mini_bus', 'e_rickshaw')),
      geometry_json TEXT NOT NULL,
      stops_json TEXT NOT NULL,
      operating_hours TEXT NOT NULL,
      base_fare_inr INTEGER NOT NULL,
      fare_source TEXT NOT NULL CHECK(fare_source IN ('verified', 'estimated', 'community')),
      est_duration_min INTEGER NOT NULL,
      distance_km REAL NOT NULL,
      verification_status TEXT NOT NULL CHECK(verification_status IN ('verified', 'pending', 'flagged')),
      reliability_score REAL NOT NULL DEFAULT 0.0,
      delay_reports INTEGER NOT NULL DEFAULT 0,
      submitted_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transit_vehicles (
      id TEXT PRIMARY KEY,
      reg_number TEXT UNIQUE NOT NULL,
      driver_id TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      route_id TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      available_seats INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'idle', 'maintenance')),
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      last_updated TEXT NOT NULL,
      FOREIGN KEY(route_id) REFERENCES transit_routes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS waste_bins (
      id TEXT PRIMARY KEY,
      bin_code TEXT UNIQUE NOT NULL,
      ward TEXT NOT NULL,
      address TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      capacity_l INTEGER NOT NULL,
      fill_level_pct INTEGER NOT NULL,
      waste_type TEXT NOT NULL,
      sensor_type TEXT NOT NULL CHECK(sensor_type IN ('ultrasonic', 'manual')),
      battery_pct INTEGER NOT NULL,
      connectivity TEXT NOT NULL CHECK(connectivity IN ('online', 'offline')),
      status TEXT NOT NULL CHECK(status IN ('normal', 'nearly_full', 'overflowing')),
      last_collected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS waste_collections (
      id TEXT PRIMARY KEY,
      bin_id TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      vehicle_code TEXT NOT NULL,
      scheduled_time TEXT NOT NULL,
      completed_at TEXT DEFAULT '',
      before_photo TEXT DEFAULT '',
      after_photo TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('scheduled', 'in_progress', 'completed', 'missed')),
      notes TEXT DEFAULT '',
      FOREIGN KEY(bin_id) REFERENCES waste_bins(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recycling_centres (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ward TEXT NOT NULL,
      address TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accepted_types_json TEXT NOT NULL,
      hours TEXT NOT NULL,
      contact TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rewards (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      households_verified INTEGER NOT NULL DEFAULT 0,
      streak_days INTEGER NOT NULL DEFAULT 0,
      badges_json TEXT NOT NULL DEFAULT '[]',
      history_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role_target TEXT NOT NULL DEFAULT 'citizen',
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      message_hi TEXT NOT NULL DEFAULT '',
      related_id TEXT DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_activity (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      input_ref TEXT NOT NULL,
      model_name TEXT NOT NULL,
      result_json TEXT NOT NULL,
      confidence REAL,
      explanation TEXT NOT NULL,
      human_review_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  // Safe schema migrations for existing SQLite databases created prior to upgrade
  const userCols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
  const userColNames = new Set(userCols.map((c) => c.name));
  if (!userColNames.has('recovery_key_hash')) {
    db.exec(`ALTER TABLE users ADD COLUMN recovery_key_hash TEXT DEFAULT ''`);
  }
  if (!userColNames.has('department_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN department_id TEXT DEFAULT ''`);
  }

  // Purge any legacy demo records from prior builds so zero dummy data remains
  if (userColNames.has('is_demo')) {
    try {
      db.exec(`
        DELETE FROM notifications WHERE is_demo = 1;
        DELETE FROM ai_activity WHERE is_demo = 1;
        DELETE FROM rewards WHERE is_demo = 1;
        DELETE FROM recycling_centres WHERE is_demo = 1;
        DELETE FROM waste_collections WHERE is_demo = 1;
        DELETE FROM waste_bins WHERE is_demo = 1;
        DELETE FROM transit_vehicles WHERE is_demo = 1;
        DELETE FROM transit_routes WHERE is_demo = 1;
        DELETE FROM civic_reports WHERE is_demo = 1;
        DELETE FROM users WHERE is_demo = 1;
      `);
    } catch {
      // ignore if columns already absent
    }
  }

  // Rebuild users table if its CHECK constraint lacks 'admin' or 'caregiver'
  const usersSqlRow = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`)
    .get() as { sql?: string } | undefined;
  if (usersSqlRow?.sql && (!usersSqlRow.sql.includes("'caregiver'") || !usersSqlRow.sql.includes("'admin'"))) {
    db.pragma('foreign_keys = OFF');
    const migrateUsers = db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          phone TEXT DEFAULT '',
          password_hash TEXT NOT NULL,
          recovery_key_hash TEXT DEFAULT '',
          role TEXT NOT NULL CHECK(role IN ('citizen', 'authority', 'admin', 'caregiver', 'transit_driver', 'sanitation_driver')),
          department_id TEXT DEFAULT '',
          preferred_language TEXT NOT NULL DEFAULT 'en',
          voice_settings_json TEXT NOT NULL DEFAULT '{}',
          accessibility_json TEXT NOT NULL DEFAULT '{}',
          notification_prefs_json TEXT NOT NULL DEFAULT '{}',
          account_status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL
        );

        INSERT INTO users_new (
          id, name, email, phone, password_hash, recovery_key_hash, role, department_id,
          preferred_language, voice_settings_json, accessibility_json, notification_prefs_json,
          account_status, created_at
        )
        SELECT
          id, name, email, COALESCE(phone, ''), password_hash, COALESCE(recovery_key_hash, ''),
          role, COALESCE(department_id, ''),
          COALESCE(preferred_language, 'en'),
          COALESCE(voice_settings_json, '{}'),
          COALESCE(accessibility_json, '{}'),
          COALESCE(notification_prefs_json, '{}'),
          COALESCE(account_status, 'active'),
          created_at
        FROM users;

        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    });
    migrateUsers();
    db.pragma('foreign_keys = ON');
  }

  // Rebuild waste_bins table if its CHECK constraint still references 'simulated'
  const binsSqlRow = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'waste_bins'`)
    .get() as { sql?: string } | undefined;
  if (binsSqlRow?.sql && (binsSqlRow.sql.includes("'simulated'") || !binsSqlRow.sql.includes("'manual'"))) {
    db.pragma('foreign_keys = OFF');
    const migrateBins = db.transaction(() => {
      db.exec(`
        CREATE TABLE waste_bins_new (
          id TEXT PRIMARY KEY,
          bin_code TEXT UNIQUE NOT NULL,
          ward TEXT NOT NULL,
          address TEXT NOT NULL,
          lat REAL NOT NULL,
          lng REAL NOT NULL,
          capacity_l INTEGER NOT NULL,
          fill_level_pct INTEGER NOT NULL,
          waste_type TEXT NOT NULL,
          sensor_type TEXT NOT NULL CHECK(sensor_type IN ('ultrasonic', 'manual')),
          battery_pct INTEGER NOT NULL,
          connectivity TEXT NOT NULL CHECK(connectivity IN ('online', 'offline')),
          status TEXT NOT NULL CHECK(status IN ('normal', 'nearly_full', 'overflowing')),
          last_collected_at TEXT NOT NULL
        );

        INSERT INTO waste_bins_new (
          id, bin_code, ward, address, lat, lng, capacity_l, fill_level_pct, waste_type,
          sensor_type, battery_pct, connectivity, status, last_collected_at
        )
        SELECT
          id, bin_code, ward, address, lat, lng, capacity_l, fill_level_pct, waste_type,
          CASE WHEN sensor_type = 'simulated' THEN 'manual' ELSE sensor_type END,
          battery_pct,
          CASE WHEN connectivity = 'simulated' THEN 'offline' ELSE connectivity END,
          status, last_collected_at
        FROM waste_bins;

        DROP TABLE waste_bins;
        ALTER TABLE waste_bins_new RENAME TO waste_bins;
      `);
    });
    migrateBins();
    db.pragma('foreign_keys = ON');
  }

  const reportCols = db.prepare(`PRAGMA table_info(civic_reports)`).all() as Array<{ name: string }>;
  const reportColNames = new Set(reportCols.map((c) => c.name));
  if (!reportColNames.has('is_emergency')) {
    db.exec(`ALTER TABLE civic_reports ADD COLUMN is_emergency INTEGER NOT NULL DEFAULT 0`);
  }

  // Ensure standard municipal department definitions exist (structural taxonomy only, zero fake reports/users)
  const deptCount = db.prepare(`SELECT COUNT(*) as c FROM departments`).get() as { c: number };
  if (deptCount.c === 0) {
    const insertDept = db.prepare(`INSERT INTO departments (id, name, code, sla_hours, head_name) VALUES (?, ?, ?, ?, ?)`);
    insertDept.run('dept-roads', 'Public Works & Roads', 'PWD-RD', 48, 'Department Head');
    insertDept.run('dept-sanitation', 'Solid Waste & Sanitation', 'SWM-01', 24, 'Department Head');
    insertDept.run('dept-lighting', 'Street Lighting & Electrical', 'ELEC-SL', 36, 'Department Head');
    insertDept.run('dept-water', 'Water Supply & Drainage', 'DJB-WD', 24, 'Department Head');
    insertDept.run('dept-mobility', 'Urban Transport Cell', 'UTC-TR', 48, 'Department Head');
  }
}
