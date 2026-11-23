import crypto from 'crypto';
import { db, haversineKm } from './db.ts';

export type FacilityCategory = 'all' | 'hospital' | 'police' | 'clinic' | 'pharmacy' | 'emergency';

export interface PublicFacility {
  id: string;
  name: string;
  category: 'hospital' | 'police' | 'clinic' | 'pharmacy' | 'emergency';
  address: string;
  phone: string;
  openingHours: string;
  emergencyTag: string;
  lat: number;
  lng: number;
  distanceKm: number;
  source: string;
}

interface OverpassElement {
  id: number;
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

const ALLOWED_RADII_KM = [1, 2, 5, 10, 15, 25];

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function buildOverpassQuery(lat: number, lng: number, radiusMeters: number, category: FacilityCategory): string {
  const filters: string[] = [];
  if (category === 'all' || category === 'hospital') {
    filters.push(`node["amenity"="hospital"](around:${radiusMeters},${lat},${lng});`);
    filters.push(`way["amenity"="hospital"](around:${radiusMeters},${lat},${lng});`);
  }
  if (category === 'all' || category === 'police') {
    filters.push(`node["amenity"="police"](around:${radiusMeters},${lat},${lng});`);
    filters.push(`way["amenity"="police"](around:${radiusMeters},${lat},${lng});`);
  }
  if (category === 'all' || category === 'clinic') {
    filters.push(`node["amenity"~"clinic|doctors"](around:${radiusMeters},${lat},${lng});`);
    filters.push(`way["amenity"~"clinic|doctors"](around:${radiusMeters},${lat},${lng});`);
  }
  if (category === 'all' || category === 'pharmacy') {
    filters.push(`node["amenity"="pharmacy"](around:${radiusMeters},${lat},${lng});`);
    filters.push(`way["amenity"="pharmacy"](around:${radiusMeters},${lat},${lng});`);
  }
  if (category === 'all' || category === 'emergency') {
    filters.push(`node["amenity"="fire_station"](around:${radiusMeters},${lat},${lng});`);
    filters.push(`node["emergency"="yes"](around:${radiusMeters},${lat},${lng});`);
  }

  return `[out:json][timeout:14];(${filters.join('')});out center 80;`;
}

function classifyOsmElement(tags: Record<string, string>): PublicFacility['category'] {
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.amenity === 'police') return 'police';
  if (tags.amenity === 'clinic' || tags.amenity === 'doctors') return 'clinic';
  if (tags.amenity === 'pharmacy') return 'pharmacy';
  return 'emergency';
}

function formatOsmAddress(tags: Record<string, string>, lat: number, lng: number): string {
  if (tags['addr:full']) return tags['addr:full'];
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'] || tags['addr:neighbourhood'],
    tags['addr:city'],
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export async function fetchNearbyFacilities(params: {
  lat: number;
  lng: number;
  radiusKm: number;
  category?: FacilityCategory;
  query?: string;
  forceRefresh?: boolean;
}): Promise<{
  facilities: PublicFacility[];
  cached: boolean;
  source: string;
  fetchedAt: string;
  disclaimer: string;
  error?: string;
}> {
  const disclaimer =
    'Data sourced live from OpenStreetMap contributors. Emergency bed counts and real-time ambulance availability are not claimed; call the facility directly or dial 112 in an emergency.';
  const radiusKm = ALLOWED_RADII_KM.includes(params.radiusKm) ? params.radiusKm : 5;
  const category: FacilityCategory = params.category || 'all';
  const cacheKey = `${params.lat.toFixed(3)}:${params.lng.toFixed(3)}:${radiusKm}:${category}`;
  const now = new Date();

  if (!params.forceRefresh) {
    const cachedRow = db
      .prepare(`SELECT results_json, source, fetched_at, expires_at FROM medical_facility_cache WHERE cache_key = ?`)
      .get(cacheKey) as { results_json: string; source: string; fetched_at: string; expires_at: string } | undefined;

    if (cachedRow && new Date(cachedRow.expires_at) > now) {
      let list = JSON.parse(cachedRow.results_json) as PublicFacility[];
      if (params.query) {
        const q = params.query.trim().toLowerCase();
        list = list.filter((f) => f.name.toLowerCase().includes(q) || f.address.toLowerCase().includes(q));
      }
      return {
        facilities: list,
        cached: true,
        source: cachedRow.source,
        fetchedAt: cachedRow.fetched_at,
        disclaimer,
      };
    }
  }

  const radiusMeters = Math.round(radiusKm * 1000);
  const overpassQuery = buildOverpassQuery(params.lat, params.lng, radiusMeters, category);

  let rawData: OverpassResponse | null = null;
  let lastError = 'Unable to reach OpenStreetMap Overpass API.';

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'NAGAR-AI-SmartCity/1.0',
        },
        body: `data=${encodeURIComponent(overpassQuery)}`,
        signal: AbortSignal.timeout(12_000),
      });
      if (!resp.ok) {
        lastError = `Places provider returned HTTP ${resp.status}.`;
        continue;
      }
      rawData = (await resp.json()) as OverpassResponse;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Overpass network timeout.';
    }
  }

  if (!rawData || !Array.isArray(rawData.elements)) {
    return {
      facilities: [],
      cached: false,
      source: 'OpenStreetMap Overpass API',
      fetchedAt: now.toISOString(),
      disclaimer,
      error: lastError,
    };
  }

  const seen = new Set<string>();
  const parsed: PublicFacility[] = [];

  for (const el of rawData.elements) {
    const tags = el.tags || {};
    const fLat = el.lat ?? el.center?.lat;
    const fLng = el.lon ?? el.center?.lon;
    if (typeof fLat !== 'number' || typeof fLng !== 'number') continue;

    const name = tags.name || tags['name:en'] || tags['operator'] || '';
    if (!name) continue; // Only include verified named facilities

    const cat = classifyOsmElement(tags);
    const dedupeKey = `${cat}:${name.toLowerCase()}:${fLat.toFixed(4)}:${fLng.toFixed(4)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const dist = haversineKm(params.lat, params.lng, fLat, fLng);
    if (dist > radiusKm) continue;

    parsed.push({
      id: `osm-${el.type}-${el.id}`,
      name,
      category: cat,
      address: formatOsmAddress(tags, fLat, fLng),
      phone: tags.phone || tags['contact:phone'] || tags['contact:mobile'] || '',
      openingHours: tags.opening_hours || '',
      emergencyTag: tags.emergency === 'yes' ? '24/7 Emergency' : '',
      lat: fLat,
      lng: fLng,
      distanceKm: dist,
      source: 'OpenStreetMap Overpass API',
    });
  }

  parsed.sort((a, b) => a.distanceKm - b.distanceKm);

  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO medical_facility_cache (id, cache_key, lat, lng, radius_km, facility_type, results_json, source, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `mfc-${crypto.randomUUID().slice(0, 8)}`,
    cacheKey,
    params.lat,
    params.lng,
    radiusKm,
    category,
    JSON.stringify(parsed),
    'OpenStreetMap Overpass API',
    fetchedAt,
    expiresAt
  );

  let filtered = parsed;
  if (params.query) {
    const q = params.query.trim().toLowerCase();
    filtered = parsed.filter((f) => f.name.toLowerCase().includes(q) || f.address.toLowerCase().includes(q));
  }

  return {
    facilities: filtered,
    cached: false,
    source: 'OpenStreetMap Overpass API',
    fetchedAt,
    disclaimer,
  };
}
