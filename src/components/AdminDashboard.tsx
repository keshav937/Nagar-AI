import React, { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  UserPlus,
  Users,
  Activity,
  RefreshCw,
  Building2,
  FileWarning,
  HeartPulse,
  Settings,
  Megaphone,
  Copy,
  Check,
  Sliders,
} from 'lucide-react';
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

type AdminTab =
  | 'overview'
  | 'users_officers'
  | 'departments_sla'
  | 'grievances'
  | 'caregivers_medical'
  | 'config_broadcast'
  | 'audit';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ user, departments }) => {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [googleConfig, setGoogleConfig] = useState<{
    configured: boolean;
    redirectUri: string;
    superAdminConfigured: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copiedUri, setCopiedUri] = useState(false);

  // Create officer form
  const [offName, setOffName] = useState('');
  const [offEmail, setOffEmail] = useState('');
  const [offPhone, setOffPhone] = useState('');
  const [offPass, setOffPass] = useState('');
  const [offDept, setOffDept] = useState(departments[0]?.id || 'dept-roads');
  const [offBadge, setOffBadge] = useState('');
  const [offWard, setOffWard] = useState('Central Ward');
  const [createdRecoveryKey, setCreatedRecoveryKey] = useState<{ email: string; key: string } | null>(null);

  // Authorize admin form
  const [admName, setAdmName] = useState('');
  const [admEmail, setAdmEmail] = useState('');
  const [admPass, setAdmPass] = useState('');

  // Department form
  const [deptName, setDeptName] = useState('');
  const [deptCode, setDeptCode] = useState('');
  const [deptSla, setDeptSla] = useState(48);
  const [deptHead, setDeptHead] = useState('');

  // Grievances review drafts
  const [grvNotes, setGrvNotes] = useState<Record<string, string>>({});

  // Config & Broadcast forms
  const [verifiedPts, setVerifiedPts] = useState(20);
  const [resolvedPts, setResolvedPts] = useState(30);
  const [segPts, setSegPts] = useState(25);
  const [maxDailyClaims, setMaxDailyClaims] = useState(10);
  const [sessionTtlHours, setSessionTtlHours] = useState(12);
  const [allowCitizenGoogle, setAllowCitizenGoogle] = useState(true);
  const [allowCaregiverGoogle, setAllowCaregiverGoogle] = useState(true);

  const [bcastRole, setBcastRole] = useState('citizen');
  const [bcastTitle, setBcastTitle] = useState('');
  const [bcastMsg, setBcastMsg] = useState('');

  const loadAdminOverview = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    setLoading(true);
    try {
      const [res, gCfg] = await Promise.all([
        apiFetch<AdminOverviewData>('/api/admin/overview'),
        apiFetch<{ configured: boolean; redirectUri: string; superAdminConfigured: boolean }>('/api/auth/google/config'),
      ]);
      setData(res);
      setGoogleConfig(gCfg);
      setVerifiedPts(res.rewardConfig.verifiedReportPoints);
      setResolvedPts(res.rewardConfig.resolutionConfirmedPoints);
      setSegPts(res.rewardConfig.segregationPoints);
      setMaxDailyClaims(res.rewardConfig.maxDailyClaims);
      setSessionTtlHours(res.securitySettings.sessionTtlHours);
      setAllowCitizenGoogle(res.securitySettings.allowCitizenGoogleSignup);
      setAllowCaregiverGoogle(res.securitySettings.allowCaregiverGoogleSignup);
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
    setBusy(true);
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
          phone: offPhone,
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
      setOffPhone('');
      setOffPass('');
      setOffBadge('');
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create officer account.');
    } finally {
      setBusy(false);
    }
  };

  const handleAuthorizeAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ email: string; recoveryKey: string }>('/api/admin/admins', {
        method: 'POST',
        body: JSON.stringify({ name: admName, email: admEmail, password: admPass || undefined }),
      });
      setCreatedRecoveryKey({ email: res.email, key: res.recoveryKey });
      setFeedback(`Authorized Administrator ${res.email} (can use Password or Google Sign-In).`);
      setAdmName('');
      setAdmEmail('');
      setAdmPass('');
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to authorize admin.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleUserStatus = async (userId: string, nextStatus: 'active' | 'suspended') => {
    setBusy(true);
    try {
      await apiFetch(`/api/admin/users/${userId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus: nextStatus }),
      });
      setFeedback(`User status updated to ${nextStatus}.`);
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update user status.');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch('/api/admin/departments', {
        method: 'POST',
        body: JSON.stringify({ name: deptName, code: deptCode, slaHours: deptSla, headName: deptHead }),
      });
      setDeptName('');
      setDeptCode('');
      setDeptHead('');
      setFeedback('Department added.');
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add department.');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateSlaRule = async (ruleId: string, departmentId: string, slaHours: number, escalationHours: number) => {
    setBusy(true);
    try {
      await apiFetch('/api/admin/sla-rules', {
        method: 'PUT',
        body: JSON.stringify({ rules: [{ id: ruleId, departmentId, slaHours, escalationHours }] }),
      });
      setFeedback('SLA rule updated.');
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update SLA rule.');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateGrievance = async (id: string, status: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/grievances/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          resolutionNotes: grvNotes[id] || `Administration updated grievance status to ${status}.`,
        }),
      });
      setFeedback(`Grievance updated to ${status}. Citizen notified.`);
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update grievance.');
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeCaregiverLink = async (id: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/admin/caregiver-links/${id}/revoke`, { method: 'POST' });
      setFeedback('Caregiver relationship and tokens revoked by Administration.');
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revocation failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveRewardConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch('/api/admin/reward-config', {
        method: 'PUT',
        body: JSON.stringify({
          verifiedReportPoints: verifiedPts,
          resolutionConfirmedPoints: resolvedPts,
          segregationPoints: segPts,
          maxDailyClaims,
        }),
      });
      setFeedback('Reward point configuration saved.');
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save reward config.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSecuritySettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch('/api/admin/security-settings', {
        method: 'PUT',
        body: JSON.stringify({
          sessionTtlHours,
          allowCitizenGoogleSignup: allowCitizenGoogle,
          allowCaregiverGoogleSignup: allowCaregiverGoogle,
        }),
      });
      setFeedback('Security settings saved.');
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save security settings.');
    } finally {
      setBusy(false);
    }
  };

  const handleSendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch<{ sentCount: number }>('/api/admin/notifications/broadcast', {
        method: 'POST',
        body: JSON.stringify({ targetRole: bcastRole, title: bcastTitle, message: bcastMsg }),
      });
      setBcastTitle('');
      setBcastMsg('');
      setFeedback(`Broadcast notification delivered to ${res.sentCount} active user(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Broadcast failed.');
    } finally {
      setBusy(false);
    }
  };

  const copyRedirectUri = async () => {
    if (!googleConfig?.redirectUri) return;
    await navigator.clipboard.writeText(googleConfig.redirectUri);
    setCopiedUri(true);
    setTimeout(() => setCopiedUri(false), 2000);
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
            System oversight, officer &amp; admin provisioning, SLA rules, grievance resolution, caregiver governance, and audit logs.
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

      {/* Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {(
          [
            ['overview', 'Overview & Health'],
            ['users_officers', 'Users & Officers'],
            ['departments_sla', 'Departments & SLA'],
            ['grievances', `Grievances (${data?.openGrievances ?? 0})`],
            ['caregivers_medical', 'Caregivers & Medical'],
            ['config_broadcast', 'Config & Broadcast'],
            ['audit', 'Audit & SMS Logs'],
          ] as Array<[AdminTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-3.5 py-2 rounded-lg font-semibold cursor-pointer ${
              tab === id
                ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                : 'bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
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

      {/* TAB 1: Overview & Integration Health */}
      {tab === 'overview' && (
        <div className="space-y-6">
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
              <div className="text-xs text-slate-500">Civic Reports / Grievances</div>
              <div className="mt-1 text-2xl font-display font-bold tabular-nums">
                {data?.totalReports ?? 0} / {data?.totalGrievances ?? 0}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {data?.openGrievances ?? 0} open admin grievance(s)
              </div>
            </div>
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
              <div className="text-xs text-slate-500">Active SOS / Medical</div>
              <div className="mt-1 text-2xl font-display font-bold tabular-nums text-red-600 dark:text-red-400">
                {data?.activeSosCount ?? 0} / {data?.activeMedicalRequests ?? 0}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {data?.totalMedicalRequests ?? 0} total medical requests
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3 text-xs">
            <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
              Server Integration &amp; OAuth Configuration Health
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">Gemini AI</div>
                <div className="font-mono font-bold mt-0.5">
                  {data?.geminiConfigured ? 'Configured' : 'Missing GEMINI_API_KEY'}
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">ElevenLabs Voice AI</div>
                <div className="font-mono font-bold mt-0.5">
                  {data?.elevenLabsConfigured ? 'Configured' : 'Missing ELEVENLABS_API_KEY'}
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">SMS / WhatsApp ({data?.messagingProvider.providerName || 'Gateway'})</div>
                <div className="font-mono font-bold mt-0.5">
                  SMS: {data?.messagingProvider.smsConfigured ? 'Ready' : 'Not Configured'} · WA:{' '}
                  {data?.messagingProvider.whatsappConfigured ? 'Ready' : 'Not Configured'}
                </div>
              </div>
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-slate-500">Google OAuth 2.0</div>
                <div className="font-mono font-bold mt-0.5">
                  {googleConfig?.configured ? 'Enabled' : 'Unconfigured (Secrets needed)'}
                </div>
              </div>
            </div>

            {googleConfig?.redirectUri && (
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold">Google OAuth Authorized Redirect URI:</span>{' '}
                  <code className="font-mono text-[11px]">{googleConfig.redirectUri}</code>
                </div>
                <button
                  type="button"
                  onClick={copyRedirectUri}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
                >
                  {copiedUri ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copiedUri ? 'Copied' : 'Copy URI'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Users & Officer Provisioning */}
      {tab === 'users_officers' && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <h3 className="text-base font-display font-bold flex items-center gap-2">
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
                type="tel"
                value={offPhone}
                onChange={(e) => setOffPhone(e.target.value)}
                placeholder="Official Phone (optional)"
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
              <div className="flex gap-2">
                <input
                  type="text"
                  required
                  value={offBadge}
                  onChange={(e) => setOffBadge(e.target.value)}
                  placeholder="Badge (RDS-104)"
                  className="w-32 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
                <input
                  type="text"
                  value={offWard}
                  onChange={(e) => setOffWard(e.target.value)}
                  placeholder="Ward"
                  className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer shrink-0"
                >
                  Create Officer
                </button>
              </div>
            </form>

            <form onSubmit={handleAuthorizeAdmin} className="pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-4 gap-3">
              <input
                type="text"
                required
                value={admName}
                onChange={(e) => setAdmName(e.target.value)}
                placeholder="Admin Name"
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <input
                type="email"
                required
                value={admEmail}
                onChange={(e) => setAdmEmail(e.target.value)}
                placeholder="Admin Email (Password or Google Sign-In)"
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <input
                type="password"
                value={admPass}
                onChange={(e) => setAdmPass(e.target.value)}
                placeholder="Password (optional for Google OAuth)"
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 cursor-pointer"
              >
                Authorize Admin Account
              </button>
            </form>

            {createdRecoveryKey && (
              <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs">
                Account Recovery Key for <strong>{createdRecoveryKey.email}</strong>:{' '}
                <code className="font-mono font-bold">{createdRecoveryKey.key}</code>
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
            <h3 className="text-base font-display font-bold flex items-center gap-2">
              <Users className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Registered Platform Accounts ({data?.recentUsers.length ?? 0})
            </h3>
            {loading ? (
              <p className="text-xs text-slate-500">Loading users...</p>
            ) : !data || data.recentUsers.length === 0 ? (
              <p className="text-xs text-slate-500">No users registered yet.</p>
            ) : (
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 pr-3">Name</th>
                      <th className="py-2 pr-3">Email</th>
                      <th className="py-2 pr-3">Role</th>
                      <th className="py-2 pr-3">Provider</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {data.recentUsers.map((u) => (
                      <tr key={u.id}>
                        <td className="py-2 pr-3 font-medium">{u.name}</td>
                        <td className="py-2 pr-3 font-mono text-[11px]">{u.email}</td>
                        <td className="py-2 pr-3 uppercase font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                          {u.role}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px]">{u.auth_provider || 'local'}</td>
                        <td className="py-2 pr-3 font-mono text-[11px]">{u.account_status}</td>
                        <td className="py-2 text-right">
                          {u.id !== user.id && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                handleToggleUserStatus(u.id, u.account_status === 'active' ? 'suspended' : 'active')
                              }
                              className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-[11px] font-semibold cursor-pointer"
                            >
                              {u.account_status === 'active' ? 'Suspend' : 'Activate'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Departments & SLA Rules */}
      {tab === 'departments_sla' && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <h3 className="text-base font-display font-bold flex items-center gap-2">
              <Building2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Municipal Departments ({data?.departments.length ?? 0})
            </h3>
            <form onSubmit={handleCreateDepartment} className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
              <input
                type="text"
                required
                value={deptName}
                onChange={(e) => setDeptName(e.target.value)}
                placeholder="Department Name"
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <input
                type="text"
                required
                value={deptCode}
                onChange={(e) => setDeptCode(e.target.value)}
                placeholder="Code (e.g. PARKS)"
                className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <input
                type="text"
                value={deptHead}
                onChange={(e) => setDeptHead(e.target.value)}
                placeholder="Department Head"
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <div className="flex gap-2">
                <input
                  type="number"
                  min={4}
                  max={720}
                  value={deptSla}
                  onChange={(e) => setDeptSla(Number(e.target.value))}
                  className="w-20 px-2.5 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white cursor-pointer"
                >
                  Add Dept
                </button>
              </div>
            </form>

            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {(data?.departments || []).map((d) => (
                <div key={d.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="font-semibold">{d.name}</span>{' '}
                    <span className="font-mono text-slate-500">({d.code})</span> · Head: {d.head_name}
                  </div>
                  <span className="font-mono">Default SLA: {d.sla_hours}h</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
            <h3 className="text-base font-display font-bold flex items-center gap-2">
              <Sliders className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Category SLA &amp; Escalation Rules
            </h3>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {(data?.slaRules || []).map((rule) => (
                <div key={rule.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold">{rule.category}</div>
                    <div className="text-[11px] text-slate-500">{rule.department_name}</div>
                  </div>
                  <div className="flex items-center gap-2 font-mono">
                    <span>SLA {rule.sla_hours}h / Escalate {rule.escalation_hours}h</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleUpdateSlaRule(rule.id, rule.department_id, 24, 12)}
                      className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
                    >
                      Set 24h Priority
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Authority Grievances Investigation */}
      {tab === 'grievances' && (
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-display font-bold flex items-center gap-2">
            <FileWarning className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Citizen Grievances Investigation Queue ({data?.grievances.length ?? 0})
          </h3>
          {!data || data.grievances.length === 0 ? (
            <p className="text-xs text-slate-500">No authority grievances submitted yet.</p>
          ) : (
            <div className="space-y-4">
              {data.grievances.map((g) => (
                <div
                  key={g.id}
                  className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3 text-xs"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-mono font-bold text-amber-700 dark:text-amber-400">
                        {g.grievance_code} · {g.category}
                      </div>
                      <div className="text-sm font-bold text-slate-900 dark:text-white mt-0.5">{g.title}</div>
                      <div className="text-slate-500">
                        Citizen: {g.citizen_name} ({g.citizen_email}) · Dept: {g.department_name || 'General'}
                      </div>
                    </div>
                    <span className="font-mono font-bold">{g.status}</span>
                  </div>
                  <p className="text-slate-700 dark:text-slate-300">{g.description}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={grvNotes[g.id] ?? g.resolution_notes ?? ''}
                      onChange={(e) => setGrvNotes((p) => ({ ...p, [g.id]: e.target.value }))}
                      placeholder="Admin investigation & resolution notes..."
                      className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    {['Under Review', 'Investigating', 'Resolved', 'Dismissed'].map((st) => (
                      <button
                        key={st}
                        type="button"
                        disabled={busy}
                        onClick={() => handleUpdateGrievance(g.id, st)}
                        className={`px-3 py-1.5 rounded-lg font-semibold cursor-pointer ${
                          st === 'Resolved'
                            ? 'bg-emerald-700 text-white'
                            : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 5: Caregiver Oversight & Medical Monitor */}
      {tab === 'caregivers_medical' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
            <h3 className="text-base font-display font-bold">Caregiver Relationships Oversight</h3>
            {!data || data.caregiverLinks.length === 0 ? (
              <p className="text-xs text-slate-500">No caregiver relationships recorded yet.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs max-h-96 overflow-y-auto">
                {data.caregiverLinks.map((cl) => (
                  <div key={cl.id} className="py-2.5 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold">
                        {cl.citizen_name} → {cl.caregiver_name} ({cl.caregiver_phone})
                      </div>
                      <div className="font-mono text-[11px] text-slate-500">Status: {cl.status}</div>
                    </div>
                    {cl.status !== 'revoked' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleRevokeCaregiverLink(cl.id)}
                        className="px-2.5 py-1 rounded border border-red-300 text-red-600 font-semibold cursor-pointer"
                      >
                        Force Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
            <h3 className="text-base font-display font-bold flex items-center gap-2">
              <HeartPulse className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Medical Assistance Monitor ({data?.medicalRequests.length ?? 0})
            </h3>
            {!data || data.medicalRequests.length === 0 ? (
              <p className="text-xs text-slate-500">No medical requests logged yet.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs max-h-96 overflow-y-auto">
                {data.medicalRequests.map((m) => (
                  <div key={m.id} className="py-2.5 flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                        {m.request_code} · {m.urgency.toUpperCase()}
                      </div>
                      <div className="font-semibold">
                        {m.request_type} — {m.citizen_name}
                      </div>
                      <div className="text-slate-500">{m.selected_facility_name || m.address}</div>
                    </div>
                    <span className="font-mono font-bold">{m.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 6: Reward Config, Security Settings & Broadcast */}
      {tab === 'config_broadcast' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form
            onSubmit={handleSaveRewardConfig}
            className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-display font-bold flex items-center gap-2">
              <Settings className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Reward Points Rules
            </h3>
            <div>
              <label className="block text-slate-500 mb-1">Verified Report Points</label>
              <input
                type="number"
                value={verifiedPts}
                onChange={(e) => setVerifiedPts(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Confirmed Resolution Points</label>
              <input
                type="number"
                value={resolvedPts}
                onChange={(e) => setResolvedPts(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Waste Segregation Points</label>
              <input
                type="number"
                value={segPts}
                onChange={(e) => setSegPts(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Max Daily Claims</label>
              <input
                type="number"
                value={maxDailyClaims}
                onChange={(e) => setMaxDailyClaims(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2 rounded-lg bg-emerald-700 text-white font-semibold cursor-pointer"
            >
              Save Reward Config
            </button>
          </form>

          <form
            onSubmit={handleSaveSecuritySettings}
            className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-display font-bold flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Authentication &amp; Session Policy
            </h3>
            <div>
              <label className="block text-slate-500 mb-1">Session TTL (Hours)</label>
              <input
                type="number"
                min={1}
                max={168}
                value={sessionTtlHours}
                onChange={(e) => setSessionTtlHours(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowCitizenGoogle}
                onChange={(e) => setAllowCitizenGoogle(e.target.checked)}
                className="accent-emerald-700"
              />
              <span>Allow Citizen Google Sign-Up</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowCaregiverGoogle}
                onChange={(e) => setAllowCaregiverGoogle(e.target.checked)}
                className="accent-emerald-700"
              />
              <span>Allow Caregiver Google Sign-Up</span>
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold cursor-pointer"
            >
              Save Security Policy
            </button>
          </form>

          <form
            onSubmit={handleSendBroadcast}
            className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-display font-bold flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              System Broadcast Notification
            </h3>
            <div>
              <label className="block text-slate-500 mb-1">Target Role</label>
              <select
                value={bcastRole}
                onChange={(e) => setBcastRole(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="citizen">All Citizens</option>
                <option value="authority">All Authority Officers</option>
                <option value="caregiver">All Caregivers</option>
                <option value="all">All Active Accounts</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Notice Title</label>
              <input
                type="text"
                required
                value={bcastTitle}
                onChange={(e) => setBcastTitle(e.target.value)}
                placeholder="Municipal / Safety Notice"
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Message</label>
              <textarea
                required
                rows={3}
                value={bcastMsg}
                onChange={(e) => setBcastMsg(e.target.value)}
                placeholder="Enter real announcement..."
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2 rounded-lg bg-emerald-700 text-white font-semibold cursor-pointer"
            >
              Send Broadcast
            </button>
          </form>
        </div>
      )}

      {/* TAB 7: Security Audit & SMS Logs */}
      {tab === 'audit' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
            <h3 className="text-base font-display font-bold flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Security &amp; Operations Audit Log
            </h3>
            {!data || data.auditLogs.length === 0 ? (
              <p className="text-xs text-slate-500">No audit log entries recorded yet.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
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
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
            <h3 className="text-base font-display font-bold">SMS &amp; WhatsApp Delivery Logs</h3>
            {!data || data.smsLogs.length === 0 ? (
              <p className="text-xs text-slate-500">No caregiver messaging logs recorded yet.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto text-xs">
                {data.smsLogs.map((s) => (
                  <div key={s.id} className="py-2.5 flex items-start justify-between gap-3">
                    <div>
                      <div className="font-mono font-semibold">{s.event_type}</div>
                      <div className="text-[11px] text-slate-500">
                        {s.caregiver_phone} · SMS: {s.sms_status} · WA: {s.whatsapp_status}
                      </div>
                      {s.sms_error && <div className="text-[11px] text-red-500">{s.sms_error}</div>}
                    </div>
                    <span className="font-mono text-[11px] text-slate-400 shrink-0">
                      {new Date(s.created_at).toLocaleString()}
                    </span>
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
