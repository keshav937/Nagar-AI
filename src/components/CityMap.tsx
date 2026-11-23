import React, { useEffect, useRef, useState, useMemo } from 'react';
import L from 'leaflet';
import {
  Crosshair,
  Search,
  Layers,
  List,
  Map as MapIcon,
  RefreshCw,
  Navigation,
  X,
  AlertCircle,
} from 'lucide-react';
import type {
  CivicReport,
  GeoLocationState,
  LanguageCode,
  RecyclingCentre,
  TransitRoute,
  TransitVehicle,
  WasteBin,
} from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface CityMapProps {
  geo: GeoLocationState;
  onRequestGps: () => void;
  onManualPin: (lat: number, lng: number, label?: string) => void;
  reports: CivicReport[];
  routes: TransitRoute[];
  vehicles: TransitVehicle[];
  bins: WasteBin[];
  recyclingCentres: RecyclingCentre[];
  language: LanguageCode;
  onRefreshData: () => void;
  allowPinSelection?: boolean;
  compact?: boolean;
}

type LayerKey =
  | 'potholes'
  | 'garbage'
  | 'streetlights'
  | 'drainage'
  | 'other_civic'
  | 'shared_auto'
  | 'mini_bus'
  | 'transit_stops'
  | 'vehicles'
  | 'bins_normal'
  | 'bins_overflow'
  | 'recycling';

interface SelectedItem {
  kind: 'civic' | 'route' | 'vehicle' | 'bin' | 'recycling';
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
  details: Array<{ label: string; value: string }>;
}

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

export const CityMap: React.FC<CityMapProps> = ({
  geo,
  onRequestGps,
  onManualPin,
  reports,
  routes,
  vehicles,
  bins,
  recyclingCentres,
  language,
  onRefreshData,
  allowPinSelection = true,
  compact = false,
}) => {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);

  const [radiusKm, setRadiusKm] = useState<number>(5);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  const [pinMode, setPinMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ name: string; lat: number; lng: number }>>([]);
  const [showLayerPanel, setShowLayerPanel] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);

  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    potholes: true,
    garbage: true,
    streetlights: true,
    drainage: true,
    other_civic: true,
    shared_auto: true,
    mini_bus: true,
    transit_stops: true,
    vehicles: true,
    bins_normal: true,
    bins_overflow: true,
    recycling: true,
  });

  const centerLat = geo.lat ?? 28.6315;
  const centerLng = geo.lng ?? 77.2167;
  const hasActiveUserCoord = geo.lat !== null && geo.lng !== null;

  const toggleLayer = (k: LayerKey) => setLayers((prev) => ({ ...prev, [k]: !prev[k] }));

  // Initialize Leaflet map once
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) return;
    const map = L.map(mapElRef.current, {
      center: [centerLat, centerLng],
      zoom: 13,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = group;

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  // Handle manual pin click mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e: L.LeafletMouseEvent) => {
      if (pinMode || allowPinSelection) {
        onManualPin(e.latlng.lat, e.latlng.lng);
        setPinMode(false);
      }
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [pinMode, allowPinSelection, onManualPin]);

  // Pan map when user location updates
  useEffect(() => {
    if (mapRef.current && geo.lat !== null && geo.lng !== null) {
      mapRef.current.setView([geo.lat, geo.lng], Math.max(mapRef.current.getZoom(), 13));
    }
  }, [geo.lat, geo.lng]);

  // Render markers, radius ring, and route polylines
  useEffect(() => {
    const group = layerGroupRef.current;
    if (!group) return;
    group.clearLayers();

    if (hasActiveUserCoord) {
      L.circle([centerLat, centerLng], {
        radius: radiusKm * 1000,
        color: '#047857',
        weight: 1.5,
        fillColor: '#10b981',
        fillOpacity: 0.08,
      }).addTo(group);

      const userMarker = L.circleMarker([centerLat, centerLng], {
        radius: 8,
        color: '#ffffff',
        weight: 2.5,
        fillColor: '#047857',
        fillOpacity: 1,
      }).addTo(group);
      userMarker.bindTooltip(geo.status === 'acquired' ? 'Your GPS Location' : 'Selected Map Pin', {
        direction: 'top',
      });
    }

    const inRadius = (lat: number, lng: number) =>
      !hasActiveUserCoord || distKm(centerLat, centerLng, lat, lng) <= radiusKm;

    // Civic reports
    reports.forEach((r) => {
      if (!inRadius(r.lat, r.lng)) return;
      const cat = r.category.toLowerCase();
      const show =
        (cat.includes('pothole') && layers.potholes) ||
        ((cat.includes('garbage') || cat.includes('dumping')) && layers.garbage) ||
        (cat.includes('streetlight') && layers.streetlights) ||
        ((cat.includes('drainage') || cat.includes('water')) && layers.drainage) ||
        (!cat.includes('pothole') &&
          !cat.includes('garbage') &&
          !cat.includes('dumping') &&
          !cat.includes('streetlight') &&
          !cat.includes('drainage') &&
          !cat.includes('water') &&
          layers.other_civic);
      if (!show) return;

      const color =
        r.status === 'Resolved'
          ? '#16a34a'
          : r.severity === 'critical'
            ? '#dc2626'
            : r.severity === 'high'
              ? '#d97706'
              : '#0f766e';

      const marker = L.circleMarker([r.lat, r.lng], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.92,
      }).addTo(group);
      marker.bindTooltip(`${r.report_code}: ${r.category}`);
      marker.on('click', () => {
        setSelectedItem({
          kind: 'civic',
          title: r.title,
          subtitle: `${r.report_code} · ${r.category}`,
          lat: r.lat,
          lng: r.lng,
          details: [
            { label: 'Status', value: r.status },
            { label: 'Severity', value: r.severity.toUpperCase() },
            { label: 'Address', value: r.address },
            { label: 'Department', value: r.department_name || 'Pending assignment' },
            { label: 'Confirmations', value: `${r.community_confirmations} citizens` },
          ],
        });
      });
    });

    // Transit routes & stops
    routes.forEach((rt) => {
      const showRoute =
        (rt.vehicle_category === 'mini_bus' && layers.mini_bus) ||
        (rt.vehicle_category !== 'mini_bus' && layers.shared_auto);
      if (showRoute && rt.geometry.length > 1) {
        const line = L.polyline(rt.geometry, {
          color: rt.vehicle_category === 'mini_bus' ? '#0f766e' : '#059669',
          weight: 4,
          opacity: 0.78,
          dashArray: rt.vehicle_category === 'e_rickshaw' ? '6 6' : undefined,
        }).addTo(group);
        line.on('click', () => {
          setSelectedItem({
            kind: 'route',
            title: rt.name,
            subtitle: `${rt.route_code} · ${rt.vehicle_category.replace('_', ' ')}`,
            lat: rt.stops[0]?.lat || centerLat,
            lng: rt.stops[0]?.lng || centerLng,
            details: [
              { label: 'Operating Hours', value: rt.operating_hours },
              { label: 'Fare', value: `₹${rt.base_fare_inr} (${rt.fare_source})` },
              { label: 'Est. Duration', value: `${rt.est_duration_min} min (${rt.distance_km} km)` },
              { label: 'Verification', value: rt.verification_status },
            ],
          });
        });
      }

      if (layers.transit_stops) {
        rt.stops.forEach((st) => {
          if (!inRadius(st.lat, st.lng)) return;
          const stopDot = L.circleMarker([st.lat, st.lng], {
            radius: 5,
            color: '#064e3b',
            weight: 1.5,
            fillColor: '#d1fae5',
            fillOpacity: 1,
          }).addTo(group);
          stopDot.bindTooltip(`${st.name} (~${st.waitMin}m wait)`);
        });
      }
    });

    // Live / Simulated vehicles
    if (layers.vehicles) {
      vehicles.forEach((v) => {
        if (!inRadius(v.lat, v.lng)) return;
        const m = L.circleMarker([v.lat, v.lng], {
          radius: 7,
          color: '#065f46',
          weight: 2,
          fillColor: '#34d399',
          fillOpacity: 0.95,
        }).addTo(group);
        m.bindTooltip(`${v.vehicle_type} (${v.reg_number}) · ${v.available_seats} seats`);
        m.on('click', () => {
          setSelectedItem({
            kind: 'vehicle',
            title: `${v.vehicle_type} · ${v.reg_number}`,
            subtitle: 'Driver-Reported Location',
            lat: v.lat,
            lng: v.lng,
            details: [
              { label: 'Driver', value: v.driver_name },
              { label: 'Available Seats', value: `${v.available_seats} / ${v.capacity}` },
              { label: 'Status', value: v.status },
              { label: 'Updated', value: new Date(v.last_updated).toLocaleTimeString() },
            ],
          });
        });
      });
    }

    // Waste bins
    bins.forEach((b) => {
      if (!inRadius(b.lat, b.lng)) return;
      const isOverflow = b.status === 'overflowing';
      if (isOverflow && !layers.bins_overflow) return;
      if (!isOverflow && !layers.bins_normal) return;

      const color = isOverflow ? '#dc2626' : b.status === 'nearly_full' ? '#d97706' : '#059669';
      const m = L.circleMarker([b.lat, b.lng], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.95,
      }).addTo(group);
      m.bindTooltip(`${b.bin_code} · ${b.fill_level_pct}% full`);
      m.on('click', () => {
        setSelectedItem({
          kind: 'bin',
          title: `${b.bin_code} (${b.waste_type})`,
          subtitle: 'Ultrasonic IoT Sensor',
          lat: b.lat,
          lng: b.lng,
          details: [
            { label: 'Fill Level', value: `${b.fill_level_pct}% (${b.status.replace('_', ' ')})` },
            { label: 'Address', value: b.address },
            { label: 'Battery', value: `${b.battery_pct}%` },
            { label: 'Last Collected', value: new Date(b.last_collected_at).toLocaleString() },
          ],
        });
      });
    });

    // Recycling centres
    if (layers.recycling) {
      recyclingCentres.forEach((rc) => {
        if (!inRadius(rc.lat, rc.lng)) return;
        const m = L.circleMarker([rc.lat, rc.lng], {
          radius: 7,
          color: '#14532d',
          weight: 2,
          fillColor: '#22c55e',
          fillOpacity: 0.9,
        }).addTo(group);
        m.bindTooltip(rc.name);
        m.on('click', () => {
          setSelectedItem({
            kind: 'recycling',
            title: rc.name,
            subtitle: rc.ward,
            lat: rc.lat,
            lng: rc.lng,
            details: [
              { label: 'Accepted Materials', value: rc.acceptedTypes.join(', ') },
              { label: 'Hours', value: rc.hours },
              { label: 'Address', value: rc.address },
              { label: 'Contact', value: rc.contact },
            ],
          });
        });
      });
    }
  }, [reports, routes, vehicles, bins, recyclingCentres, layers, radiusKm, hasActiveUserCoord, centerLat, centerLng, geo.status]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim().length < 2) return;
    try {
      const res = await apiFetch<{ results: Array<{ name: string; lat: number; lng: number }> }>(
        `/api/geo/search?q=${encodeURIComponent(searchQuery)}`
      );
      setSearchResults(res.results);
    } catch {
      setSearchResults([]);
    }
  };

  const nearbyList = useMemo(() => {
    const items: Array<{ id: string; type: string; title: string; meta: string; distanceKm: number | null; lat: number; lng: number }> = [];
    reports.forEach((r) => {
      const d = hasActiveUserCoord ? distKm(centerLat, centerLng, r.lat, r.lng) : null;
      if (d === null || d <= radiusKm) {
        items.push({ id: r.id, type: 'Civic Issue', title: r.title, meta: `${r.report_code} · ${r.status}`, distanceKm: d, lat: r.lat, lng: r.lng });
      }
    });
    bins.forEach((b) => {
      const d = hasActiveUserCoord ? distKm(centerLat, centerLng, b.lat, b.lng) : null;
      if (d === null || d <= radiusKm) {
        items.push({ id: b.id, type: 'Smart Bin', title: `${b.bin_code} (${b.address})`, meta: `${b.fill_level_pct}% full · ${b.status}`, distanceKm: d, lat: b.lat, lng: b.lng });
      }
    });
    vehicles.forEach((v) => {
      const d = hasActiveUserCoord ? distKm(centerLat, centerLng, v.lat, v.lng) : null;
      if (d === null || d <= radiusKm) {
        items.push({ id: v.id, type: 'Transit Vehicle', title: `${v.vehicle_type} (${v.reg_number})`, meta: `${v.available_seats} seats available`, distanceKm: d, lat: v.lat, lng: v.lng });
      }
    });
    return items.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
  }, [reports, bins, vehicles, hasActiveUserCoord, centerLat, centerLng, radiusKm]);

  return (
    <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      {/* Map Control Bar */}
      <div className="p-3 sm:p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRequestGps}
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Crosshair className="w-3.5 h-3.5" />
            {geo.status === 'requesting'
              ? language === 'hi'
                ? 'लोकेशन प्राप्त हो रही है...'
                : 'Locating GPS...'
              : hasActiveUserCoord
                ? language === 'hi'
                  ? 'GPS रीफ़्रेश करें'
                  : 'Refresh GPS'
                : language === 'hi'
                  ? 'वर्तमान GPS उपयोग करें'
                  : 'Use Current GPS'}
          </button>

          {allowPinSelection && (
            <button
              type="button"
              onClick={() => setPinMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                pinMode
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-600 text-emerald-800 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'
              }`}
            >
              {pinMode ? 'Click Map to Drop Pin' : 'Adjust Pin'}
            </button>
          )}

          <select
            aria-label="Search Radius"
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value))}
            className="px-2.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
          >
            <option value={0.5}>500 m radius</option>
            <option value={1}>1 km radius</option>
            <option value={2}>2 km radius</option>
            <option value={5}>5 km radius</option>
            <option value={10}>10 km radius</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={handleSearch} className="relative flex items-center">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search area or street..."
              className="w-44 sm:w-56 pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-600"
            />
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
          </form>

          <button
            type="button"
            onClick={() => setShowLayerPanel((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5" />
            Layers
          </button>

          <div className="flex items-center bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg">
            <button
              type="button"
              onClick={() => setViewMode('map')}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                viewMode === 'map'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <MapIcon className="w-3.5 h-3.5" />
              Map
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              List
            </button>
          </div>

          <button
            type="button"
            onClick={onRefreshData}
            aria-label="Refresh Map Data"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Location Status & Accuracy Metadata Strip */}
      <div className="px-4 py-2 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800 dark:text-slate-200">
            {geo.status === 'acquired'
              ? 'GPS Acquired'
              : geo.status === 'manual'
                ? 'Manual Map Pin'
                : geo.status === 'denied'
                  ? 'GPS Denied — Manual Fallback Active'
                  : 'Viewport Default — Grant GPS or Click Map'}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            {hasActiveUserCoord ? `${geo.lat!.toFixed(5)}, ${geo.lng!.toFixed(5)}` : 'Awaiting user coordinates'}
          </span>
          {geo.accuracyM !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">±{geo.accuracyM}m</span>
            </>
          )}
          {geo.address && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate max-w-md">{geo.address}</span>
            </>
          )}
        </div>
        <span className="text-[11px] text-slate-500">
          Foreground updates only (browser geolocation constraint)
        </span>
      </div>

      {geo.errorMessage && (
        <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{geo.errorMessage}</span>
        </div>
      )}

      {searchResults.length > 0 && (
        <div className="px-4 py-2 bg-emerald-50/60 dark:bg-emerald-950/20 border-b border-slate-200 dark:border-slate-800 flex flex-wrap gap-2">
          {searchResults.map((sr, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                onManualPin(sr.lat, sr.lng, sr.name);
                setSearchResults([]);
                mapRef.current?.setView([sr.lat, sr.lng], 14);
              }}
              className="text-xs px-2.5 py-1 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-emerald-600 text-slate-700 dark:text-slate-200 truncate max-w-xs cursor-pointer"
            >
              {sr.name}
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        {showLayerPanel && (
          <div className="absolute top-3 right-3 z-20 w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-3.5 shadow-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-900 dark:text-white">Map Layers</span>
              <button
                type="button"
                onClick={() => setShowLayerPanel(false)}
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1.5 text-xs">
              {(
                [
                  ['potholes', 'Potholes & Roads'],
                  ['garbage', 'Garbage Dumping'],
                  ['streetlights', 'Broken Streetlights'],
                  ['drainage', 'Drainage & Water'],
                  ['other_civic', 'Other Civic Reports'],
                  ['shared_auto', 'Shared Auto & E-Rickshaw Routes'],
                  ['mini_bus', 'Mini-Bus Routes'],
                  ['transit_stops', 'Transit Stops'],
                  ['vehicles', 'Registered Vehicles'],
                  ['bins_normal', 'Normal Smart Bins'],
                  ['bins_overflow', 'Overflowing Bins'],
                  ['recycling', 'Recycling Centres'],
                ] as Array<[LayerKey, string]>
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={layers[key]}
                    onChange={() => toggleLayer(key)}
                    className="accent-emerald-700 rounded"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {viewMode === 'map' ? (
          <div
            ref={mapElRef}
            className={`w-full ${compact ? 'h-[340px]' : 'h-[480px] lg:h-[540px]'} bg-slate-100 dark:bg-slate-900`}
          />
        ) : (
          <div className="max-h-[480px] overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
            {nearbyList.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No records found within {radiusKm} km. Try expanding the radius or resetting filters.
              </div>
            ) : (
              nearbyList.map((item) => (
                <div key={item.id} className="p-4 flex items-center justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-900/40">
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {item.type} · {item.meta}
                    </div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mt-0.5">{item.title}</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {item.distanceKm !== null && (
                      <span className="text-xs font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                        {item.distanceKm} km
                      </span>
                    )}
                    <a
                      href={`https://www.openstreetmap.org/directions?from=${centerLat},${centerLng}&to=${item.lat},${item.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
                    >
                      <Navigation className="w-3.5 h-3.5" />
                      Directions
                    </a>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {selectedItem && viewMode === 'map' && (
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{selectedItem.subtitle}</div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">{selectedItem.title}</h4>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                {selectedItem.details.map((d, i) => (
                  <span key={i} className="text-slate-600 dark:text-slate-300">
                    <strong className="font-medium text-slate-800 dark:text-slate-100">{d.label}:</strong> {d.value}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={`https://www.openstreetmap.org/directions?from=${centerLat},${centerLng}&to=${selectedItem.lat},${selectedItem.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-emerald-700 text-white hover:bg-emerald-800"
              >
                <Navigation className="w-3.5 h-3.5" />
                Get Directions
              </a>
              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
