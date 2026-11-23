import React, { useEffect, useState } from 'react';
import { BarChart3, Download } from 'lucide-react';
import { apiFetch } from '../api/client.ts';
import type { AuthUser } from '../types.ts';

interface AnalyticsSummary {
  civic: {
    total: number;
    resolved: number;
    overdue: number;
    overduePct: number;
    byCategory: Record<string, number>;
    byWard: Record<string, number>;
  };
  transit: {
    totalRoutes: number;
    verifiedRoutes: number;
    activeVehicles: number;
    avgReliabilityPct: number;
  };
  waste: {
    totalBins: number;
    normalBins: number;
    nearlyFullBins: number;
    overflowingBins: number;
    collectionCompletionPct: number;
    estimatedCarbonSavedKg: number;
  };
}

export const AnalyticsCenter: React.FC<{ user: AuthUser | null }> = ({ user }) => {
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    apiFetch<AnalyticsSummary>('/api/analytics/summary')
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to load analytics.'));
  }, [user?.id, user]);

  if (!user) {
    return (
      <div className="p-8 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl text-sm text-slate-500">
        Sign in to view your role-scoped analytics.
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 bg-white dark:bg-[#111916] border border-red-200 dark:border-red-900 rounded-xl text-sm text-red-600">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl text-sm text-slate-500">
        Loading real-time database analytics...
      </div>
    );
  }

  const handleDownloadCsv = async () => {
    const csv = await apiFetch<string>('/api/civic/export.csv');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nagar-civic-reports.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const maxCat = Math.max(1, ...Object.values(data.civic.byCategory));
  const categoryEntries = Object.entries(data.civic.byCategory);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-emerald-700 dark:text-emerald-400" />
            {user.role === 'citizen' ? 'My Personal Civic & Sustainability Metrics' : 'City Operations Analytics'}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Strictly calculated from your authorized database records.
          </p>
        </div>

        {(user.role === 'authority' || user.role === 'admin') && (
          <button
            type="button"
            onClick={handleDownloadCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Download CSV Report
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-2">
          <div className="text-xs text-slate-500">
            {user.role === 'citizen' ? 'My Civic Reports' : 'Civic Resolution'}
          </div>
          <div className="text-2xl font-display font-bold tabular-nums">
            {data.civic.resolved} / {data.civic.total} Resolved
          </div>
          <div className="text-xs text-red-600 dark:text-red-400 tabular-nums">
            {data.civic.overdue} overdue ({data.civic.overduePct}%)
          </div>
        </div>

        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-2">
          <div className="text-xs text-slate-500">Transit Network</div>
          <div className="text-2xl font-display font-bold tabular-nums">
            {data.transit.verifiedRoutes} / {data.transit.totalRoutes} Verified Routes
          </div>
          <div className="text-xs text-emerald-700 dark:text-emerald-400 tabular-nums">
            {data.transit.activeVehicles} active vehicles · {data.transit.avgReliabilityPct}% reliability
          </div>
        </div>

        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-2">
          <div className="text-xs text-slate-500">Sanitation &amp; Sustainability</div>
          <div className="text-2xl font-display font-bold tabular-nums">
            {data.waste.collectionCompletionPct}% Pickups Completed
          </div>
          <div className="text-xs text-slate-600 dark:text-slate-400 tabular-nums">
            ~{data.waste.estimatedCarbonSavedKg.toFixed(1)} kg CO2e saved (Estimated)
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-display font-semibold">Complaints by Category</h3>
          {categoryEntries.length === 0 ? (
            <p className="text-xs text-slate-500">No reports submitted yet.</p>
          ) : (
            <div className="space-y-3">
              {categoryEntries.map(([cat, count]) => (
                <div key={cat} className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="font-medium text-slate-800 dark:text-slate-200">{cat}</span>
                    <span className="font-mono tabular-nums">{count}</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div className="h-full bg-emerald-700" style={{ width: `${(count / maxCat) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-display font-semibold">Smart Bin Fill-Level Distribution</h3>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="p-4 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
              <div className="text-xl font-display font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {data.waste.normalBins}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300 mt-1">Normal (&lt;70%)</div>
            </div>
            <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
              <div className="text-xl font-display font-bold tabular-nums text-amber-700 dark:text-amber-400">
                {data.waste.nearlyFullBins}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300 mt-1">Nearly Full</div>
            </div>
            <div className="p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
              <div className="text-xl font-display font-bold tabular-nums text-red-700 dark:text-red-400">
                {data.waste.overflowingBins}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300 mt-1">Overflowing</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
