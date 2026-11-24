import React, { useState, useEffect, useCallback } from 'react';
import { Award, CheckCircle2, RefreshCw, ShieldCheck, Trophy, Sparkles } from 'lucide-react';
import type { AuthUser, RewardsOverviewData } from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface RewardsModuleProps {
  user: AuthUser | null;
}

export const RewardsModule: React.FC<RewardsModuleProps> = ({ user }) => {
  const [data, setData] = useState<RewardsOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRewards = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await apiFetch<RewardsOverviewData>('/api/rewards/overview');
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load citizen rewards.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadRewards();
  }, [loadRewards]);

  if (!user) {
    return (
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500">
        Sign in as a Citizen to view your verified points, earned civic badges, and city leaderboard.
      </div>
    );
  }

  const points = data?.points ?? 0;
  const nextTier = data?.nextTierPoints ?? 100;
  const progressPct = Math.min(100, Math.round((points / Math.max(1, nextTier)) * 100));

  const tierName =
    points >= 500
      ? 'Civic Champion'
      : points >= 250
        ? 'Urban Steward'
        : points >= 100
          ? 'Active Contributor'
          : 'New Citizen Member';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            VERIFIED CIVIC CONTRIBUTION PROGRAM
          </div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white flex items-center gap-2 mt-0.5">
            <Award className="w-6 h-6 text-emerald-700 dark:text-emerald-400" />
            Citizen Rewards &amp; Recognition
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            Points are awarded strictly from officer-verified civic reports, confirmed issue resolutions, and logged waste segregation milestones.
          </p>
        </div>
        <button
          type="button"
          onClick={loadRewards}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Points
        </button>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Score & Tier Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Total Verified Points</div>
          <div className="mt-1 text-3xl font-display font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
            {loading ? '...' : points}
          </div>
          <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">{tierName}</div>
        </div>

        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Verified Reports</div>
          <div className="mt-1 text-3xl font-display font-bold tabular-nums">
            {data?.verifiedReportsCount ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            +{data?.rewardConfig.verifiedReportPoints ?? 20} pts per verified report
          </div>
        </div>

        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Resolved Reports</div>
          <div className="mt-1 text-3xl font-display font-bold tabular-nums">
            {data?.resolvedReportsCount ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            +{data?.rewardConfig.resolutionConfirmedPoints ?? 30} pts on resolution
          </div>
        </div>

        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Segregation Streak</div>
          <div className="mt-1 text-3xl font-display font-bold tabular-nums">
            {data?.streakDays ?? 0} days
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            {data?.householdsVerified ?? 0} verified logs
          </div>
        </div>
      </div>

      {/* Tier Progress + Earned Badges */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div>
            <div className="flex items-center justify-between text-xs font-semibold mb-2">
              <span>Progress to {nextTier} Points Tier</span>
              <span className="font-mono tabular-nums">
                {points} / {nextTier} pts ({progressPct}%)
              </span>
            </div>
            <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-sm overflow-hidden">
              <div
                className="h-full bg-emerald-700 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          <div className="space-y-2.5">
            <h3 className="text-sm font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Earned Achievement Badges
            </h3>
            {!data || data.badges.length === 0 ? (
              <p className="text-xs text-slate-500 p-4 rounded-lg border border-dashed border-slate-200 dark:border-slate-800">
                No badges earned yet. Submit verifiable civic issues or log household segregation to unlock your first badge.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {data.badges.map((badge) => (
                  <div
                    key={badge}
                    className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 flex items-center gap-2 text-xs font-semibold text-emerald-900 dark:text-emerald-200"
                  >
                    <Sparkles className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
                    <span>{badge}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-display font-bold text-slate-900 dark:text-white">
              Verified Contribution Ledger
            </h3>
            {!data || data.history.length === 0 ? (
              <p className="text-xs text-slate-500">No verified reward entries recorded yet.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-64 overflow-y-auto">
                {data.history.map((item, idx) => (
                  <div key={idx} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                    <div>
                      <div className="font-medium text-slate-900 dark:text-white flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400 shrink-0" />
                        {item.action}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400">
                        {new Date(item.date).toLocaleString()}
                      </div>
                    </div>
                    <span className="font-mono font-bold tabular-nums text-emerald-700 dark:text-emerald-400 shrink-0">
                      +{item.points} pts
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Real Database Citizen Leaderboard */}
        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Trophy className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Active Citizen Leaderboard
            </h3>
            <span className="text-[11px] font-mono text-slate-500">Live Database Ranking</span>
          </div>

          {!data || data.leaderboard.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
              No verified citizen reward points recorded in the database yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 pr-3">Rank</th>
                    <th className="py-2 pr-3">Citizen</th>
                    <th className="py-2 pr-3">Badges</th>
                    <th className="py-2 text-right">Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.leaderboard.map((row, index) => (
                    <tr
                      key={row.user_id}
                      className={row.isCurrentUser ? 'bg-emerald-50/70 dark:bg-emerald-950/30 font-semibold' : ''}
                    >
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-600 dark:text-slate-300">
                        #{index + 1}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-900 dark:text-white">
                        {row.name}
                        {row.isCurrentUser ? ' (You)' : ''}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-500 font-mono tabular-nums">
                        {row.badges.length}
                      </td>
                      <td className="py-2.5 text-right font-mono font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {row.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
