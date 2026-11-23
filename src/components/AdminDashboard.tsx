import React, { useState, useEffect, useCallback } from 'react';
import { Shield, UserPlus, Users, FileText, Activity, RefreshCw } from 'lucide-react';
import type { AdminOverviewData, AuthUser } from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface Department {
  id: string;
  name: string;
  code: string;
}

interface AdminDashboardProps {
  user: AuthUser | null;
  departments: Department[];
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ user, departments }) => {
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Create officer form
  const [offName, setOffName] = useState('');
  const [offEmail, setOffEmail] = useState('');
  const [offPass, setOffPass] = useState('');
  const [offDept, setOffDept] = useState(departments[0]?.id || 'dept-roads');
  const [offBadge, setOffBadge] = useState('');
  const [offWard, setOffWard] = useState('Central Ward');
  const [createdRecoveryKey, setCreatedRecoveryKey] = useState<{ email: string; key: string } | null>(null);

  const loadAdminOverview = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    setLoading(true);
    try {
      const res = await apiFetch<AdminOverviewData>('/api/admin/overview');
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load admin overview.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadAdminOverview();
  }, [loadAdminOverview]);

  if (!user || user.role !== 'admin') {
    return (
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-600 dark:text-slate-400">
        Administrator Console is strictly restricted to authenticated System Administrators.
      </div>
    );
  }

  const handleCreateOfficer = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    setCreatedRecoveryKey(null);
    try {
      const res = await apiFetch<{
        userId: string;
        officerId: string;
        name: string;
        email: string;
        badgeNo: string;
        recoveryKey: string;
      }>('/api/admin/officers', {
        method: 'POST',
        body: JSON.stringify({
          name: offName,
          email: offEmail,
          password: offPass,
          departmentId: offDept,
          badgeNo: offBadge,
          ward: offWard,
        }),
      });
      setCreatedRecoveryKey({ email: res.email, key: res.recoveryKey });
      setFeedback(`Provisioned Authority Officer ${res.name} (${res.badgeNo}).`);
      setOffName('');
      setOffEmail('');
      setOffPass('');
      setOffBadge('');
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create officer account.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            REAL-TIME DATABASE GOVERNANCE
          </div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white flex items-center gap-2 mt-0.5">
            <Shield className="w-6 h-6 text-emerald-700 dark:text-emerald-400" />
            Administrator Control Center
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Live database user counts, officer provisioning, report status metrics, and immutable audit logs.
          </p>
        </div>
        <button
          type="button"
          onClick={loadAdminOverview}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Stats
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {feedback && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-300">
          {feedback}
        </div>
      )}

      {/* Real Database KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Registered Accounts</div>
          <div className="mt-1 text-2xl font-display font-bold tabular-nums">{data?.totalUsers ?? 0}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {(data?.usersByRole || []).map((r) => `${r.role}: ${r.count}`).join(' · ') || 'No users yet'}
          </div>
        </div>
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Provisioned Officers</div>
          <div className="mt-1 text-2xl font-display font-bold tabular-nums">{data?.totalOfficers ?? 0}</div>
          <div className="mt-1 text-[11px] text-slate-500">Department-scoped access</div>
        </div>
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Civic Reports in DB</div>
          <div className="mt-1 text-2xl font-display font-bold tabular-nums">{data?.totalReports ?? 0}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {(data?.reportsByStatus || []).map((s) => `${s.status}: ${s.count}`).join(' · ') || 'None'}
          </div>
        </div>
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500">Active SOS Incidents</div>
          <div className="mt-1 text-2xl font-display font-bold tabular-nums text-red-600 dark:text-red-400">
            {data?.activeSosCount ?? 0}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Gemini: {data?.geminiConfigured ? 'Ready' : 'Unconfigured'} · SMS:{' '}
            {data?.messagingProvider.twilioSmsConfigured ? 'Ready' : 'Unconfigured'}
          </div>
        </div>
      </div>

      {/* Provision Authority Officer */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <h3 className="text-base font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
          Provision Authority / Department Officer Account
        </h3>

        <form onSubmit={handleCreateOfficer} className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            type="text"
            required
            value={offName}
            onChange={(e) => setOffName(e.target.value)}
            placeholder="Officer Full Name"
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          />
          <input
            type="email"
            required
            value={offEmail}
            onChange={(e) => setOffEmail(e.target.value)}
            placeholder="Official Email (e.g. officer@nagar.gov.in)"
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          />
          <input
            type="password"
            required
            minLength={6}
            value={offPass}
            onChange={(e) => setOffPass(e.target.value)}
            placeholder="Initial Password (6+ chars)"
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          />
          <select
            value={offDept}
            onChange={(e) => setOffDept(e.target.value)}
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code})
              </option>
            ))}
          </select>
          <input
            type="text"
            required
            value={offBadge}
            onChange={(e) => setOffBadge(e.target.value)}
            placeholder="Badge Number (e.g. RDS-104)"
            className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={offWard}
              onChange={(e) => setOffWard(e.target.value)}
              placeholder="Assigned Ward"
              className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer shrink-0"
            >
              Create Officer
            </button>
          </div>
        </form>

        {createdRecoveryKey && (
          <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs">
            Officer Recovery Key for <strong>{createdRecoveryKey.email}</strong>:{' '}
            <code className="font-mono font-bold">{createdRecoveryKey.key}</code> (share securely for password recovery).
          </div>
        )}
      </div>

      {/* Registered Users & Audit Log Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
          <h3 className="text-base font-display font-bold flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Registered Platform Users
          </h3>
          {loading ? (
            <p className="text-xs text-slate-500">Loading users...</p>
          ) : !data || data.recentUsers.length === 0 ? (
            <p className="text-xs text-slate-500">No users registered yet.</p>
          ) : (
            <div className="overflow-x-auto max-h-80">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">Email</th>
                    <th className="py-2 pr-3">Role</th>
                    <th className="py-2 text-right">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.recentUsers.map((u) => (
                    <tr key={u.id}>
                      <td className="py-2 pr-3 font-medium text-slate-900 dark:text-white">{u.name}</td>
                      <td className="py-2 pr-3 font-mono text-[11px]">{u.email}</td>
                      <td className="py-2 pr-3 uppercase font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                        {u.role}
                      </td>
                      <td className="py-2 text-right font-mono text-[11px] text-slate-400">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
          <h3 className="text-base font-display font-bold flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Security &amp; Operations Audit Log
          </h3>
          {loading ? (
            <p className="text-xs text-slate-500">Loading audit logs...</p>
          ) : !data || data.auditLogs.length === 0 ? (
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              No audit log entries recorded yet.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto">
              {data.auditLogs.map((log) => (
                <div key={log.id} className="py-2.5 text-xs flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white">
                      {log.action} · {log.actor_role}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Target: {log.target_type} ({log.target_id})
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-slate-400 shrink-0">
                    {new Date(log.created_at).toLocaleTimeString()}
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
