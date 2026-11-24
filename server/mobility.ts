import { db, haversineKm } from './db.ts';

export type MobilityMode = 'driving' | 'foot' | 'cycling';

export interface MobilityDestinationResult {
  name: string;
  shortName: string;
  lat: number;
  lng: number;
  category: string;
}

export interface MobilityRouteStep {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  roadName: string;
}

export interface MobilityRouteResult {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  mode: MobilityMode;
  distanceKm: number;
  durationMin: number;
  geometry: Array<[number, number]>;
  steps: MobilityRouteStep[];
  source: string;
}

export interface MobilityHub {
  id: string;
  name: string;
  hubType: 'metro_station' | 'bus_station' | 'bus_stop' | 'auto_stand' | 'railway_station';
  address: string;
  lat: number;
  lng: number;
  distanceKm: number;
  source: string;
}

export async function searchMobilityDestination(
  query: string,
  nearLat?: number,
  nearLng?: number
): Promise<{ results: MobilityDestinationResult[]; error?: string }> {
  const clean = query.trim();
  if (clean.length < 2) return { results: [] };

  let viewboxParam = '';
  if (typeof nearLat === 'number' && typeof nearLng === 'number' && Number.isFinite(nearLat) && Number.isFinite(nearLng)) {
    const latDelta = 0.45;
    const lngDelta = 0.45;
    viewboxParam = `&viewbox=${(nearLng - lngDelta).toFixed(4)},${(nearLat + latDelta).toFixed(4)},${(nearLng + lngDelta).toFixed(4)},${(nearLat - latDelta).toFixed(4)}`;
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&addressdetails=1&q=${encodeURIComponent(clean)}${viewboxParam}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'NAGAR-AI-SmartCity/1.0' },
      signal: AbortSignal.timeout(5500),
    });
    if (!resp.ok) {
      return { results: [], error: `Location search service returned HTTP ${resp.status}.` };
    }
    const raw = (await resp.json()) as Array<{
      display_name: string;
      name?: string;
      lat: string;
      lon: string;
      type?: string;
      class?: string;
    }>;

    const results = raw
      .map((item) => ({
        name: item.display_name,
        shortName: item.name || item.display_name.split(',')[0].trim(),
        lat: Number(item.lat),
        lng: Number(item.lon),
        category: item.type || item.class || 'place',
      }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));

    return { results };
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : 'Unable to reach Nominatim geocoding service.' };
  }
}

export async function computeRealRoute(params: {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  mode?: MobilityMode;
}): Promise<MobilityRouteResult> {
  const mode: MobilityMode = params.mode && ['driving', 'foot', 'cycling'].includes(params.mode) ? params.mode : 'driving';
  const osrmProfile = mode === 'foot' ? 'foot' : mode === 'cycling' ? 'cycling' : 'driving';

  const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${params.originLng},${params.originLat};${params.destLng},${params.destLat}?overview=full&geometries=geojson&steps=true`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'NAGAR-AI-SmartCity/1.0' },
    signal: AbortSignal.timeout(7000),
  });

  if (!resp.ok) {
    throw new Error(`OSRM routing service returned HTTP ${resp.status}.`);
  }

  const data = (await resp.json()) as {
    code?: string;
    message?: string;
    routes?: Array<{
      distance: number;
      duration: number;
      geometry?: { coordinates: Array<[number, number]> };
      legs?: Array<{
        steps?: Array<{
          distance: number;
          duration: number;
          name?: string;
          maneuver?: { type?: string; modifier?: string };
        }>;
      }>;
    }>;
  };

  const route = data.routes?.[0];
  if (data.code !== 'Ok' || !route) {
    throw new Error(data.message || 'No drivable or walkable road route found between these coordinates.');
  }

  const coords: Array<[number, number]> = (route.geometry?.coordinates || []).map(([lon, lat]) => [lat, lon]);
  const rawSteps = route.legs?.[0]?.steps || [];
  const steps: MobilityRouteStep[] = rawSteps.slice(0, 20).map((s) => {
    const mType = s.maneuver?.type || 'continue';
    const mod = s.maneuver?.modifier ? ` ${s.maneuver.modifier}` : '';
    const road = s.name ? ` onto ${s.name}` : '';
    return {
      instruction: `${mType.replace(/_/g, ' ')}${mod}${road}`.trim(),
      distanceMeters: Math.round(s.distance || 0),
      durationSeconds: Math.round(s.duration || 0),
      roadName: s.name || '',
    };
  });

  return {
    origin: { lat: params.originLat, lng: params.originLng },
    destination: { lat: params.destLat, lng: params.destLng },
    mode,
    distanceKm: Math.round((route.distance / 1000) * 100) / 100,
    durationMin: Math.max(1, Math.round(route.duration / 60)),
    geometry: coords,
    steps,
    source: 'OpenStreetMap OSRM Routing Engine',
  };
}

export async function fetchNearbyMobilityHubs(lat: number, lng: number, radiusKm = 5): Promise<{
  hubs: MobilityHub[];
  feederRoutes: Array<Record<string, unknown>>;
  activeVehicles: Array<Record<string, unknown>>;
  error?: string;
}> {
  const safeRadius = [1, 2, 5, 10, 15, 25].includes(radiusKm) ? radiusKm : 5;
  const latDelta = safeRadius / 111.32;
  const lngDelta = safeRadius / Math.max(20, 111.32 * Math.cos((lat * Math.PI) / 180));
  const viewbox = `${(lng - lngDelta).toFixed(5)},${(lat + latDelta).toFixed(5)},${(lng + lngDelta).toFixed(5)},${(lat - latDelta).toFixed(5)}`;

  const queries: Array<{ q: string; hubType: MobilityHub['hubType'] }> = [
    { q: 'metro station', hubType: 'metro_station' },
    { q: 'bus station', hubType: 'bus_station' },
    { q: 'bus stop', hubType: 'bus_stop' },
    { q: 'railway station', hubType: 'railway_station' },
  ];

  const hubs: MobilityHub[] = [];
  const seen = new Set<string>();
  let anySuccess = false;
  let lastError = '';

  await Promise.all(
    queries.map(async ({ q, hubType }) => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&viewbox=${viewbox}&bounded=1&limit=15&addressdetails=1`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'NAGAR-AI-SmartCity/1.0' },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
          lastError = `Nominatim returned HTTP ${resp.status}`;
          return;
        }
        anySuccess = true;
        const rows = (await resp.json()) as Array<{
          place_id: number;
          osm_id?: number;
          name?: string;
          display_name?: string;
          lat: string;
          lon: string;
        }>;
        for (const row of rows) {
          const hLat = Number(row.lat);
          const hLng = Number(row.lon);
          if (!Number.isFinite(hLat) || !Number.isFinite(hLng)) continue;
          const dist = haversineKm(lat, lng, hLat, hLng);
          if (dist > safeRadius) continue;
          const name = row.name || (row.display_name ? row.display_name.split(',')[0].trim() : '');
          if (!name) continue;
          const key = `${hubType}:${name.toLowerCase()}:${hLat.toFixed(4)}:${hLng.toFixed(4)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hubs.push({
            id: `hub-${row.osm_id || row.place_id}`,
            name,
            hubType,
            address: row.display_name || `${hLat.toFixed(5)}, ${hLng.toFixed(5)}`,
            lat: hLat,
            lng: hLng,
            distanceKm: dist,
            source: 'OpenStreetMap Nominatim',
          });
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Unable to query nearby transit hubs.';
      }
    })
  );

  hubs.sort((a, b) => a.distanceKm - b.distanceKm);

  const feederRoutes = (db.prepare(`SELECT * FROM transit_routes ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    geometry: JSON.parse(String(r.geometry_json || '[]')),
    stops: JSON.parse(String(r.stops_json || '[]')),
  }));
  const activeVehicles = db
    .prepare(`SELECT * FROM transit_vehicles WHERE status = 'active' ORDER BY last_updated DESC`)
    .all() as Array<Record<string, unknown> & { lat: number; lng: number }>;

  const nearbyVehicles = activeVehicles
    .map((v) => ({ ...v, distanceKm: haversineKm(lat, lng, v.lat, v.lng) }))
    .filter((v) => v.distanceKm <= safeRadius)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    hubs,
    feederRoutes,
    activeVehicles: nearbyVehicles,
    error: anySuccess || hubs.length > 0 ? undefined : lastError || 'Nearby public transport hub search unavailable.',
  };
}
