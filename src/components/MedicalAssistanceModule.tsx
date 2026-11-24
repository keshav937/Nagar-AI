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
  Send,
  ShieldAlert,
  Clock,
  XCircle,
} from 'lucide-react';
import type {
  AuthUser,
  FacilityCategory,
  FacilitySearchResult,
  GeoLocationState,
  MedicalRequest,
  PublicFacility,
} from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface MedicalAssistanceModuleProps {
  user: AuthUser | null;
  geo: GeoLocationState;
  onRequestGps: () => Promise<GeoLocationState | null>;
  onManualPin: (lat: number, lng: number, label?: string) => void;
  onNavigateTab: (tab: string) => void;
  refreshTrigger?: number;
}

const RADIUS_OPTIONS = [1, 2, 5, 10, 15, 25];

const CATEGORY_LABELS: Array<{ id: FacilityCategory; label: string }> = [
  { id: 'all', label: 'All Facilities' },
  { id: 'hospital', label: 'Hospitals' },
  { id: 'clinic', label: 'Clinics' },
  { id: 'pharmacy', label: 'Pharmacies' },
  { id: 'police', label: 'Police Stations' },
  { id: 'emergency', label: 'Emergency / Fire' },
];

const MEDICAL_REQUEST_TYPES = [
  'Emergency Medical Assistance',
  'Ambulance & Rapid Transport',
  'Urgent Clinical Consultation',
  'Critical Medication / Oxygen',
  'Women Safety Medical Escort',
];

export const MedicalAssistanceModule: React.FC<MedicalAssistanceModuleProps> = ({
  user,
  geo,
  onRequestGps,
  onManualPin,
  onNavigateTab,
  refreshTrigger = 0,
}) => {
  const [radiusKm, setRadiusKm] = useState(5);
  const [category, setCategory] = useState<FacilityCategory>('hospital');
  const [searchQuery, setSearchQuery] = useState('');
  const [areaSearch, setAreaSearch] = useState('');
  const [result, setResult] = useState<FacilitySearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PublicFacility | null>(null);

  // Medical Assistance Request form & tracking state
  const [requests, setRequests] = useState<MedicalRequest[]>([]);
  const [reqLoading, setReqLoading] = useState(false);
  const [reqType, setReqType] = useState(MEDICAL_REQUEST_TYPES[0]);
  const [reqUrgency, setReqUrgency] = useState<'normal' | 'urgent' | 'critical'>('urgent');
  const [reqDescription, setReqDescription] = useState('');
  const [triggerSosAlso, setTriggerSosAlso] = useState(false);
  const [submittingReq, setSubmittingReq] = useState(false);
  const [reqMsg, setReqMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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
        setError(err instanceof Error ? err.message : 'Unable to fetch nearby medical facilities.');
      } finally {
        setLoading(false);
      }
    },
    [radiusKm, category, searchQuery]
  );

  const fetchMyMedicalRequests = useCallback(async () => {
    if (!user) return;
    setReqLoading(true);
    try {
      const res = await apiFetch<{ requests: MedicalRequest[] }>('/api/medical/requests');
      setRequests(res.requests || []);
    } catch {
      // ignore transient
    } finally {
      setReqLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (geo.lat !== null && geo.lng !== null && user) {
      fetchNearby(geo.lat, geo.lng, false);
    }
  }, [geo.lat, geo.lng, radiusKm, category, user, fetchNearby]);

  useEffect(() => {
    fetchMyMedicalRequests();
  }, [fetchMyMedicalRequests, refreshTrigger]);

  // Initialize Leaflet map
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
        .bindTooltip('Your Location')
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
        radius: selected?.id === f.id ? 9 : 7,
        color: '#ffffff',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.94,
      }).addTo(group);
      marker.bindTooltip(`${f.name} (${f.distanceKm} km)`);
      marker.on('click', () => setSelected(f));
    });
  }, [geo.lat, geo.lng, radiusKm, result, selected]);

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
        setError('No matching area found for that search.');
      }
    } catch {
      setError('Location search service unavailable.');
    }
  };

  const handleSubmitMedicalRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    let lat = geo.lat;
    let lng = geo.lng;
    let acc = geo.accuracyM;
    let addr = geo.address;
    if (lat === null || lng === null) {
      const fresh = await onRequestGps();
      if (fresh?.lat !== null && fresh?.lng !== null && fresh) {
        lat = fresh.lat;
        lng = fresh.lng;
        acc = fresh.accuracyM;
        addr = fresh.address;
      }
    }
    if (lat === null || lng === null) {
      setReqMsg({
        type: 'err',
        text: 'Please grant GPS permission or click the map to set your exact location before requesting medical help.',
      });
      return;
    }

    setSubmittingReq(true);
    setReqMsg(null);
    try {
      let linkedSosId = '';
      if (triggerSosAlso && user.role === 'citizen') {
        const sosRes = await apiFetch<{ incident?: { id: string } }>('/api/sos', {
          method: 'POST',
          body: JSON.stringify({
            lat,
            lng,
            accuracyM: acc,
            address: addr,
            locationStatus: geo.status === 'acquired' ? 'live' : 'last_known',
            notes: `Medical Emergency (${reqType}): ${reqDescription}`,
          }),
        });
        linkedSosId = sosRes.incident?.id || '';
      }

      const res = await apiFetch<{ request: MedicalRequest }>('/api/medical/requests', {
        method: 'POST',
        body: JSON.stringify({
          requestType: reqType,
          urgency: reqUrgency,
          description: reqDescription,
          lat,
          lng,
          accuracyM: acc,
          address: addr || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          selectedFacilityName: selected?.name || '',
          selectedFacilityPhone: selected?.phone || '',
          selectedFacilityAddress: selected?.address || '',
          linkedSosId,
        }),
      });
      setReqDescription('');
      setTriggerSosAlso(false);
      setReqMsg({
        type: 'ok',
        text: `Medical Assistance Request ${res.request.request_code} dispatched to the Authority Medical Help desk.${
          linkedSosId ? ' Emergency SOS also triggered for caregivers.' : ''
        }`,
      });
      await fetchMyMedicalRequests();
    } catch (err) {
      setReqMsg({ type: 'err', text: err instanceof Error ? err.message : 'Unable to dispatch medical request.' });
    } finally {
      setSubmittingReq(false);
    }
  };

  const handleCancelRequest = async (id: string) => {
    try {
      await apiFetch(`/api/medical/requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Cancelled' }),
      });
      await fetchMyMedicalRequests();
    } catch (err) {
      setReqMsg({ type: 'err', text: err instanceof Error ? err.message : 'Unable to cancel request.' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            CITIZEN MEDICAL ASSISTANCE · LIVE GPS &amp; AUTHORITY DISPATCH
          </div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white mt-0.5 flex items-center gap-2">
            <HeartPulse className="w-6 h-6 text-emerald-700 dark:text-emerald-400" />
            Nearby Hospitals &amp; Medical Help Desk
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            Discover nearby hospitals, clinics, pharmacies &amp; police via OpenStreetMap, call directly, or dispatch a live GPS medical request to Authority Officers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <a
            href="tel:108"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg bg-red-600 text-white hover:bg-red-700"
          >
            <PhoneCall className="w-3.5 h-3.5" />
            Call 108 Ambulance
          </a>
          <a
            href="tel:112"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <PhoneCall className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
            112 Emergency
          </a>
          <button
            type="button"
            onClick={() => onRequestGps()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
          >
            <Crosshair className="w-3.5 h-3.5" />
            {geo.status === 'requesting' ? 'Detecting GPS...' : geo.lat ? 'Refresh GPS' : 'Use Current GPS'}
          </button>
          {user?.role === 'citizen' && (
            <button
              type="button"
              onClick={() => onNavigateTab('safety')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Share2 className="w-3.5 h-3.5" />
              Safety &amp; SOS
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
              placeholder="Search street/area if GPS denied..."
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
              Refresh Hospitals
            </button>
          )}
        </div>

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
              : 'Grant GPS permission, search an area, or click on the map below to locate nearby hospitals & clinics.'}
          </span>
          {result?.fetchedAt && (
            <span className="font-mono">
              {result.source} · {result.cached ? 'Cached 15m' : 'Live Query'} · {new Date(result.fetchedAt).toLocaleTimeString()}
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

      {/* Map + Nearby Hospitals List */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div ref={mapElRef} className="w-full h-[420px] bg-slate-100 dark:bg-slate-900" />
          {selected && (
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-mono uppercase text-emerald-700 dark:text-emerald-400">
                  {selected.category} · {selected.distanceKm} km away
                </div>
                <div className="text-sm font-semibold text-slate-900 dark:text-white">{selected.name}</div>
                <div className="text-xs text-slate-500">{selected.address}</div>
              </div>
              <div className="flex items-center gap-2">
                {selected.phone && (
                  <a
                    href={`tel:${selected.phone}`}
                    className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700"
                  >
                    <PhoneCall className="w-3.5 h-3.5 text-emerald-700" />
                    Call
                  </a>
                )}
                <a
                  href={`https://www.openstreetmap.org/directions?from=${geo.lat ?? ''},${geo.lng ?? ''}&to=${selected.lat},${selected.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white"
                >
                  <Navigation className="w-3.5 h-3.5" />
                  Directions
                </a>
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3 max-h-[500px] overflow-y-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-display font-bold text-slate-900 dark:text-white">
              Nearby Medical &amp; Safety Places ({result?.facilities.length ?? 0})
            </h3>
            <span className="text-[11px] text-slate-500">Sorted by distance</span>
          </div>

          {!geo.lat ? (
            <div className="py-12 text-center text-xs text-slate-500">
              Click <strong>Use Current GPS</strong> or click anywhere on the map to search nearby Hospitals, Clinics, Pharmacies, and Police Stations.
            </div>
          ) : loading ? (
            <div className="py-12 text-center text-xs text-slate-500">
              Querying live OpenStreetMap places within {radiusKm} km...
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
                  className={`py-3.5 space-y-1.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/40 px-2 rounded-lg ${
                    selected?.id === f.id ? 'bg-emerald-50/60 dark:bg-emerald-950/20' : ''
                  }`}
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

      {/* Request Medical Assistance (Connected to Authority Medical Help + Admin) */}
      {user?.role === 'citizen' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleSubmitMedicalRequest}
            className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div>
              <h3 className="text-base font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Send className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Request Medical Assistance
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Sends your live GPS coordinates, urgency, and optional preferred hospital directly to the Authority Medical Help Desk.
              </p>
            </div>

            {reqMsg && (
              <div
                className={`p-3 rounded-lg border text-xs ${
                  reqMsg.type === 'ok'
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                    : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
                }`}
              >
                {reqMsg.text}
              </div>
            )}

            {selected && (
              <div className="p-3 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-xs flex items-center justify-between gap-2">
                <div>
                  <span className="font-semibold text-emerald-800 dark:text-emerald-300">Preferred Facility: </span>
                  <span>{selected.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  Clear
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Assistance Type</label>
                <select
                  value={reqType}
                  onChange={(e) => setReqType(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  {MEDICAL_REQUEST_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Urgency</label>
                <select
                  value={reqUrgency}
                  onChange={(e) => setReqUrgency(e.target.value as 'normal' | 'urgent' | 'critical')}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  <option value="normal">Normal Consultation</option>
                  <option value="urgent">Urgent Medical Help</option>
                  <option value="critical">Critical Life-Safety Emergency</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Symptoms / Assistance Needed</label>
              <textarea
                required
                rows={3}
                value={reqDescription}
                onChange={(e) => setReqDescription(e.target.value)}
                placeholder="Describe medical condition, patient count, accessibility notes, or pickup landmarks..."
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-400 cursor-pointer">
              <input
                type="checkbox"
                checked={triggerSosAlso}
                onChange={(e) => setTriggerSosAlso(e.target.checked)}
                className="accent-red-600"
              />
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>Also trigger Emergency SOS alert to my verified caregivers</span>
            </label>

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11px] font-mono text-slate-500">
                {geo.lat !== null && geo.lng !== null
                  ? `GPS Ready: ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}`
                  : 'Location captured automatically on submit'}
              </span>
              <button
                type="submit"
                disabled={submittingReq}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
              >
                {submittingReq ? 'Dispatching...' : 'Send Medical Request'}
              </button>
            </div>
          </form>

          {/* Citizen Medical Assistance Request Tracker */}
          <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                My Medical Assistance Requests ({requests.length})
              </h3>
              <button
                type="button"
                onClick={fetchMyMedicalRequests}
                className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
              >
                Refresh
              </button>
            </div>

            {reqLoading ? (
              <p className="text-xs text-slate-500">Loading your medical requests...</p>
            ) : requests.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                No medical assistance requests submitted yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[380px] overflow-y-auto">
                {requests.map((r) => (
                  <div key={r.id} className="py-3 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-slate-900 dark:text-white">
                        {r.request_code} · {r.urgency.toUpperCase()}
                      </span>
                      <span
                        className={`font-semibold ${
                          r.status === 'Resolved'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : r.status === 'Cancelled'
                              ? 'text-slate-400'
                              : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {r.status}
                      </span>
                    </div>
                    <div className="font-medium text-slate-800 dark:text-slate-200">{r.request_type}</div>
                    <p className="text-slate-600 dark:text-slate-300">{r.description}</p>
                    {r.selected_facility_name && (
                      <div className="text-[11px] text-slate-500">Facility: {r.selected_facility_name}</div>
                    )}
                    {r.responder_notes && (
                      <div className="p-2 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[11px]">
                        <strong>Officer Response ({r.assigned_officer_name || 'Medical Desk'}):</strong>{' '}
                        {r.responder_notes}
                      </div>
                    )}
                    <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
                      <span className="font-mono">{new Date(r.created_at).toLocaleString()}</span>
                      {['Submitted', 'Acknowledged'].includes(r.status) && (
                        <button
                          type="button"
                          onClick={() => handleCancelRequest(r.id)}
                          className="inline-flex items-center gap-1 text-red-600 hover:underline cursor-pointer"
                        >
                          <XCircle className="w-3 h-3" />
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
