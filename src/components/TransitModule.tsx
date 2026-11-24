import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import L from 'leaflet';
import {
  Bus,
  Navigation,
  Clock,
  AlertCircle,
  CheckCircle2,
  Plus,
  Crosshair,
  Search,
  MapPin,
  RotateCcw,
  Route as RouteIcon,
} from 'lucide-react';
import type {
  AuthUser,
  GeoLocationState,
  MobilityDestinationResult,
  MobilityHub,
  MobilityMode,
  MobilityRouteResult,
  TransitRoute,
  TransitVehicle,
} from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface TransitModuleProps {
  user: AuthUser | null;
  geo: GeoLocationState;
  onRequestGps?: () => Promise<GeoLocationState | null>;
  onManualPin?: (lat: number, lng: number, label?: string) => void;
  routes: TransitRoute[];
  vehicles: TransitVehicle[];
  onRefresh: () => void;
  onRequireAuth: () => void;
}

const RADIUS_OPTIONS = [1, 2, 5, 10, 15, 25];

export const TransitModule: React.FC<TransitModuleProps> = ({
  user,
  geo,
  onRequestGps,
  onManualPin,
  routes,
  vehicles,
  onRefresh,
  onRequireAuth,
}) => {
  const [subTab, setSubTab] = useState<'planner' | 'commuter' | 'submit' | 'driver'>('planner');
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Live Route Planner + Nearby Transit Hubs state (Nominatim + OSRM)
  const [destInput, setDestInput] = useState('');
  const [destSuggestions, setDestSuggestions] = useState<MobilityDestinationResult[]>([]);
  const [selectedDest, setSelectedDest] = useState<MobilityDestinationResult | null>(null);
  const [travelMode, setTravelMode] = useState<MobilityMode>('driving');
  const [radiusKm, setRadiusKm] = useState(5);
  const [routeResult, setRouteResult] = useState<MobilityRouteResult | null>(null);
  const [nearbyHubs, setNearbyHubs] = useState<MobilityHub[]>([]);
  const [searchingDest, setSearchingDest] = useState(false);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [hubsLoading, setHubsLoading] = useState(false);
  const [plannerError, setPlannerError] = useState<string | null>(null);

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);

  // Shared Feeder Route Discovery filter state
  const [destinationQuery, setDestinationQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'shared_auto' | 'mini_bus' | 'e_rickshaw'>('all');

  // Submit route form
  const [rName, setRName] = useState('');
  const [rOrigin, setROrigin] = useState('');
  const [rDest, setRDest] = useState('');
  const [rCat, setRCat] = useState<'shared_auto' | 'mini_bus' | 'e_rickshaw'>('shared_auto');
  const [rFare, setRFare] = useState('20');

  // Driver update state
  const [selectedVehicleId, setSelectedVehicleId] = useState(vehicles[0]?.id || '');
  const [seatCount, setSeatCount] = useState('2');

  const fetchHubs = useCallback(
    async (lat: number, lng: number, rad: number) => {
      if (!user) return;
      setHubsLoading(true);
      try {
        const res = await apiFetch<{ hubs: MobilityHub[]; error?: string }>(
          `/api/mobility/nearby?lat=${lat}&lng=${lng}&radiusKm=${rad}`
        );
        setNearbyHubs(res.hubs || []);
        if (res.error && (res.hubs || []).length === 0) {
          setPlannerError(res.error);
        }
      } catch (err) {
        setPlannerError(err instanceof Error ? err.message : 'Unable to fetch nearby transit hubs.');
      } finally {
        setHubsLoading(false);
      }
    },
    [user]
  );

  const calculateRoute = useCallback(
    async (oLat: number, oLng: number, dLat: number, dLng: number, mode: MobilityMode) => {
      setRoutingBusy(true);
      setPlannerError(null);
      try {
        const qs = new URLSearchParams({
          originLat: String(oLat),
          originLng: String(oLng),
          destLat: String(dLat),
          destLng: String(dLng),
          mode,
        });
        const res = await apiFetch<{ route: MobilityRouteResult }>(`/api/mobility/route?${qs.toString()}`);
        setRouteResult(res.route);
      } catch (err) {
        setRouteResult(null);
        setPlannerError(err instanceof Error ? err.message : 'Unable to calculate route via OSRM.');
      } finally {
        setRoutingBusy(false);
      }
    },
    []
  );

  // Fetch nearby transit hubs whenever GPS or radius changes
  useEffect(() => {
    if (subTab === 'planner' && geo.lat !== null && geo.lng !== null && user) {
      fetchHubs(geo.lat, geo.lng, radiusKm);
    }
  }, [subTab, geo.lat, geo.lng, radiusKm, user, fetchHubs]);

  // Recalculate active route automatically if origin or travel mode changes
  useEffect(() => {
    if (geo.lat !== null && geo.lng !== null && selectedDest && user) {
      calculateRoute(geo.lat, geo.lng, selectedDest.lat, selectedDest.lng, travelMode);
    }
  }, [geo.lat, geo.lng, selectedDest, travelMode, user, calculateRoute]);

  // Initialize Leaflet map on planner tab
  useEffect(() => {
    if (subTab !== 'planner' || !mapElRef.current || mapRef.current) return;
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
      onManualPin?.(e.latlng.lat, e.latlng.lng);
    });
    mapRef.current = map;
    layerGroupRef.current = group;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, [subTab]);

  // Render map layers (origin, radius ring, hubs, destination, OSRM polyline)
  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group || subTab !== 'planner') return;
    group.clearLayers();

    if (geo.lat !== null && geo.lng !== null) {
      L.circle([geo.lat, geo.lng], {
        radius: radiusKm * 1000,
        color: '#047857',
        weight: 1.5,
        fillColor: '#10b981',
        fillOpacity: 0.06,
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

    nearbyHubs.forEach((h) => {
      const m = L.circleMarker([h.lat, h.lng], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: h.hubType === 'metro_station' ? '#1d4ed8' : '#0f766e',
        fillOpacity: 0.92,
      }).addTo(group);
      m.bindTooltip(`${h.name} (${h.hubType.replace('_', ' ')} · ${h.distanceKm} km)`);
      m.on('click', () => {
        setSelectedDest({
          name: h.address || h.name,
          shortName: h.name,
          lat: h.lat,
          lng: h.lng,
          category: h.hubType,
        });
      });
    });

    if (routeResult && routeResult.geometry.length > 1) {
      const polyline = L.polyline(routeResult.geometry, {
        color: '#047857',
        weight: 5,
        opacity: 0.88,
      }).addTo(group);
      if (selectedDest) {
        L.circleMarker([selectedDest.lat, selectedDest.lng], {
          radius: 8,
          color: '#ffffff',
          weight: 2.5,
          fillColor: '#dc2626',
          fillOpacity: 1,
        })
          .bindTooltip(`Destination: ${selectedDest.shortName}`)
          .addTo(group);
      }
      map.fitBounds(polyline.getBounds(), { padding: [36, 36] });
    } else if (geo.lat !== null && geo.lng !== null) {
      map.setView([geo.lat, geo.lng], radiusKm <= 2 ? 14 : radiusKm <= 10 ? 13 : 11);
    }
  }, [subTab, geo.lat, geo.lng, radiusKm, nearbyHubs, routeResult, selectedDest]);

  const handleSearchDestination = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return onRequireAuth();
    if (destInput.trim().length < 2) return;
    setSearchingDest(true);
    setPlannerError(null);
    try {
      const near = geo.lat !== null && geo.lng !== null ? `&lat=${geo.lat}&lng=${geo.lng}` : '';
      const res = await apiFetch<{ results: MobilityDestinationResult[]; error?: string }>(
        `/api/mobility/search?q=${encodeURIComponent(destInput.trim())}${near}`
      );
      setDestSuggestions(res.results || []);
      if (res.error) setPlannerError(res.error);
      else if ((res.results || []).length === 0) setPlannerError('No matching destination found on OpenStreetMap.');
    } catch (err) {
      setPlannerError(err instanceof Error ? err.message : 'Destination search failed.');
    } finally {
      setSearchingDest(false);
    }
  };

  const handleClearRoute = () => {
    setSelectedDest(null);
    setRouteResult(null);
    setDestInput('');
    setDestSuggestions([]);
    setPlannerError(null);
  };

  const filteredRoutes = useMemo(() => {
    const q = destinationQuery.trim().toLowerCase();
    return routes.filter((r) => {
      if (categoryFilter !== 'all' && r.vehicle_category !== categoryFilter) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.origin.toLowerCase().includes(q) ||
        r.destination.toLowerCase().includes(q) ||
        r.stops.some((s) => s.name.toLowerCase().includes(q))
      );
    });
  }, [routes, destinationQuery, categoryFilter]);

  const handleReportDelay = async (routeId: string) => {
    if (!user) return onRequireAuth();
    await apiFetch(`/api/transit/routes/${routeId}/delay`, { method: 'POST' });
    setMsg({ type: 'ok', text: 'Delay report logged for commuters and transport authority.' });
    onRefresh();
  };

  const handleVerifyRoute = async (routeId: string, status: 'verified' | 'flagged') => {
    await apiFetch(`/api/transit/routes/${routeId}/verify`, {
      method: 'PATCH',
      body: JSON.stringify({ verificationStatus: status }),
    });
    setMsg({ type: 'ok', text: `Route marked as ${status}.` });
    onRefresh();
  };

  const handleSubmitRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return onRequireAuth();
    await apiFetch('/api/transit/routes', {
      method: 'POST',
      body: JSON.stringify({
        name: rName,
        origin: rOrigin,
        destination: rDest,
        vehicleCategory: rCat,
        baseFareInr: Number(rFare) || 15,
      }),
    });
    setRName('');
    setROrigin('');
    setRDest('');
    setMsg({ type: 'ok', text: 'Route submitted to network (pending verification unless submitted by Authority).' });
    setSubTab('commuter');
    onRefresh();
  };

  const handleDriverLocationUpdate = async () => {
    if (!user) return onRequireAuth();
    const targetId = selectedVehicleId || vehicles[0]?.id;
    if (!targetId) return;
    await apiFetch(`/api/transit/vehicles/${targetId}/location`, {
      method: 'PATCH',
      body: JSON.stringify({
        lat: geo.lat ?? undefined,
        lng: geo.lng ?? undefined,
        availableSeats: Number(seatCount),
        status: 'active',
      }),
    });
    setMsg({ type: 'ok', text: 'Authorized vehicle availability & foreground coordinates updated.' });
    onRefresh();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white flex items-center gap-2">
            <RouteIcon className="w-6 h-6 text-emerald-700 dark:text-emerald-400" />
            Smart Mobility &amp; Live Route Navigation
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Real OpenStreetMap destination routing (OSRM), nearby Metro/Bus hubs, and verified shared feeder corridors.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setSubTab('planner')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              subTab === 'planner' ? 'bg-emerald-700 text-white shadow-xs' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Live Route &amp; Hubs
          </button>
          <button
            type="button"
            onClick={() => setSubTab('commuter')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              subTab === 'commuter' ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Shared Feeders ({routes.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('submit')}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              subTab === 'submit' ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            Add Route
          </button>
          {(user?.role === 'transit_driver' || user?.role === 'authority' || user?.role === 'admin') && (
            <button
              type="button"
              onClick={() => setSubTab('driver')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                subTab === 'driver' ? 'bg-emerald-700 text-white shadow-xs' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Driver &amp; Fleet
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div
          className={`p-3 rounded-lg border text-xs ${
            msg.type === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* TAB 1: LIVE SMART MOBILITY ROUTE PLANNER + REAL NEARBY TRANSIT HUBS */}
      {subTab === 'planner' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => onRequestGps?.()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
              >
                <Crosshair className="w-3.5 h-3.5" />
                {geo.status === 'requesting' ? 'Detecting GPS...' : geo.lat ? 'Refresh GPS' : 'Use Current GPS'}
              </button>

              <form onSubmit={handleSearchDestination} className="flex-1 min-w-[240px] flex items-center gap-1.5">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={destInput}
                    onChange={(e) => setDestInput(e.target.value)}
                    placeholder="Search destination (e.g. Rajiv Chowk Metro, India Gate, Railway Station)..."
                    className="w-full pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
                  />
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5 pointer-events-none" />
                </div>
                <button
                  type="submit"
                  disabled={searchingDest}
                  className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 cursor-pointer"
                >
                  {searchingDest ? 'Finding...' : 'Find Route'}
                </button>
              </form>

              <select
                aria-label="Travel Mode"
                value={travelMode}
                onChange={(e) => setTravelMode(e.target.value as MobilityMode)}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="driving">Drive / Auto</option>
                <option value="foot">Walk</option>
                <option value="cycling">Cycle / E-Bike</option>
              </select>

              <select
                aria-label="Transit Radius"
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                {RADIUS_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    Hubs within {r} km
                  </option>
                ))}
              </select>

              {(selectedDest || routeResult) && (
                <button
                  type="button"
                  onClick={handleClearRoute}
                  className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Clear Route
                </button>
              )}
            </div>

            <div className="text-[11px] text-slate-500 flex flex-wrap items-center justify-between gap-2">
              <span>
                Origin:{' '}
                {geo.lat !== null && geo.lng !== null
                  ? `${geo.address || `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`}`
                  : 'Click "Use Current GPS" or click anywhere on the map to set your starting location.'}
              </span>
              {geo.errorMessage && <span className="text-amber-600">{geo.errorMessage}</span>}
            </div>

            {destSuggestions.length > 0 && (
              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-500">Select Destination:</div>
                <div className="flex flex-wrap gap-2">
                  {destSuggestions.map((d, idx) => (
                    <button
                      key={`${d.lat}-${d.lng}-${idx}`}
                      type="button"
                      onClick={() => {
                        setSelectedDest(d);
                        setDestSuggestions([]);
                        setDestInput(d.shortName);
                      }}
                      className="text-left px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:border-emerald-600 cursor-pointer"
                    >
                      <span className="font-semibold text-slate-900 dark:text-white">{d.shortName}</span>
                      <span className="text-slate-500 ml-1.5">· {d.category}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {plannerError && (
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{plannerError}</span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Map + Active Route Summary */}
            <div className="lg:col-span-7 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div ref={mapElRef} className="w-full h-[430px] bg-slate-100 dark:bg-slate-900" />
              {routingBusy ? (
                <div className="p-4 text-xs text-slate-500 border-t border-slate-200 dark:border-slate-800">
                  Calculating real road route via OSRM...
                </div>
              ) : routeResult && selectedDest ? (
                <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-mono uppercase text-emerald-700 dark:text-emerald-400">
                        {routeResult.source} · {routeResult.mode.toUpperCase()}
                      </div>
                      <h4 className="text-sm font-display font-bold text-slate-900 dark:text-white">
                        Route to {selectedDest.shortName}
                      </h4>
                    </div>
                    <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
                      <div>
                        <span className="text-slate-500">Distance: </span>
                        <strong className="text-slate-900 dark:text-white">{routeResult.distanceKm} km</strong>
                      </div>
                      <div>
                        <span className="text-slate-500">Est. Time: </span>
                        <strong className="text-emerald-700 dark:text-emerald-400">{routeResult.durationMin} min</strong>
                      </div>
                      <a
                        href={`https://www.openstreetmap.org/directions?from=${routeResult.origin.lat},${routeResult.origin.lng}&to=${routeResult.destination.lat},${routeResult.destination.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-sans font-semibold"
                      >
                        <Navigation className="w-3.5 h-3.5" />
                        Turn-by-Turn
                      </a>
                    </div>
                  </div>
                  {routeResult.steps.length > 0 && (
                    <div className="max-h-32 overflow-y-auto border-t border-slate-100 dark:border-slate-800 pt-2 space-y-1 text-xs">
                      {routeResult.steps.map((s, idx) => (
                        <div key={idx} className="flex items-center justify-between text-slate-600 dark:text-slate-300">
                          <span className="capitalize">
                            {idx + 1}. {s.instruction}
                          </span>
                          <span className="font-mono text-[11px] text-slate-400 shrink-0 ml-2">
                            {s.distanceMeters}m
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            {/* Nearby Real Transport Hubs (Metro, Bus, Rail) */}
            <div className="lg:col-span-5 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3 max-h-[540px] overflow-y-auto">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-display font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                  Nearby Transport Hubs ({nearbyHubs.length})
                </h3>
                <span className="text-[11px] text-slate-500">Within {radiusKm} km</span>
              </div>

              {!geo.lat ? (
                <div className="py-12 text-center text-xs text-slate-500">
                  Enable GPS or click the map to discover nearby Metro stations, Bus stops, and Railway terminals.
                </div>
              ) : hubsLoading ? (
                <div className="py-12 text-center text-xs text-slate-500">
                  Querying OpenStreetMap transit stops within {radiusKm} km...
                </div>
              ) : nearbyHubs.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-500">
                  No Metro, Bus, or Railway hubs indexed on OpenStreetMap within {radiusKm} km. Try expanding the radius.
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {nearbyHubs.map((hub) => (
                    <div key={hub.id} className="py-3 space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-mono uppercase text-[11px] text-emerald-700 dark:text-emerald-400 font-semibold">
                          {hub.hubType.replace(/_/g, ' ')}
                        </span>
                        <span className="font-mono tabular-nums font-bold">{hub.distanceKm} km</span>
                      </div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-white">{hub.name}</div>
                      <div className="text-[11px] text-slate-500 line-clamp-2">{hub.address}</div>
                      <div className="pt-1 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDest({
                              name: hub.address || hub.name,
                              shortName: hub.name,
                              lat: hub.lat,
                              lng: hub.lng,
                              category: hub.hubType,
                            });
                            setDestInput(hub.name);
                          }}
                          className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                        >
                          Calculate OSRM Route →
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {subTab === 'commuter' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={destinationQuery}
              onChange={(e) => setDestinationQuery(e.target.value)}
              placeholder="Filter registered shared corridors by origin, destination, or stop..."
              className="flex-1 min-w-[240px] px-3.5 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as typeof categoryFilter)}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              <option value="all">All Vehicle Types</option>
              <option value="shared_auto">Shared Autos</option>
              <option value="mini_bus">Mini-Buses</option>
              <option value="e_rickshaw">E-Rickshaws</option>
            </select>
          </div>

          {filteredRoutes.length === 0 ? (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500">
              No shared transit routes registered in database yet. Use Add Route to contribute a shared auto or mini-bus route.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredRoutes.map((rt) => {
                const activeVehs = vehicles.filter((v) => v.route_id === rt.id && v.status === 'active');
                const totalSeats = activeVehs.reduce((s, v) => s + v.available_seats, 0);
                return (
                  <div
                    key={rt.id}
                    className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
                  >
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono">
                        {rt.route_code} · {rt.vehicle_category.replace('_', ' ')} ·{' '}
                        {rt.verification_status === 'verified' ? 'Authority Verified' : rt.verification_status}
                      </span>
                      <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                        Reliability {Math.round(rt.reliability_score * 100)}%
                      </span>
                    </div>

                    <div>
                      <h3 className="text-base font-display font-semibold text-slate-900 dark:text-white">{rt.name}</h3>
                      <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                        {rt.origin} → {rt.destination} · {rt.operating_hours}
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
                      <div>
                        <div className="text-slate-500">Fare ({rt.fare_source})</div>
                        <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                          ₹{rt.base_fare_inr}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">Est. Duration</div>
                        <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                          {rt.est_duration_min} min ({rt.distance_km} km)
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">Active Vehicles</div>
                        <div className="font-mono tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                          {activeVehs.length} ({totalSeats} seats)
                        </div>
                      </div>
                    </div>

                    {rt.stops.length > 0 && (
                      <div className="text-xs text-slate-600 dark:text-slate-400">
                        <span className="font-medium text-slate-800 dark:text-slate-200">Pickup Stops: </span>
                        {rt.stops.map((s) => `${s.name} (~${s.waitMin}m wait)`).join(' · ')}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => handleReportDelay(rt.id)}
                        className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 hover:underline cursor-pointer"
                      >
                        <AlertCircle className="w-3.5 h-3.5" />
                        Report Delay ({rt.delay_reports})
                      </button>

                      <div className="flex items-center gap-3">
                        {user?.role === 'authority' && rt.verification_status !== 'verified' && (
                          <button
                            type="button"
                            onClick={() => handleVerifyRoute(rt.id, 'verified')}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Verify Route
                          </button>
                        )}
                        {rt.stops[0] && (
                          <a
                            href={`https://www.openstreetmap.org/directions?to=${rt.stops[0].lat},${rt.stops[0].lng}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
                          >
                            <Navigation className="w-3.5 h-3.5" />
                            Walk to Pickup
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {subTab === 'submit' && (
        <form
          onSubmit={handleSubmitRoute}
          className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 max-w-2xl"
        >
          <h3 className="text-lg font-display font-semibold text-slate-900 dark:text-white">
            Contribute Shared Transit Route
          </h3>
          <p className="text-xs text-slate-500">
            Community-submitted routes are labelled as pending until verified by the Transport Authority.
          </p>
          <div>
            <label className="block text-xs font-medium mb-1">Route Name</label>
            <input
              required
              value={rName}
              onChange={(e) => setRName(e.target.value)}
              placeholder="e.g., Sector 18 Metro ↔ Tech Park Shared Auto"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Origin Pickup Point</label>
              <input
                required
                value={rOrigin}
                onChange={(e) => setROrigin(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Destination Drop-off</label>
              <input
                required
                value={rDest}
                onChange={(e) => setRDest(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Vehicle Category</label>
              <select
                value={rCat}
                onChange={(e) => setRCat(e.target.value as typeof rCat)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="shared_auto">Shared Auto</option>
                <option value="mini_bus">Mini-Bus</option>
                <option value="e_rickshaw">E-Rickshaw</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Estimated Base Fare (₹)</label>
              <input
                type="number"
                min={5}
                value={rFare}
                onChange={(e) => setRFare(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>
          <button
            type="submit"
            className="px-5 py-2.5 text-sm font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
          >
            Submit Route for Verification
          </button>
        </form>
      )}

      {subTab === 'driver' && (
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-display font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Bus className="w-5 h-5 text-emerald-700 dark:text-emerald-400" />
                Driver &amp; Fleet Live Telemetry
              </h3>
              <p className="text-xs text-slate-500">
                Publish authorized seat counts and foreground GPS coordinates for registered shared vehicles.
              </p>
            </div>
          </div>

          {(user?.role === 'transit_driver' || user?.role === 'authority' || user?.role === 'admin') &&
            vehicles.length > 0 && (
              <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Vehicle</label>
                  <select
                    value={selectedVehicleId || vehicles[0]?.id}
                    onChange={(e) => setSelectedVehicleId(e.target.value)}
                    className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.reg_number} · {v.vehicle_type}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Available Seats</label>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={seatCount}
                    onChange={(e) => setSeatCount(e.target.value)}
                    className="w-24 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleDriverLocationUpdate}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                >
                  Publish Availability &amp; GPS
                </button>
              </div>
            )}

          {vehicles.length === 0 ? (
            <p className="text-xs text-slate-500">No fleet vehicles registered in the database yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 pr-4">Registration</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Driver</th>
                    <th className="py-2 pr-4">Telemetry Source</th>
                    <th className="py-2 pr-4 text-right">Seats</th>
                    <th className="py-2 text-right">Last Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {vehicles.map((v) => (
                    <tr key={v.id}>
                      <td className="py-2.5 pr-4 font-mono font-medium">{v.reg_number}</td>
                      <td className="py-2.5 pr-4">{v.vehicle_type}</td>
                      <td className="py-2.5 pr-4">{v.driver_name}</td>
                      <td className="py-2.5 pr-4 text-slate-500">Driver Authorized</td>
                      <td className="py-2.5 pr-4 text-right font-mono tabular-nums">
                        {v.available_seats} / {v.capacity}
                      </td>
                      <td className="py-2.5 text-right font-mono tabular-nums text-slate-500">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(v.last_updated).toLocaleTimeString()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
