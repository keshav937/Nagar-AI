import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldAlert,
  HeartPulse,
  Mic,
  MapPin,
  FileText,
  FileWarning,
  Award,
  Bell,
  Bus,
  Trash2,
  Crosshair,
  RefreshCw,
  ArrowRight,
  Users,
} from 'lucide-react';
import type {
  AuthUser,
  CitizenDashboardSummary,
  GeoLocationState,
  LanguageCode,
} from '../types.ts';
import { apiFetch } from '../api/client.ts';
import { t } from '../i18n/translations.ts';

interface CitizenDashboardProps {
  user: AuthUser;
  language: LanguageCode;
  geo: GeoLocationState;
  onRequestGps: () => Promise<GeoLocationState | null>;
  onNavigateTab: (tab: string) => void;
  onOpenSaathi: () => void;
  refreshTrigger?: number;
}

export const CitizenDashboard: React.FC<CitizenDashboardProps> = ({
  user,
  language,
  geo,
  onRequestGps,
  onNavigateTab,
  onOpenSaathi,
  refreshTrigger,
}) => {
  const copy = t(language);
  const [summary, setSummary] = useState<CitizenDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    try {
      const res = await apiFetch<CitizenDashboardSummary>('/api/citizen/dashboard-summary');
      setSummary(res);
    } catch {
      // handled cleanly by fallback zero states
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary, refreshTrigger]);

  return (
    <div className="space-y-6">
      {/* Personalized Citizen Header */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            CITIZEN ACCOUNT · {user.email}
          </div>
          <h1 className="text-2xl font-display font-bold text-slate-950 dark:text-white mt-0.5">
            Welcome, {user.name}
          </h1>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            All complaints, safety sessions, SOS alerts, caregiver links, medical requests, and rewards shown here belong strictly to your personal account.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => onNavigateTab('safety')}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-lg bg-red-600 text-white hover:bg-red-700 cursor-pointer"
          >
            <ShieldAlert className="w-4 h-4" />
            Women Safety &amp; SOS
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab('medical')}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <HeartPulse className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Medical Help
          </button>
          <button
            type="button"
            onClick={onOpenSaathi}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
          >
            <Mic className="w-4 h-4" />
            {copy.saathiName}
          </button>
        </div>
      </div>

      {/* Live GPS Status + Active SOS / Safety Session Banner */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Live Location Status:{' '}
              <span className="font-mono">
                {geo.lat !== null && geo.lng !== null
                  ? `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}${geo.accuracyM ? ` (±${geo.accuracyM}m)` : ''}`
                  : geo.status === 'requesting'
                    ? 'Acquiring browser GPS...'
                    : 'Not Yet Captured'}
              </span>
            </div>
            <div className="text-slate-500 dark:text-slate-400">
              {geo.address || 'Grant browser GPS permission or place a manual pin on the City Map.'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onRequestGps()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 cursor-pointer"
            >
              <Crosshair className="w-3.5 h-3.5" />
              {copy.refreshLocation}
            </button>
            <button
              type="button"
              onClick={loadSummary}
              aria-label="Refresh summary"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div
          className={`lg:col-span-5 border rounded-xl p-5 flex items-center justify-between gap-3 ${
            summary?.safety.activeSos
              ? 'bg-red-50 dark:bg-red-950/40 border-red-300 dark:border-red-800'
              : 'bg-white dark:bg-[#111916] border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="text-xs space-y-1">
            <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
              <Users className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Safety &amp; Caregiver Status
            </div>
            {summary?.safety.activeSos ? (
              <div className="text-red-700 dark:text-red-300 font-semibold font-mono">
                ACTIVE SOS: {summary.safety.activeSos.incident_code} ({summary.safety.activeSos.status})
              </div>
            ) : summary?.safety.activeSession ? (
              <div className="text-emerald-700 dark:text-emerald-400 font-semibold">
                Live Safety Mode ON · {summary.safety.verifiedCaregivers} verified caregiver(s)
              </div>
            ) : (
              <div className="text-slate-500">
                {summary?.safety.verifiedCaregivers ?? 0} active verified caregiver(s) linked
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('safety')}
            className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0 cursor-pointer"
          >
            Manage Safety
          </button>
        </div>
      </div>

      {/* Personal KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <button
          type="button"
          onClick={() => onNavigateTab('civic')}
          className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
        >
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
            My Civic Reports
          </div>
          <div className="mt-1.5 text-2xl font-display font-bold tabular-nums">
            {loading ? '...' : summary?.reports.total ?? 0}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
            {summary?.reports.pending ?? 0} pending · {summary?.reports.resolved ?? 0} resolved
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('grievances')}
          className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
        >
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <FileWarning className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
            Authority Grievances
          </div>
          <div className="mt-1.5 text-2xl font-display font-bold tabular-nums">
            {loading ? '...' : summary?.grievances.total ?? 0}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
            {summary?.grievances.open ?? 0} active investigation
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('medical')}
          className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
        >
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <HeartPulse className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
            Medical Requests
          </div>
          <div className="mt-1.5 text-2xl font-display font-bold tabular-nums">
            {loading ? '...' : summary?.medical.total ?? 0}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
            {summary?.medical.active ?? 0} active response
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('rewards')}
          className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
        >
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <Award className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
            Reward Points
          </div>
          <div className="mt-1.5 text-2xl font-display font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
            {loading ? '...' : summary?.rewards.points ?? 0}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
            {summary?.rewards.badges.length ?? 0} badge(s) earned
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('notifications')}
          className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer"
        >
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            <Bell className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
            Notifications
          </div>
          <div className="mt-1.5 text-2xl font-display font-bold tabular-nums">
            {loading ? '...' : summary?.unreadNotifications ?? 0} Unread
          </div>
          <div className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-400">Open inbox →</div>
        </button>
      </div>

      {/* Quick Service Access Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <button
          type="button"
          onClick={() => onNavigateTab('mobility')}
          className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer flex items-center justify-between"
        >
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <Bus className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Smart Mobility &amp; Routing
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Live road routing, transit stops, and shared commuter feeders
            </p>
          </div>
          <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('waste')}
          className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer flex items-center justify-between"
        >
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <Trash2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Waste &amp; AI Segregation
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Classify waste items, locate bins, and earn segregation points
            </p>
          </div>
          <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('map')}
          className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 transition-colors cursor-pointer flex items-center justify-between"
        >
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Interactive City Map
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Inspect your GPS pin, personal reports, and nearby infrastructure
            </p>
          </div>
          <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
        </button>
      </div>

      {/* Personal Recent Activity Lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
              My Recent Civic Reports
            </h3>
            <button
              type="button"
              onClick={() => onNavigateTab('civic')}
              className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
            >
              Submit / View All →
            </button>
          </div>

          {!summary || summary.reports.recent.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
              {copy.noReportsYet}
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {summary.reports.recent.map((r) => (
                <div key={r.id} className="py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 dark:text-white truncate">{r.title}</div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {r.report_code} · {r.category}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
              Recent Medical &amp; Grievance Requests
            </h3>
            <button
              type="button"
              onClick={() => onNavigateTab('medical')}
              className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
            >
              Open Medical Aid →
            </button>
          </div>

          {(!summary ||
            (summary.medical.recent.length === 0 && summary.grievances.recent.length === 0)) ? (
            <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
              No medical assistance requests or authority grievances submitted yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {summary.medical.recent.map((m) => (
                <div key={m.id} className="py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 dark:text-white truncate">
                      {m.request_type}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {m.request_code} · {m.selected_facility_name || 'Authority Medical Desk'}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] font-semibold text-amber-700 dark:text-amber-400 shrink-0">
                    {m.status}
                  </span>
                </div>
              ))}
              {summary.grievances.recent.map((g) => (
                <div key={g.id} className="py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 dark:text-white truncate">{g.title}</div>
                    <div className="font-mono text-[11px] text-slate-500">{g.grievance_code} · Grievance</div>
                  </div>
                  <span className="font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">
                    {g.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
