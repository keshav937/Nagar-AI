import React, { useState, useEffect, useCallback, useRef } from 'react';
import L from 'leaflet';
import {
  Crosshair,
  Search,
  RefreshCw,
  Navigation,
  PhoneCall,
  HeartPulse,
  Shield,
  AlertCircle,
  Share2,
} from 'lucide-react';
import type {
  AuthUser,
  FacilityCategory,
  FacilitySearchResult,
  GeoLocationState,
  PublicFacility,
} from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface MedicalAssistanceModuleProps {
  user: AuthUser | null;
  geo: GeoLocationState;
  onRequestGps: () => Promise<GeoLocationState | null>;
  onManualPin: (lat: number, lng: number, label?: string) => void;
  onNavigateTab: (tab: string) => void;
}

const RADIUS_OPTIONS = [1, 2, 5, 10, 15, 25];

const CATEGORY_LABELS: Array<{ id: FacilityCategory; label: string }> = [
  { id: 'all', label: 'All Facilities' },
  { id: 'hospital', label: 'Hospitals' },
  { id: 'police', label: 'Police Stations' },
  { id: 'clinic', label: 'Clinics' },
  { id: 'pharmacy', label: 'Pharmacies' },
  { id: 'emergency', label: 'Emergency / Fire' },
];

export const MedicalAssistanceModule: React.FC<MedicalAssistanceModuleProps> = ({
  user,
  geo,
  onRequestGps,
  onManualPin,
  onNavigateTab,
}) => {
  const [radiusKm, setRadiusKm] = useState(5);
  const [category, setCategory] = useState<FacilityCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [areaSearch, setAreaSearch] = useState('');
  const [result, setResult] = useState<FacilitySearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PublicFacility | null>(null);

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);

  const fetchNearby = useCallback(
    async (lat: number, lng: number, forceRefresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          lat: String(lat),
          lng: String(lng),
          radiusKm: String(radiusKm),
          category,
          q: searchQuery.trim(),
          refresh: forceRefresh ? 'true' : 'false',
        });
        const data = await apiFetch<FacilitySearchResult>(`/api/places/nearby?${qs.toString()}`);
        setResult(data);
        if (data.error) setError(data.error);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to fetch nearby medical & safety places.');
      } finally {
        setLoading(false);
      }
    },
    [radiusKm, category, searchQuery]
  );

  // Trigger query whenever user has real GPS or manual pin coordinates
  useEffect(() => {
    if (geo.lat !== null && geo.lng !== null && user) {
      fetchNearby(geo.lat, geo.lng, false);
    }
  }, [geo.lat, geo.lng, radiusKm, category, user, fetchNearby]);

  // Initialize Leaflet mini-map
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) return;
    const map = L.map(mapElRef.current, {
      center: [geo.lat ?? 28.6315, geo.lng ?? 77.2167],
      zoom: 13,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    const group = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      onManualPin(e.latlng.lat, e.latlng.lng);
    });
    mapRef.current = map;
    layerGroupRef.current = group;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const group = layerGroupRef.current;
    const map = mapRef.current;
    if (!group || !map) return;
    group.clearLayers();

    if (geo.lat !== null && geo.lng !== null) {
      map.setView([geo.lat, geo.lng], radiusKm <= 2 ? 14 : radiusKm <= 10 ? 13 : 11);
      L.circle([geo.lat, geo.lng], {
        radius: radiusKm * 1000,
        color: '#047857',
        weight: 1.5,
        fillColor: '#10b981',
        fillOpacity: 0.08,
      }).addTo(group);
      L.circleMarker([geo.lat, geo.lng], {
        radius: 8,
        color: '#ffffff',
        weight: 2.5,
        fillColor: '#047857',
        fillOpacity: 1,
      })
        .bindTooltip('Your Selected Location')
        .addTo(group);
    }

    (result?.facilities || []).forEach((f) => {
      const color =
        f.category === 'hospital' || f.category === 'emergency'
          ? '#dc2626'
          : f.category === 'police'
            ? '#1d4ed8'
            : '#059669';
      const marker = L.circleMarker([f.lat, f.lng], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.92,
      }).addTo(group);
      marker.bindTooltip(`${f.name} (${f.distanceKm} km)`);
      marker.on('click', () => setSelected(f));
    });
  }, [geo.lat, geo.lng, radiusKm, result]);

  const handleAreaSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (areaSearch.trim().length < 2) return;
    try {
      const res = await apiFetch<{ results: Array<{ name: string; lat: number; lng: number }> }>(
        `/api/geo/search?q=${encodeURIComponent(areaSearch)}`
      );
      if (res.results[0]) {
        onManualPin(res.results[0].lat, res.results[0].lng, res.results[0].name);
      } else {
        setError('No matching city or area found for that search.');
      }
    } catch {
      setError('Location search service unavailable.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            LIVE OPENSTREETMAP DISCOVERY · ZERO STATIC LISTS
          </div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white mt-0.5 flex items-center gap-2">
            <HeartPulse className="w-6 h-6 text-emerald-700 dark:text-emerald-400" />
            Nearby Medical &amp; Safety Assistance
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            Queries live OpenStreetMap Overpass data around your current GPS or manual map pin.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onRequestGps()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
          >
            <Crosshair className="w-3.5 h-3.5" />
            {geo.status === 'requesting' ? 'Detecting GPS...' : geo.lat ? 'Refresh Live GPS' : 'Use Current GPS'}
          </button>
          {user?.role === 'citizen' && (
            <button
              type="button"
              onClick={() => onNavigateTab('safety')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Share2 className="w-3.5 h-3.5" />
              Share Location with Caregivers
            </button>
          )}
        </div>
      </div>

      {/* Controls & Search Bar */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Search Radius"
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value))}
            className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            {RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>
                Within {r} km
              </option>
            ))}
          </select>

          <form onSubmit={handleAreaSearch} className="flex items-center gap-1.5">
            <input
              type="text"
              value={areaSearch}
              onChange={(e) => setAreaSearch(e.target.value)}
              placeholder="Or search street/city if GPS denied..."
              className="w-56 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
            />
            <button
              type="submit"
              className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
            >
              Set Pin
            </button>
          </form>

          <div className="relative flex-1 min-w-[200px]">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter facilities by name or address..."
              className="w-full pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
            />
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5 pointer-events-none" />
          </div>

          {geo.lat !== null && geo.lng !== null && (
            <button
              type="button"
              disabled={loading}
              onClick={() => fetchNearby(geo.lat!, geo.lng!, true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh Places
            </button>
          )}
        </div>

        {/* Category Filter Tabs */}
        <div className="flex flex-wrap gap-1.5">
          {CATEGORY_LABELS.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategory(cat.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer ${
                category === cat.id
                  ? 'bg-emerald-700 text-white'
                  : 'bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="text-[11px] text-slate-500 flex flex-wrap items-center justify-between gap-2">
          <span>
            {geo.lat !== null && geo.lng !== null
              ? `Active Coordinates: ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} (${geo.address || 'Selected Pin'})`
              : 'Grant GPS permission, search an area, or click on the map below to locate nearby hospitals & police stations.'}
          </span>
          {result?.fetchedAt && (
            <span className="font-mono">
              {result.cached ? 'Cached 15m' : 'Live Overpass Query'} · {new Date(result.fetchedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Map + Results Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div ref={mapElRef} className="w-full h-[420px] bg-slate-100 dark:bg-slate-900" />
          {selected && (
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-mono uppercase text-emerald-700 dark:text-emerald-400">
                  {selected.category} · {selected.distanceKm} km away
                </div>
                <div className="text-sm font-semibold text-slate-900 dark:text-white">{selected.name}</div>
                <div className="text-xs text-slate-500">{selected.address}</div>
              </div>
              <a
                href={`https://www.openstreetmap.org/directions?from=${geo.lat ?? ''},${geo.lng ?? ''}&to=${selected.lat},${selected.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white shrink-0"
              >
                <Navigation className="w-3.5 h-3.5" />
                Directions
              </a>
            </div>
          )}
        </div>

        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3 max-h-[500px] overflow-y-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-display font-bold text-slate-900 dark:text-white">
              Nearby Public Places ({result?.facilities.length ?? 0})
            </h3>
            <span className="text-[11px] text-slate-500">Sorted by distance</span>
          </div>

          {!geo.lat ? (
            <div className="py-12 text-center text-xs text-slate-500">
              Click <strong>Use Current GPS</strong> or click anywhere on the map to search nearby Hospitals, Police Stations, Clinics, and Pharmacies.
            </div>
          ) : loading ? (
            <div className="py-12 text-center text-xs text-slate-500">
              Querying OpenStreetMap Overpass API within {radiusKm} km...
            </div>
          ) : !result || result.facilities.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-500">
              No facilities found within {radiusKm} km matching your filter. Try expanding the search radius.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {result.facilities.map((f) => (
                <div
                  key={f.id}
                  onClick={() => {
                    setSelected(f);
                    mapRef.current?.setView([f.lat, f.lng], 15);
                  }}
                  className="py-3.5 space-y-1.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/40 px-2 rounded-lg"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono uppercase font-semibold text-emerald-700 dark:text-emerald-400">
                      {f.category} {f.emergencyTag ? `· ${f.emergencyTag}` : ''}
                    </span>
                    <span className="font-mono tabular-nums font-bold text-slate-800 dark:text-slate-200">
                      {f.distanceKm} km
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">{f.name}</div>
                  {f.address && <div className="text-xs text-slate-600 dark:text-slate-400">{f.address}</div>}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs">
                    <div className="flex items-center gap-3 text-slate-500">
                      {f.openingHours && <span>Hours: {f.openingHours}</span>}
                      {f.phone && (
                        <a
                          href={`tel:${f.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium hover:underline"
                        >
                          <PhoneCall className="w-3 h-3" />
                          {f.phone}
                        </a>
                      )}
                    </div>
                    <a
                      href={`https://www.openstreetmap.org/directions?from=${geo.lat},${geo.lng}&to=${f.lat},${f.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
                    >
                      <Navigation className="w-3.5 h-3.5" />
                      Directions
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}

          {result?.disclaimer && (
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 flex items-start gap-1.5">
              <Shield className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{result.disclaimer}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
