import React, { useState, useMemo } from 'react';
import { Bus, Navigation, Clock, AlertCircle, CheckCircle2, Plus } from 'lucide-react';
import type { AuthUser, GeoLocationState, TransitRoute, TransitVehicle } from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface TransitModuleProps {
  user: AuthUser | null;
  geo: GeoLocationState;
  routes: TransitRoute[];
  vehicles: TransitVehicle[];
  onRefresh: () => void;
  onRequireAuth: () => void;
}

export const TransitModule: React.FC<TransitModuleProps> = ({
  user,
  geo,
  routes,
  vehicles,
  onRefresh,
  onRequireAuth,
}) => {
  const [subTab, setSubTab] = useState<'commuter' | 'submit' | 'driver'>('commuter');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'shared_auto' | 'mini_bus' | 'e_rickshaw'>('all');
  const [msg, setMsg] = useState<string | null>(null);

  // Submit route form
  const [rName, setRName] = useState('');
  const [rOrigin, setROrigin] = useState('');
  const [rDest, setRDest] = useState('');
  const [rCat, setRCat] = useState<'shared_auto' | 'mini_bus' | 'e_rickshaw'>('shared_auto');
  const [rFare, setRFare] = useState('20');

  // Driver update state
  const [selectedVehicleId, setSelectedVehicleId] = useState(vehicles[0]?.id || '');
  const [seatCount, setSeatCount] = useState('2');

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
    setMsg('Delay report logged for commuters and transport authority.');
    onRefresh();
  };

  const handleVerifyRoute = async (routeId: string, status: 'verified' | 'flagged') => {
    await apiFetch(`/api/transit/routes/${routeId}/verify`, {
      method: 'PATCH',
      body: JSON.stringify({ verificationStatus: status }),
    });
    setMsg(`Route marked as ${status}.`);
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
    setMsg('Route submitted to network (pending verification unless submitted by Authority).');
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
    setMsg('Authorized vehicle availability & foreground coordinates updated.');
    onRefresh();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white">
            Smart Informal Public Transport
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Shared autos, e-rickshaws, and mini-bus feeders with verified vs estimated fare transparency.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setSubTab('commuter')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              subTab === 'commuter' ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Route Discovery
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
              Driver & Fleet
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-300">
          {msg}
        </div>
      )}

      {subTab === 'commuter' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={destinationQuery}
              onChange={(e) => setDestinationQuery(e.target.value)}
              placeholder="Search destination (e.g. Connaught Place, Karol Bagh, Lajpat Nagar)..."
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
              No transit routes registered yet. Use Add Route to contribute a shared auto or mini-bus route.
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

                  <div className="text-xs text-slate-600 dark:text-slate-400">
                    <span className="font-medium text-slate-800 dark:text-slate-200">Pickup Stops: </span>
                    {rt.stops.map((s) => `${s.name} (~${s.waitMin}m wait)`).join(' · ')}
                  </div>

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
            Community-submitted routes are clearly labelled as unverified until moderated by the Transport Authority.
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
                Driver & Fleet Live Telemetry
              </h3>
              <p className="text-xs text-slate-500">
                Publish authorized seat counts and foreground GPS coordinates for registered shared vehicles.
              </p>
            </div>
          </div>

          {(user?.role === 'transit_driver' || user?.role === 'authority' || user?.role === 'admin') && vehicles.length > 0 && (
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
                Publish Availability & GPS
              </button>
            </div>
          )}

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
                    <td className="py-2.5 pr-4 text-slate-500">
                      {v.is_simulated ? 'Simulated Demo' : 'Driver Authorized'}
                    </td>
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
        </div>
      )}
    </div>
  );
};
