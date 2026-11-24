import { GoogleGenAI, Type, type FunctionDeclaration, type Content } from '@google/genai';
import crypto from 'crypto';
import { db, haversineKm } from './db.ts';
import type { AuthUser } from './auth.ts';
import { fetchNearbyFacilities } from './places.ts';
import { searchMobilityDestination, computeRealRoute, fetchNearbyMobilityHubs } from './mobility.ts';

const GEMINI_MODEL = 'gemini-4-hydrogen';

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isGeminiConfigured(): boolean {
  return getGeminiClient() !== null;
}

function logAiActivity(
  module: string,
  inputRef: string,
  modelName: string,
  result: unknown,
  confidence: number | null,
  explanation: string
) {
  db.prepare(`
    INSERT INTO ai_activity (id, module, input_ref, model_name, result_json, confidence, explanation, human_review_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    `ai-${crypto.randomUUID().slice(0, 8)}`,
    module,
    inputRef,
    modelName,
    JSON.stringify(result),
    confidence,
    explanation,
    new Date().toISOString()
  );
}

export async function analyzeCivicSubmission(params: {
  category: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  imageBase64?: string;
  imageMimeType?: string;
}) {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_NOT_CONFIGURED');
  }

  const existing = db
    .prepare(`SELECT id, report_code, category, title, lat, lng, status FROM civic_reports`)
    .all() as Array<{
    id: string;
    report_code: string;
    category: string;
    title: string;
    lat: number;
    lng: number;
    status: string;
  }>;

  const nearbyMatches = existing
    .map((r) => ({ ...r, distanceKm: haversineKm(params.lat, params.lng, r.lat, r.lng) }))
    .filter((r) => r.distanceKm <= 0.6)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 3);

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  if (params.imageBase64 && params.imageMimeType) {
    parts.push({
      inlineData: {
        mimeType: params.imageMimeType,
        data: params.imageBase64,
      },
    });
  }
  parts.push({
    text: `Analyze this civic complaint submission for NAGAR AI.
Reported Category: ${params.category}
Title: ${params.title}
Description: ${params.description}
Nearby Existing Reports within 600m: ${JSON.stringify(nearbyMatches)}

Assess:
1. Best matching civic category strictly from: ["Potholes and damaged roads", "Garbage and waste management", "Blocked drains and waterlogging", "Traffic problems and road obstructions", "Street lighting and electrical faults", "Other civic infrastructure problems"]. NEVER output Animal Rescue or Road Accidents.
2. Whether any attached image is relevant & clear (if no image, set imageQuality to "not_provided" and imageRelevant to true)
3. Severity estimate (low, medium, high, critical)
4. Recommended municipal department (Public Works & Roads, Solid Waste & Sanitation, Street Lighting & Electrical, Water Supply & Drainage, Urban Transport Cell)
5. Recommended resolution action for field officer
6. Structured clean complaint description
7. Suspicious/inconsistent report flag (boolean)
8. Confidence (0 to 1) and clear human-readable explanation.`,
  });

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: { parts },
    config: {
      systemInstruction:
        'You are a municipal AI triage analyst for NAGAR AI. Never automatically mark an uncertain report as verified; always require human authority review. Never categorize reports as Animal Rescue or Road Accidents.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          predictedCategory: { type: Type.STRING },
          imageRelevant: { type: Type.BOOLEAN },
          imageQuality: { type: Type.STRING },
          severityEstimate: { type: Type.STRING },
          departmentSuggested: { type: Type.STRING },
          resolutionAction: { type: Type.STRING },
          enhancedDescription: { type: Type.STRING },
          suspiciousFlag: { type: Type.BOOLEAN },
          confidence: { type: Type.NUMBER },
          explanation: { type: Type.STRING },
        },
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim());
  const result = {
    ...parsed,
    potentialDuplicates: nearbyMatches,
    humanReviewStatus: 'pending',
  };
  logAiActivity(
    'civic',
    params.title,
    GEMINI_MODEL,
    result,
    typeof parsed.confidence === 'number' ? parsed.confidence : null,
    parsed.explanation || 'Analyzed by Gemini'
  );
  return result;
}

export async function enhanceDescriptionWithAi(draft: string, category: string, language: 'en' | 'hi') {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_NOT_CONFIGURED');
  }

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Rewrite this short citizen note into a clear, factual 2-sentence municipal complaint description in ${language === 'hi' ? 'Hindi' : 'English'}.
Category: ${category}
Citizen note: ${draft}`,
  });

  return {
    enhancedText: (response.text || draft).trim(),
  };
}

export async function classifyWasteWithAi(params: {
  description?: string;
  imageBase64?: string;
  imageMimeType?: string;
  language: 'en' | 'hi';
}) {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_NOT_CONFIGURED');
  }

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  if (params.imageBase64 && params.imageMimeType) {
    parts.push({ inlineData: { mimeType: params.imageMimeType, data: params.imageBase64 } });
  }
  parts.push({
    text: `Classify this waste item into one of: Wet waste, Dry waste, Plastic, Paper, Glass, Metal, E-waste, Other waste.
Description: ${params.description || 'Uploaded waste photo'}
Respond in ${params.language === 'hi' ? 'Hindi' : 'English'}. Never claim certainty if visual evidence is ambiguous; set uncertain=true if confidence < 0.8.`,
  });

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: { parts },
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING },
          recommendedBin: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          uncertain: { type: Type.BOOLEAN },
          explanation: { type: Type.STRING },
          disposalSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim());
  logAiActivity(
    'waste',
    params.description || 'image',
    GEMINI_MODEL,
    parsed,
    typeof parsed.confidence === 'number' ? parsed.confidence : null,
    parsed.explanation || 'Waste classification complete'
  );
  return parsed;
}

// ============================================================================
// NAGAR SAATHI — Unified Agentic Assistant with User-Scoped Backend Tools
// ============================================================================

const saathiTools: FunctionDeclaration[] = [
  {
    name: 'getCurrentLocation',
    description: 'Returns the user current GPS latitude, longitude, and resolved address from session context.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'getNearbyMedicalAndSafetyFacilities',
    description: 'Search real nearby hospitals, police stations, clinics, pharmacies, or emergency facilities around the user GPS coordinates.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: { type: Type.STRING, description: 'all, hospital, police, clinic, pharmacy, emergency' },
        radiusKm: { type: Type.NUMBER, description: '1, 2, 5, 10, 15, or 25' },
      },
    },
  },
  {
    name: 'getMySafetyStatus',
    description: 'Check the authenticated citizen active Women Safety live location session, linked caregivers count, and active SOS status.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'getNearbyCivicIssues',
    description: 'Search civic complaints submitted by this user near lat/lng within radiusKm.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        lat: { type: Type.NUMBER },
        lng: { type: Type.NUMBER },
        radiusKm: { type: Type.NUMBER },
      },
    },
  },
  {
    name: 'createCivicReport',
    description:
      'Create a civic complaint report in the database. NEVER set confirmed=true unless the user explicitly confirmed the read-back details (category, location, description) in a prior message.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: { type: Type.STRING },
        title: { type: Type.STRING },
        description: { type: Type.STRING },
        lat: { type: Type.NUMBER },
        lng: { type: Type.NUMBER },
        address: { type: Type.STRING },
        severity: { type: Type.STRING },
        confirmed: { type: Type.BOOLEAN },
      },
      required: ['category', 'title', 'description', 'confirmed'],
    },
  },
  {
    name: 'getComplaintStatus',
    description: 'Retrieve live status of a specific complaint belonging to this user by report_code, or list their latest complaints.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reportCode: { type: Type.STRING },
      },
    },
  },
  {
    name: 'getNearbyTransport',
    description: 'Find verified shared autos, mini-buses, and e-rickshaws registered in the database.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        destination: { type: Type.STRING },
      },
    },
  },
  {
    name: 'getNearbyWasteBins',
    description: 'Find registered smart waste bins near lat/lng.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        lat: { type: Type.NUMBER },
        lng: { type: Type.NUMBER },
        radiusKm: { type: Type.NUMBER },
      },
    },
  },
  {
    name: 'getSegregationInstructions',
    description: 'Explain waste segregation rules (wet, dry, plastic, paper, glass, metal, e-waste).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        item: { type: Type.STRING },
      },
    },
  },
  {
    name: 'getMyCaregivers',
    description: 'Return the authenticated citizen linked caregivers (names, phone numbers, permissions, and verification status).',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'getAuthorityGrievances',
    description: 'List authority/officer grievances filed by this citizen and their review status.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'getMyMedicalRequests',
    description: 'List medical assistance requests submitted by this citizen and their dispatch status.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'createMedicalAssistanceRequest',
    description:
      'Create a citizen Medical Assistance Request sent to Authority Medical Help. NEVER set confirmed=true unless the user explicitly confirmed the read-back details.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        requestType: { type: Type.STRING, description: 'e.g., Ambulance Dispatch, First Aid Support, Emergency Trauma Help, Clinic Escort' },
        urgency: { type: Type.STRING, description: 'normal, urgent, or critical' },
        description: { type: Type.STRING },
        selectedFacilityName: { type: Type.STRING },
        confirmed: { type: Type.BOOLEAN },
      },
      required: ['requestType', 'urgency', 'description', 'confirmed'],
    },
  },
  {
    name: 'getMobilityRoute',
    description: 'Compute a real road route, distance, and travel time from user current GPS to a named destination using Nominatim and OSRM, plus nearby transit hubs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        destination: { type: Type.STRING },
        mode: { type: Type.STRING, description: 'driving, foot, or cycling' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'triggerSosGuidance',
    description: 'Open the Women Safety & Emergency SOS confirmation screen so the citizen can confirm SOS activation safely.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'navigateApp',
    description: 'Navigate the NAGAR AI user interface to a specific section.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        destination: {
          type: Type.STRING,
          description: 'One of: overview, civic, grievances, medical, nearby, mobility, safety, caregivers, rewards, notifications, profile, waste, map',
        },
      },
      required: ['destination'],
    },
  },
];

async function executeSaathiTool(
  name: string,
  args: Record<string, unknown>,
  ctx: {
    user: AuthUser;
    location?: { lat: number; lng: number; address?: string } | null;
  }
): Promise<{ result: unknown; navigationTarget?: string; pendingAction?: Record<string, unknown>; createdReport?: Record<string, unknown> }> {
  const userLat = typeof args.lat === 'number' ? args.lat : ctx.location?.lat;
  const userLng = typeof args.lng === 'number' ? args.lng : ctx.location?.lng;

  switch (name) {
    case 'getCurrentLocation': {
      if (!ctx.location) {
        return {
          result: {
            available: false,
            message: 'Browser GPS location is not yet granted. Ask the user to enable GPS or set a manual location on the map.',
          },
        };
      }
      return {
        result: {
          available: true,
          lat: ctx.location.lat,
          lng: ctx.location.lng,
          address: ctx.location.address || `${ctx.location.lat.toFixed(4)}, ${ctx.location.lng.toFixed(4)}`,
        },
      };
    }

    case 'getNearbyMedicalAndSafetyFacilities': {
      if (typeof userLat !== 'number' || typeof userLng !== 'number') {
        return { result: { available: false, message: 'GPS coordinates are required to look up real nearby hospitals or police stations.' } };
      }
      const cat = (['all', 'hospital', 'police', 'clinic', 'pharmacy', 'emergency'].includes(String(args.category))
        ? String(args.category)
        : 'all') as 'all' | 'hospital' | 'police' | 'clinic' | 'pharmacy' | 'emergency';
      const rKm = typeof args.radiusKm === 'number' ? args.radiusKm : 5;
      const res = await fetchNearbyFacilities({ lat: userLat, lng: userLng, radiusKm: rKm, category: cat });
      return {
        result: {
          count: res.facilities.length,
          source: res.source,
          error: res.error,
          facilities: res.facilities.slice(0, 6),
        },
      };
    }

    case 'getMySafetyStatus': {
      if (ctx.user.role !== 'citizen') {
        return { result: { message: 'Women Safety sessions are available to Citizen accounts.' } };
      }
      const activeSession = db
        .prepare(`SELECT status, started_at, expires_at, last_address, last_location_at FROM safety_sessions WHERE citizen_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`)
        .get(ctx.user.id);
      const activeSos = db
        .prepare(`SELECT incident_code, status, created_at FROM sos_incidents WHERE citizen_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`)
        .get(ctx.user.id);
      const caregivers = db
        .prepare(`SELECT COUNT(*) as c FROM caregiver_relationships WHERE citizen_id = ? AND status = 'active'`)
        .get(ctx.user.id) as { c: number };
      return {
        result: {
          activeSafetySession: activeSession || null,
          activeSos: activeSos || null,
          verifiedCaregiversCount: caregivers.c,
        },
      };
    }

    case 'getNearbyCivicIssues': {
      const radius = typeof args.radiusKm === 'number' ? args.radiusKm : 5;
      const rows = db
        .prepare(
          `SELECT report_code, category, title, address, severity, status, lat, lng, created_at FROM civic_reports WHERE user_id = ? ORDER BY created_at DESC`
        )
        .all(ctx.user.id) as Array<Record<string, unknown> & { lat: number; lng: number }>;

      const filtered =
        typeof userLat === 'number' && typeof userLng === 'number'
          ? rows
              .map((r) => ({ ...r, distanceKm: haversineKm(userLat, userLng, r.lat, r.lng) }))
              .filter((r) => r.distanceKm <= radius)
              .sort((a, b) => a.distanceKm - b.distanceKm)
          : rows;

      return { result: { count: filtered.length, issues: filtered.slice(0, 6) } };
    }

    case 'createCivicReport': {
      const category = String(args.category || 'Other civic issues');
      const title = String(args.title || `${category} report`);
      const description = String(args.description || title);
      const severity = (['low', 'medium', 'high', 'critical'].includes(String(args.severity))
        ? String(args.severity)
        : 'medium') as 'low' | 'medium' | 'high' | 'critical';
      const confirmed = Boolean(args.confirmed);

      if (typeof userLat !== 'number' || typeof userLng !== 'number') {
        return {
          result: {
            status: 'needs_location',
            message: 'Location coordinates are missing. Ask the citizen to enable GPS location or pin a location on the map.',
          },
        };
      }

      const address = String(args.address || ctx.location?.address || `GPS (${userLat.toFixed(4)}, ${userLng.toFixed(4)})`);

      if (!confirmed) {
        const preview = { type: 'createCivicReport', category, title, description, severity, lat: userLat, lng: userLng, address };
        return {
          result: {
            status: 'confirmation_required',
            preview,
            instruction: 'Read back these exact complaint details to the citizen and ask for explicit Yes/Confirm before submitting.',
          },
          pendingAction: preview,
        };
      }

      const id = `rep-${crypto.randomUUID().slice(0, 8)}`;
      const reportCode = `NGR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const nowIso = new Date().toISOString();
      const slaDeadline = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

      const deptMap: Record<string, string> = {
        Potholes: 'dept-roads',
        'Damaged roads': 'dept-roads',
        'Garbage dumping': 'dept-sanitation',
        'Illegal dumping': 'dept-sanitation',
        'Broken streetlights': 'dept-lighting',
        'Water leakage': 'dept-water',
        'Drainage blockage': 'dept-water',
      };
      const deptId = deptMap[category] || 'dept-roads';

      db.prepare(`
        INSERT INTO civic_reports (
          id, report_code, user_id, category, title, description, lat, lng, location_source,
          address, ward, severity, status, department_id, sla_deadline, ai_verification_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?, ?, ?)
      `).run(
        id,
        reportCode,
        ctx.user.id,
        category,
        title,
        description,
        userLat,
        userLng,
        ctx.location ? 'gps' : 'voice',
        address,
        'Citizen Ward',
        severity,
        deptId,
        slaDeadline,
        JSON.stringify({ source: 'nagar_saathi_voice', humanReviewStatus: 'pending' }),
        nowIso,
        nowIso
      );

      db.prepare(`
        INSERT INTO complaint_activity (id, report_id, previous_status, new_status, actor_id, actor_name, actor_role, comment, created_at)
        VALUES (?, ?, NULL, 'Submitted', ?, ?, ?, 'Submitted via Nagar Saathi Voice Companion after citizen confirmation.', ?)
      `).run(`act-${crypto.randomUUID().slice(0, 8)}`, id, ctx.user.id, ctx.user.name, ctx.user.role, nowIso);

      db.prepare(`
        INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
        VALUES (?, ?, 'citizen', 'complaint_submitted', ?, ?, ?, ?, 0, ?)
      `).run(
        `not-${crypto.randomUUID().slice(0, 8)}`,
        ctx.user.id,
        `Complaint ${reportCode} Submitted`,
        `Your ${category} report at ${address} has been logged.`,
        `${address} पर आपकी ${category} शिकायत (${reportCode}) सफलतापूर्वक दर्ज हो गई है।`,
        id,
        nowIso
      );

      const created = { id, reportCode, category, title, address, severity, status: 'Submitted' };
      return { result: { status: 'created', complaint: created }, createdReport: created };
    }

    case 'getComplaintStatus': {
      const code = typeof args.reportCode === 'string' ? args.reportCode.trim().toUpperCase() : '';
      if (code) {
        const row = db
          .prepare(
            `SELECT r.report_code, r.category, r.title, r.status, r.severity, r.address, r.sla_deadline, r.updated_at, d.name as department_name, o.name as officer_name
             FROM civic_reports r
             LEFT JOIN departments d ON r.department_id = d.id
             LEFT JOIN officers o ON r.officer_id = o.id
             WHERE UPPER(r.report_code) = ? AND r.user_id = ?`
          )
          .get(code, ctx.user.id);
        return { result: row ? { found: true, complaint: row } : { found: false, message: `No report found under your account matching ${code}.` } };
      }

      const list = db
        .prepare(
          `SELECT report_code, category, title, status, severity, address, updated_at
           FROM civic_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`
        )
        .all(ctx.user.id);
      return { result: { count: list.length, complaints: list } };
    }

    case 'getNearbyTransport': {
      const q = String(args.destination || '').trim().toLowerCase();
      const routes = db.prepare(`SELECT * FROM transit_routes`).all() as Array<
        Record<string, unknown> & { name: string; origin: string; destination: string }
      >;
      const matched = q
        ? routes.filter(
            (r) =>
              r.name.toLowerCase().includes(q) ||
              r.origin.toLowerCase().includes(q) ||
              r.destination.toLowerCase().includes(q)
          )
        : routes;
      return { result: { routesFound: matched.length, routes: matched.slice(0, 5) } };
    }

    case 'getNearbyWasteBins': {
      const radius = typeof args.radiusKm === 'number' ? args.radiusKm : 5;
      const bins = db
        .prepare(`SELECT bin_code, ward, address, lat, lng, fill_level_pct, waste_type, sensor_type, status, last_collected_at FROM waste_bins`)
        .all() as Array<Record<string, unknown> & { lat: number; lng: number }>;

      const filtered =
        typeof userLat === 'number' && typeof userLng === 'number'
          ? bins
              .map((b) => ({ ...b, distanceKm: haversineKm(userLat, userLng, b.lat, b.lng) }))
              .filter((b) => b.distanceKm <= radius)
              .sort((a, b) => a.distanceKm - b.distanceKm)
          : bins;

      return { result: { count: filtered.length, bins: filtered.slice(0, 6) } };
    }

    case 'getSegregationInstructions': {
      return {
        result: {
          itemQueried: args.item || 'general',
          rules: {
            wetWaste: 'Green/Brown Bin — vegetable & fruit peels, cooked food leftovers, tea leaves, garden trimmings.',
            dryWaste: 'Blue Bin — clean plastic bottles, paper, cardboard, metal cans, glass bottles.',
            eWaste: 'E-Waste Drop-off Hub — batteries, chargers, phones, bulbs, circuit boards.',
          },
        },
      };
    }

    case 'getMyCaregivers': {
      if (ctx.user.role !== 'citizen') {
        return { result: { message: 'Caregiver links belong to Citizen accounts.' } };
      }
      const rows = db
        .prepare(
          `SELECT caregiver_name, caregiver_phone, status, can_view_location, can_receive_sos, can_view_profile
           FROM caregiver_relationships WHERE citizen_id = ? AND status != 'revoked' ORDER BY created_at DESC`
        )
        .all(ctx.user.id);
      return { result: { count: rows.length, caregivers: rows } };
    }

    case 'getAuthorityGrievances': {
      if (ctx.user.role !== 'citizen') {
        return { result: { message: 'Use Admin Portal to inspect platform grievances.' } };
      }
      const rows = db
        .prepare(
          `SELECT grievance_code, category, title, status, resolution_notes, updated_at
           FROM authority_grievances WHERE citizen_id = ? ORDER BY created_at DESC LIMIT 8`
        )
        .all(ctx.user.id);
      return { result: { count: rows.length, grievances: rows } };
    }

    case 'getMyMedicalRequests': {
      if (ctx.user.role !== 'citizen') {
        return { result: { message: 'Use Authority Medical Help to view citizen medical requests.' } };
      }
      const rows = db
        .prepare(
          `SELECT request_code, request_type, urgency, selected_facility_name, status, assigned_officer_name, responder_notes, updated_at
           FROM medical_requests WHERE citizen_id = ? ORDER BY created_at DESC LIMIT 8`
        )
        .all(ctx.user.id);
      return { result: { count: rows.length, medicalRequests: rows } };
    }

    case 'createMedicalAssistanceRequest': {
      if (ctx.user.role !== 'citizen') {
        return { result: { message: 'Medical assistance requests can only be submitted by Citizen accounts.' } };
      }
      if (typeof userLat !== 'number' || typeof userLng !== 'number') {
        return {
          result: {
            status: 'needs_location',
            message: 'GPS coordinates are required before submitting a Medical Assistance Request.',
          },
        };
      }
      const requestType = String(args.requestType || 'Medical Assistance');
      const urgency = ['normal', 'urgent', 'critical'].includes(String(args.urgency)) ? String(args.urgency) : 'urgent';
      const description = String(args.description || requestType);
      const selectedFacilityName = String(args.selectedFacilityName || '');
      const address = ctx.location?.address || `GPS (${userLat.toFixed(4)}, ${userLng.toFixed(4)})`;
      const confirmed = Boolean(args.confirmed);

      if (!confirmed) {
        const preview = {
          type: 'createMedicalAssistanceRequest',
          requestType,
          urgency,
          description,
          selectedFacilityName,
          lat: userLat,
          lng: userLng,
          address,
        };
        return {
          result: {
            status: 'confirmation_required',
            preview,
            instruction: 'Read back these exact medical request details to the citizen and ask for confirmation.',
          },
          pendingAction: preview,
        };
      }

      const id = `med-${crypto.randomUUID().slice(0, 8)}`;
      const requestCode = `MED-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const nowIso = new Date().toISOString();

      db.prepare(`
        INSERT INTO medical_requests (
          id, request_code, citizen_id, request_type, urgency, description,
          lat, lng, address, selected_facility_name, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?)
      `).run(id, requestCode, ctx.user.id, requestType, urgency, description, userLat, userLng, address, selectedFacilityName, nowIso, nowIso);

      db.prepare(`
        INSERT INTO notifications (id, user_id, role_target, event_type, title, message, message_hi, related_id, is_read, created_at)
        VALUES (?, ?, 'citizen', 'medical_request_submitted', ?, ?, ?, ?, 0, ?)
      `).run(
        `not-${crypto.randomUUID().slice(0, 8)}`,
        ctx.user.id,
        `Medical Request ${requestCode} Sent`,
        `Your ${urgency} medical assistance request (${requestType}) was sent to Authority Medical Help.`,
        `आपका मेडिकल सहायता अनुरोध (${requestCode}) अधिकारी पोर्टल को भेज दिया गया है।`,
        id,
        nowIso
      );

      return {
        result: {
          status: 'created',
          medicalRequest: { id, requestCode, requestType, urgency, address, status: 'Submitted' },
        },
        navigationTarget: 'medical',
      };
    }

    case 'getMobilityRoute': {
      const destQuery = String(args.destination || '').trim();
      const mode = (['driving', 'foot', 'cycling'].includes(String(args.mode)) ? String(args.mode) : 'driving') as
        | 'driving'
        | 'foot'
        | 'cycling';
      if (typeof userLat !== 'number' || typeof userLng !== 'number') {
        return { result: { available: false, message: 'Live GPS coordinates are required to compute a route.' } };
      }
      if (!destQuery) {
        const nearby = await fetchNearbyMobilityHubs(userLat, userLng, 5);
        return { result: { hubsCount: nearby.hubs.length, hubs: nearby.hubs.slice(0, 5), error: nearby.error } };
      }
      const searchRes = await searchMobilityDestination(destQuery, userLat, userLng);
      const top = searchRes.results[0];
      if (!top) {
        return { result: { found: false, message: `No matching destination found for "${destQuery}".`, error: searchRes.error } };
      }
      try {
        const route = await computeRealRoute({
          originLat: userLat,
          originLng: userLng,
          destLat: top.lat,
          destLng: top.lng,
          mode,
        });
        return {
          result: {
            found: true,
            destinationName: top.name,
            mode: route.mode,
            distanceKm: route.distanceKm,
            durationMin: route.durationMin,
            source: route.source,
            stepsPreview: route.steps.slice(0, 4),
          },
        };
      } catch (err) {
        return { result: { found: true, destinationName: top.name, routingError: err instanceof Error ? err.message : 'Routing failed.' } };
      }
    }

    case 'triggerSosGuidance': {
      return {
        result: {
          navigatedTo: 'safety',
          guidance: 'Opened Women Safety & Emergency SOS panel. Confirm the SOS button to alert linked caregivers and responders, or call 112 immediately.',
        },
        navigationTarget: 'safety',
      };
    }

    case 'navigateApp': {
      const dest = String(args.destination || 'overview');
      return { result: { navigatedTo: dest }, navigationTarget: dest };
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}

export async function runNagarSaathiTurn(params: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  language: 'en' | 'hi';
  activeModule: string;
  location?: { lat: number; lng: number; address?: string } | null;
  user: AuthUser;
}) {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_NOT_CONFIGURED');
  }

  const systemInstruction = `You are NAGAR SAATHI ("Speak Naturally. Your City Responds."), the official multilingual voice & chat city companion for NAGAR AI.
Current user: ${params.user.name} (Role: ${params.user.role}).
Active UI section: ${params.activeModule}.
Preferred language: ${params.language === 'hi' ? 'Hindi (Devanagari script, natural polite conversational Hindi)' : 'English (clear, warm, concise)'}.
Current GPS context: ${params.location ? `${params.location.lat.toFixed(5)}, ${params.location.lng.toFixed(5)} (${params.location.address || 'resolved'})` : 'Not acquired yet'}.

CRITICAL RULES:
1. Always respond in ${params.language === 'hi' ? 'Hindi' : 'English'}. Keep spoken replies concise (2-4 crisp sentences).
2. NEVER invent complaint IDs, hospitals, police stations, vehicle locations, fares, or collection times. ALWAYS call tools to read real data. If a user has 0 records, state clearly that none exist yet.
3. For civic complaints: follow the confirmation workflow (call createCivicReport with confirmed=false first, read back details, only set confirmed=true after explicit confirmation).`;

  const contents: Content[] = [
    ...params.history.slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    })),
    { role: 'user', parts: [{ text: params.message }] },
  ];

  let navigationTarget: string | undefined;
  let pendingAction: Record<string, unknown> | undefined;
  let createdReport: Record<string, unknown> | undefined;
  const toolsUsed: string[] = [];

  for (let step = 0; step < 4; step++) {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: saathiTools }],
      },
    });

    const candidateContent = response.candidates?.[0]?.content;
    const calls = response.functionCalls;

    if (!calls || calls.length === 0) {
      const finalReply = (response.text || '').trim();
      return {
        reply: finalReply || (params.language === 'hi' ? 'क्षमा करें, मैं समझ नहीं पाया।' : 'I could not process that request.'),
        navigationTarget,
        pendingAction,
        createdReport,
        toolsUsed,
      };
    }

    if (candidateContent) {
      contents.push(candidateContent);
    }

    const toolResponseParts = await Promise.all(
      calls.map(async (call) => {
        const fnName = call.name || 'unknown';
        toolsUsed.push(fnName);
        const exec = await executeSaathiTool(fnName, (call.args || {}) as Record<string, unknown>, {
          user: params.user,
          location: params.location,
        });
        if (exec.navigationTarget) navigationTarget = exec.navigationTarget;
        if (exec.pendingAction) pendingAction = exec.pendingAction;
        if (exec.createdReport) createdReport = exec.createdReport;

        return {
          functionResponse: {
            id: call.id,
            name: fnName,
            response: exec.result as Record<string, unknown>,
          },
        };
      })
    );

    contents.push({
      role: 'user',
      parts: toolResponseParts,
    });
  }

  return {
    reply:
      params.language === 'hi'
        ? 'मैंने जानकारी एकत्र कर ली है। कृपया बताएं कि आप आगे क्या करना चाहते हैं।'
        : 'I have gathered the requested city details. Let me know how you would like to proceed.',
    navigationTarget,
    pendingAction,
    createdReport,
    toolsUsed,
  };
}
