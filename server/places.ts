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

  return `[out:json][timeout:6];(${filters.join('')});out center 80;`;
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

interface NominatimPoi {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  type?: string;
  class?: string;
  extratags?: Record<string, string>;
}

async function fetchViaNominatimViewbox(
  lat: number,
  lng: number,
  radiusKm: number,
  category: FacilityCategory
): Promise<{ facilities: PublicFacility[]; error?: string }> {
  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / Math.max(20, 111.32 * Math.cos((lat * Math.PI) / 180));
  const viewbox = `${(lng - lngDelta).toFixed(5)},${(lat + latDelta).toFixed(5)},${(lng + lngDelta).toFixed(5)},${(lat - latDelta).toFixed(5)}`;

  const queryTerms: Array<{ term: string; cat: PublicFacility['category'] }> = [];
  if (category === 'all' || category === 'hospital') queryTerms.push({ term: 'hospital', cat: 'hospital' });
  if (category === 'all' || category === 'police') queryTerms.push({ term: 'police station', cat: 'police' });
  if (category === 'all' || category === 'clinic') queryTerms.push({ term: 'clinic', cat: 'clinic' });
  if (category === 'all' || category === 'pharmacy') queryTerms.push({ term: 'pharmacy', cat: 'pharmacy' });
  if (category === 'all' || category === 'emergency') queryTerms.push({ term: 'fire station', cat: 'emergency' });

  const results: PublicFacility[] = [];
  const seen = new Set<string>();
  let anySuccess = false;
  let lastError = '';

  await Promise.all(
    queryTerms.map(async ({ term, cat }) => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(term)}&viewbox=${viewbox}&bounded=1&limit=25&addressdetails=1&extratags=1`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'NAGAR-AI-SmartCity/1.0' },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
          lastError = `OpenStreetMap Nominatim returned HTTP ${resp.status}`;
          return;
        }
        anySuccess = true;
        const items = (await resp.json()) as NominatimPoi[];
        for (const item of items) {
          const fLat = Number(item.lat);
          const fLng = Number(item.lon);
          if (!Number.isFinite(fLat) || !Number.isFinite(fLng)) continue;

          const extra = item.extratags || {};
          const rawName = item.name || extra.name || (item.display_name ? item.display_name.split(',')[0].trim() : '');
          if (!rawName) continue;

          const dist = haversineKm(lat, lng, fLat, fLng);
          if (dist > radiusKm) continue;

          const resolvedCat: PublicFacility['category'] =
            item.type === 'hospital'
              ? 'hospital'
              : item.type === 'police'
                ? 'police'
                : item.type === 'clinic' || item.type === 'doctors'
                  ? 'clinic'
                  : item.type === 'pharmacy'
                    ? 'pharmacy'
                    : item.type === 'fire_station'
                      ? 'emergency'
                      : cat;

          const dedupeKey = `${resolvedCat}:${rawName.toLowerCase()}:${fLat.toFixed(4)}:${fLng.toFixed(4)}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          results.push({
            id: `osm-${item.osm_type || 'poi'}-${item.osm_id || item.place_id}`,
            name: rawName,
            category: resolvedCat,
            address: item.display_name || `${fLat.toFixed(5)}, ${fLng.toFixed(5)}`,
            phone: extra.phone || extra['contact:phone'] || extra['contact:mobile'] || '',
            openingHours: extra.opening_hours || '',
            emergencyTag: extra.emergency === 'yes' ? '24/7 Emergency' : '',
            lat: fLat,
            lng: fLng,
            distanceKm: dist,
            source: 'OpenStreetMap Nominatim',
          });
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Nominatim lookup timed out';
      }
    })
  );

  results.sort((a, b) => a.distanceKm - b.distanceKm);
  return {
    facilities: results,
    error: anySuccess ? undefined : lastError || 'Unable to query OpenStreetMap places.',
  };
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

  // Primary reliable OSM search via Nominatim bounded viewbox (~0.5-1.5s), with short Overpass check in parallel for extra detail if fast
  const nominatimPromise = fetchViaNominatimViewbox(params.lat, params.lng, radiusKm, category);
  const radiusMeters = Math.round(radiusKm * 1000);
  const overpassQuery = buildOverpassQuery(params.lat, params.lng, radiusMeters, category);

  const overpassPromise = (async (): Promise<PublicFacility[]> => {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'NAGAR-AI-SmartCity/1.0',
          },
          body: `data=${encodeURIComponent(overpassQuery)}`,
          signal: AbortSignal.timeout(3500),
        });
        if (!resp.ok) continue;
        const rawData = (await resp.json()) as OverpassResponse;
        if (!Array.isArray(rawData.elements)) continue;
        const list: PublicFacility[] = [];
        for (const el of rawData.elements) {
          const tags = el.tags || {};
          const fLat = el.lat ?? el.center?.lat;
          const fLng = el.lon ?? el.center?.lon;
          if (typeof fLat !== 'number' || typeof fLng !== 'number') continue;
          const name = tags.name || tags['name:en'] || tags['operator'] || '';
          if (!name) continue;
          const dist = haversineKm(params.lat, params.lng, fLat, fLng);
          if (dist > radiusKm) continue;
          list.push({
            id: `osm-${el.type}-${el.id}`,
            name,
            category: classifyOsmElement(tags),
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
        return list;
      } catch {
        // fast fallback to Nominatim
      }
    }
    return [];
  })();

  const [nomRes, overRes] = await Promise.all([nominatimPromise, overpassPromise]);

  const mergedMap = new Map<string, PublicFacility>();
  for (const item of [...overRes, ...nomRes.facilities]) {
    const key = `${item.category}:${item.name.toLowerCase()}:${item.lat.toFixed(4)}:${item.lng.toFixed(4)}`;
    const existing = mergedMap.get(key);
    if (!existing || (!existing.phone && item.phone)) {
      mergedMap.set(key, item);
    }
  }

  const parsed = Array.from(mergedMap.values()).sort((a, b) => a.distanceKm - b.distanceKm);
  const sourceLabel = overRes.length > 0 ? 'OpenStreetMap Overpass + Nominatim' : 'OpenStreetMap Nominatim';

  if (parsed.length === 0 && nomRes.error) {
    return {
      facilities: [],
      cached: false,
      source: sourceLabel,
      fetchedAt: now.toISOString(),
      disclaimer,
      error: nomRes.error,
    };
  }

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
    sourceLabel,
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
    source: sourceLabel,
    fetchedAt,
    disclaimer,
  };
}
