import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LayoutDashboard,
  FileText,
  Sparkles,
  ShieldAlert,
  HeartPulse,
  UserCheck,
  Zap,
  CheckSquare,
  FileWarning,
  Building2,
  Trophy,
  AlertTriangle,
  Bell,
  BarChart3,
  Shield,
  RefreshCw,
  Download,
  PhoneCall,
  MapPin,
  Upload,
  CheckCircle2,
  XCircle,
  Search,
} from 'lucide-react';
import type {
  AuthUser,
  AuthorityGrievance,
  AuthorityOverviewData,
  AuthorityPerformanceData,
  AuthoritySosIncident,
  CivicReport,
  MedicalRequest,
  NotificationItem,
  PublicFacility,
} from '../types.ts';
import { apiFetch } from '../api/client.ts';
import { AnalyticsCenter } from './AnalyticsCenter.tsx';

export type AuthorityModuleId =
  | 'overview'
  | 'reports'
  | 'ai_verify'
  | 'sos'
  | 'medical'
  | 'assignment'
  | 'action_center'
  | 'resolution'
  | 'grievances'
  | 'departments'
  | 'leaderboard'
  | 'escalations'
  | 'notifications'
  | 'analytics'
  | 'security';

interface DepartmentItem {
  id: string;
  name: string;
  code: string;
  sla_hours: number;
  head_name: string;
}

interface OfficerItem {
  id: string;
  department_id: string;
  department_name: string;
  name: string;
  badge_no: string;
  ward: string;
}

interface AuthorityPortalProps {
  user: AuthUser | null;
  reports: CivicReport[];
  departments: DepartmentItem[];
  officers: OfficerItem[];
  notifications: NotificationItem[];
  onRefreshCityData: () => void;
  refreshTrigger?: number;
}

const MODULES: Array<{ id: AuthorityModuleId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: '1. Overview Dashboard', icon: LayoutDashboard },
  { id: 'reports', label: '2. All Civic Reports', icon: FileText },
  { id: 'ai_verify', label: '3. AI Verification', icon: Sparkles },
  { id: 'sos', label: '4. SOS Alerts', icon: ShieldAlert },
  { id: 'medical', label: '5. Medical Help', icon: HeartPulse },
  { id: 'assignment', label: '6. Officer Assignment', icon: UserCheck },
  { id: 'action_center', label: '7. Action Center', icon: Zap },
  { id: 'resolution', label: '8. Resolution & Proof', icon: CheckSquare },
  { id: 'grievances', label: '9. Citizen Grievances', icon: FileWarning },
  { id: 'departments', label: '10. Dept Performance', icon: Building2 },
  { id: 'leaderboard', label: '11. Officer Leaderboard', icon: Trophy },
  { id: 'escalations', label: '12. SLA Escalations', icon: AlertTriangle },
  { id: 'notifications', label: '13. Notifications', icon: Bell },
  { id: 'analytics', label: '14. Analytics & Charts', icon: BarChart3 },
  { id: 'security', label: '15. Security, Audit & SMS', icon: Shield },
];

export const AuthorityPortal: React.FC<AuthorityPortalProps> = ({
  user,
  reports,
  departments,
  officers,
  notifications,
  onRefreshCityData,
  refreshTrigger,
}) => {
  const [activeMod, setActiveMod] = useState<AuthorityModuleId>('overview');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [overview, setOverview] = useState<AuthorityOverviewData | null>(null);
  const [sosList, setSosList] = useState<AuthoritySosIncident[]>([]);
  const [medicalList, setMedicalList] = useState<MedicalRequest[]>([]);
  const [grievances, setGrievances] = useState<AuthorityGrievance[]>([]);
  const [performance, setPerformance] = useState<AuthorityPerformanceData | null>(null);
  const [escalations, setEscalations] = useState<CivicReport[]>([]);
  const [securityAudit, setSecurityAudit] = useState<{
    auditLogs: Array<{
      id: string;
      actor_id: string;
      actor_role: string;
      action: string;
      target_type: string;
      target_id: string;
      created_at: string;
    }>;
    smsLogs: Array<{
      id: string;
      event_type: string;
      caregiver_phone: string;
      sms_status: string;
      whatsapp_status: string;
      created_at: string;
    }>;
    messagingProvider: { smsConfigured: boolean; whatsappConfigured: boolean; providerName: string };
  } | null>(null);

  // Module 2 filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sortBy, setSortBy] = useState<'newest' | 'emergency' | 'sla'>('newest');
  const [page, setPage] = useState(1);
  const pageSize = 8;

  // Module 4/5 notes drafts
  const [sosNotesDraft, setSosNotesDraft] = useState<Record<string, string>>({});
  const [medNotesDraft, setMedNotesDraft] = useState<Record<string, string>>({});
  const [nearbyFacilitiesMap, setNearbyFacilitiesMap] = useState<Record<string, PublicFacility[]>>({});

  // Module 6/8 report editing drafts
  const [assignOfficerDraft, setAssignOfficerDraft] = useState<Record<string, string>>({});
  const [assignDeptDraft, setAssignDeptDraft] = useState<Record<string, string>>({});
  const [resReportId, setResReportId] = useState<string>('');
  const [resNotes, setResNotes] = useState('');
  const [beforePhotos, setBeforePhotos] = useState<string[]>([]);
  const [afterPhotos, setAfterPhotos] = useState<string[]>([]);

  const loadAuthorityData = useCallback(async () => {
    if (!user || !['authority', 'admin'].includes(user.role)) return;
    try {
      const [ov, sos, med, grv, perf, esc, sec] = await Promise.all([
        apiFetch<AuthorityOverviewData>('/api/authority/overview'),
        apiFetch<{ incidents: AuthoritySosIncident[] }>('/api/authority/sos'),
        apiFetch<{ requests: MedicalRequest[] }>('/api/authority/medical'),
        apiFetch<{ grievances: AuthorityGrievance[] }>('/api/grievances'),
        apiFetch<AuthorityPerformanceData>('/api/authority/performance'),
        apiFetch<{ escalations: CivicReport[] }>('/api/authority/escalations'),
        apiFetch<typeof securityAudit>('/api/authority/security-audit'),
      ]);
      setOverview(ov);
      setSosList(sos.incidents || []);
      setMedicalList(med.requests || []);
      setGrievances(grv.grievances || []);
      setPerformance(perf);
      setEscalations(esc.escalations || []);
      setSecurityAudit(sec);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Unable to refresh authority data.' });
    }
  }, [user]);

  useEffect(() => {
    loadAuthorityData();
  }, [loadAuthorityData, refreshTrigger]);

  const filteredReports = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const list = reports.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (q) {
        const hay = `${r.report_code} ${r.title} ${r.category} ${r.address} ${r.ward}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (sortBy === 'emergency') {
      list.sort((a, b) => (b.is_emergency || 0) - (a.is_emergency || 0));
    } else if (sortBy === 'sla') {
      list.sort((a, b) => new Date(a.sla_deadline).getTime() - new Date(b.sla_deadline).getTime());
    }
    return list;
  }, [reports, searchTerm, statusFilter, categoryFilter, sortBy]);

  const paginatedReports = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredReports.slice(start, start + pageSize);
  }, [filteredReports, page]);

  const prioritizedQueue = useMemo(() => {
    return reports
      .filter((r) => !['Resolved', 'Rejected'].includes(r.status))
      .sort((a, b) => {
        const emergDiff = (b.is_emergency || 0) - (a.is_emergency || 0);
        if (emergDiff !== 0) return emergDiff;
        return new Date(a.sla_deadline).getTime() - new Date(b.sla_deadline).getTime();
      });
  }, [reports]);

  if (!user || !['authority', 'admin'].includes(user.role)) {
    return (
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-600 dark:text-slate-400">
        Authority Operations Portal is restricted to authenticated Authority Officers and Administrators.
      </div>
    );
  }

  const refreshAll = async () => {
    onRefreshCityData();
    await loadAuthorityData();
  };

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

  const handleManageReport = async (
    reportId: string,
    payload: {
      status?: string;
      officerId?: string;
      departmentId?: string;
      comment?: string;
      resolutionNotes?: string;
      beforePhotoUrls?: string[];
      resolutionEvidenceUrls?: string[];
    }
  ) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; status: string; awardedPoints?: number }>(
        `/api/civic/reports/${reportId}/manage`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }
      );
      setFeedback({
        type: 'ok',
        text: `Report updated → ${res.status}.${res.awardedPoints ? ` Citizen awarded +${res.awardedPoints} verified points.` : ''}`,
      });
      await refreshAll();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Update failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRunAiVerify = async (reportId: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/ai/civic/verify-report/${reportId}`, { method: 'POST' });
      setFeedback({ type: 'ok', text: 'AI verification assessment stored on complaint.' });
      await refreshAll();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'AI verification unavailable.' });
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateSos = async (id: string, status: 'acknowledged' | 'resolved' | 'cancelled') => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/authority/sos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          responseNotes: sosNotesDraft[id] || `Officer ${user.name} marked SOS as ${status}.`,
        }),
      });
      setFeedback({ type: 'ok', text: `SOS incident updated → ${status.toUpperCase()}. Citizen & caregivers notified.` });
      await refreshAll();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to update SOS.' });
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateMedical = async (
    id: string,
    status: 'Acknowledged' | 'Dispatched' | 'Coordinated' | 'Resolved'
  ) => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/authority/medical/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          responderNotes: medNotesDraft[id] || `Medical desk status set to ${status} by ${user.name}.`,
        }),
      });
      setFeedback({ type: 'ok', text: `Medical assistance request updated → ${status}. Citizen notified.` });
      await refreshAll();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to update medical request.' });
    } finally {
      setBusy(false);
    }
  };

  const handleLookupIncidentHospitals = async (reqItem: MedicalRequest) => {
    try {
      const res = await apiFetch<{ facilities: PublicFacility[] }>(
        `/api/places/nearby?lat=${reqItem.lat}&lng=${reqItem.lng}&radiusKm=5&category=hospital`
      );
      setNearbyFacilitiesMap((prev) => ({ ...prev, [reqItem.id]: res.facilities || [] }));
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Hospital lookup failed.' });
    }
  };

  const handleUploadProofPhoto = async (
    e: React.ChangeEvent<HTMLInputElement>,
    target: 'before' | 'after'
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch<{ dataUrl: string }>('/api/uploads/evidence', {
        method: 'POST',
        body: formData,
      });
      if (target === 'before') setBeforePhotos((p) => [...p, res.dataUrl].slice(0, 4));
      else setAfterPhotos((p) => [...p, res.dataUrl].slice(0, 4));
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Photo upload failed.' });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const handleSubmitResolutionProof = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resReportId) {
      setFeedback({ type: 'err', text: 'Select a civic report first.' });
      return;
    }
    await handleManageReport(resReportId, {
      status: 'Resolved',
      resolutionNotes: resNotes || 'Verified field resolution completed.',
      beforePhotoUrls: beforePhotos,
      resolutionEvidenceUrls: afterPhotos,
      comment: resNotes || 'Resolved with photographic proof.',
    });
    setResNotes('');
    setBeforePhotos([]);
    setAfterPhotos([]);
  };

  const handleRunEscalationScan = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{ escalatedCount: number }>('/api/authority/escalations/scan', {
        method: 'POST',
      });
      setFeedback({
        type: 'ok',
        text: `SLA Escalation scan complete: ${res.escalatedCount} overdue report(s) escalated.`,
      });
      await refreshAll();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Escalation scan failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleMarkAllNotificationsRead = async () => {
    await apiFetch('/api/notifications/mark-all-read', { method: 'POST' });
    onRefreshCityData();
  };

  const uniqueCategories = Array.from(new Set(reports.map((r) => r.category)));

  return (
    <div className="space-y-6">
      {/* Authority Header */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            MUNICIPAL AUTHORITY OPERATIONS · {user.departmentId || 'ALL DEPARTMENTS'}
          </div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white mt-0.5">
            Authority &amp; Officer Command Portal
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Authenticated Responder: {user.name} ({user.email}) · 15-Module Civic, SOS, Medical &amp; SLA Command
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDownloadCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={refreshAll}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Sync All Feeds
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-lg border text-xs ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* 15-Module Sidebar + Active Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <aside className="lg:col-span-3 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-2 space-y-1">
          {MODULES.map((m) => {
            const Icon = m.icon;
            const active = activeMod === m.id;
            const badgeCount =
              m.id === 'sos'
                ? overview?.metrics.activeSosCount
                : m.id === 'medical'
                  ? overview?.metrics.activeMedicalCount
                  : m.id === 'escalations'
                    ? overview?.metrics.overdueCount
                    : undefined;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setActiveMod(m.id)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded-lg text-left transition-colors cursor-pointer ${
                  active
                    ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{m.label}</span>
                </span>
                {badgeCount !== undefined && badgeCount > 0 && (
                  <span className="font-mono text-[11px] font-bold text-red-500">{badgeCount}</span>
                )}
              </button>
            );
          })}
        </aside>

        <section className="lg:col-span-9 space-y-6">
          {/* MODULE 1: Overview Dashboard */}
          {activeMod === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { label: 'Pending / Review', val: overview?.metrics.pendingCount ?? 0, tone: 'text-amber-600' },
                  { label: 'Verified', val: overview?.metrics.verifiedCount ?? 0, tone: 'text-emerald-700 dark:text-emerald-400' },
                  { label: 'In Progress', val: overview?.metrics.assignedInProgressCount ?? 0, tone: 'text-slate-900 dark:text-white' },
                  { label: 'Resolved', val: overview?.metrics.resolvedCount ?? 0, tone: 'text-emerald-700 dark:text-emerald-400' },
                  { label: 'Overdue SLA', val: overview?.metrics.overdueCount ?? 0, tone: 'text-red-600 dark:text-red-400' },
                ].map((kpi) => (
                  <div
                    key={kpi.label}
                    className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-4"
                  >
                    <div className="text-[11px] text-slate-500">{kpi.label}</div>
                    <div className={`text-2xl font-display font-bold tabular-nums mt-1 ${kpi.tone}`}>{kpi.val}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <button
                  type="button"
                  onClick={() => setActiveMod('sos')}
                  className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-red-500 cursor-pointer"
                >
                  <div className="text-xs text-slate-500">Active SOS Alerts</div>
                  <div className="text-2xl font-display font-bold tabular-nums text-red-600 mt-1">
                    {overview?.metrics.activeSosCount ?? 0}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">Open SOS Emergency Desk →</div>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveMod('medical')}
                  className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-emerald-600 cursor-pointer"
                >
                  <div className="text-xs text-slate-500">Active Medical Requests</div>
                  <div className="text-2xl font-display font-bold tabular-nums text-emerald-700 dark:text-emerald-400 mt-1">
                    {overview?.metrics.activeMedicalCount ?? 0}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">Open Medical Help Desk →</div>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveMod('escalations')}
                  className="text-left bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 hover:border-amber-500 cursor-pointer"
                >
                  <div className="text-xs text-slate-500">Escalated / Rejected</div>
                  <div className="text-2xl font-display font-bold tabular-nums mt-1">
                    {overview?.metrics.escalatedCount ?? 0} / {overview?.metrics.rejectedCount ?? 0}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">Inspect SLA Escalations →</div>
                </button>
              </div>

              <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
                <h3 className="text-base font-display font-bold">Recent Authority &amp; Complaint Activity</h3>
                {!overview || overview.recentActivity.length === 0 ? (
                  <p className="text-xs text-slate-500">No authority activity recorded yet.</p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
                    {overview.recentActivity.map((act) => (
                      <div key={act.id} className="py-2.5 flex items-start justify-between gap-3 text-xs">
                        <div>
                          <div className="font-semibold text-slate-900 dark:text-white">
                            {act.report_code} · {act.report_title} → {act.new_status}
                          </div>
                          <div className="text-slate-500">
                            By {act.actor_name} ({act.actor_role}) — {act.comment}
                          </div>
                        </div>
                        <span className="font-mono text-[11px] text-slate-400 shrink-0">
                          {new Date(act.created_at).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* MODULE 2: All Civic Reports */}
          {activeMod === 'reports' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-base font-display font-bold">
                  All Civic Reports ({filteredReports.length})
                </h3>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={(e) => {
                        setSearchTerm(e.target.value);
                        setPage(1);
                      }}
                      placeholder="Search code, title, ward..."
                      className="pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value);
                      setPage(1);
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                  >
                    <option value="">All Statuses</option>
                    {['Submitted', 'Under Review', 'Verified', 'Assigned', 'In Progress', 'Resolved', 'Rejected', 'Escalated'].map(
                      (s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      )
                    )}
                  </select>
                  <select
                    value={categoryFilter}
                    onChange={(e) => {
                      setCategoryFilter(e.target.value);
                      setPage(1);
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                  >
                    <option value="">All Categories</option>
                    {uniqueCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as 'newest' | 'emergency' | 'sla')}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                  >
                    <option value="newest">Newest First</option>
                    <option value="emergency">Emergency Priority</option>
                    <option value="sla">Earliest SLA Deadline</option>
                  </select>
                </div>
              </div>

              {paginatedReports.length === 0 ? (
                <p className="text-xs text-slate-500 p-6 text-center">No matching civic reports found.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {paginatedReports.map((r) => (
                    <div key={r.id} className="py-3.5 flex flex-wrap items-start justify-between gap-3 text-xs">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                          {r.report_code} · {r.category} {r.is_emergency ? '· EMERGENCY' : ''}
                          {r.isOverdue ? ' · SLA OVERDUE' : ''}
                        </div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">{r.title}</div>
                        <div className="text-slate-500">
                          {r.address} ({r.ward}) · Officer: {r.officer_name || 'Unassigned'}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono font-bold">{r.status}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setResReportId(r.id);
                            setActiveMod('resolution');
                          }}
                          className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          Resolve
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {filteredReports.length > pageSize && (
                <div className="flex items-center justify-between pt-2 text-xs">
                  <button
                    type="button"
                    disabled={page === 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="px-3 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
                  >
                    Previous
                  </button>
                  <span className="font-mono">
                    Page {page} of {Math.ceil(filteredReports.length / pageSize)}
                  </span>
                  <button
                    type="button"
                    disabled={page * pageSize >= filteredReports.length}
                    onClick={() => setPage((p) => p + 1)}
                    className="px-3 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}

          {/* MODULE 3: AI Verification */}
          {activeMod === 'ai_verify' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                AI Complaint Verification &amp; Human Review
              </h3>
              {reports.length === 0 ? (
                <p className="text-xs text-slate-500">No complaints available for verification.</p>
              ) : (
                <div className="space-y-4">
                  {reports.slice(0, 15).map((r) => {
                    const ai = r.aiVerification || {};
                    const hasAi = Object.keys(ai).length > 0;
                    return (
                      <div
                        key={r.id}
                        className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                              {r.report_code}
                            </span>{' '}
                            · <span className="font-semibold">{r.title}</span> ({r.status})
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleRunAiVerify(r.id)}
                              className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold cursor-pointer"
                            >
                              Run AI Check
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                handleManageReport(r.id, {
                                  status: 'Verified',
                                  comment: 'Verified by Authority Officer after AI inspection.',
                                })
                              }
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold cursor-pointer"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Approve / Verify
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                handleManageReport(r.id, {
                                  status: 'Rejected',
                                  comment: 'Rejected upon officer verification review.',
                                })
                              }
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-300 text-red-600 font-semibold cursor-pointer"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Reject
                            </button>
                          </div>
                        </div>
                        {hasAi && (
                          <div className="p-3 rounded-lg bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 font-mono text-[11px] space-y-1">
                            <div>
                              AI Category: {String(ai.suggestedCategory || r.category)} · Confidence:{' '}
                              {String(ai.confidence ?? 'N/A')} · Authentic: {String(ai.authenticityAssessment ?? 'Checked')}
                            </div>
                            {Boolean(ai.summary) && <div className="text-slate-600 dark:text-slate-300 font-sans">{String(ai.summary)}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* MODULE 4: SOS Alerts */}
          {activeMod === 'sos' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-red-600" />
                Emergency SOS Response Center ({sosList.length})
              </h3>
              {sosList.length === 0 ? (
                <p className="text-xs text-slate-500">No SOS alerts recorded in the database.</p>
              ) : (
                <div className="space-y-4">
                  {sosList.map((inc) => (
                    <div
                      key={inc.id}
                      className={`p-4 rounded-xl border space-y-3 text-xs ${
                        inc.status === 'active'
                          ? 'bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-800'
                          : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-mono font-bold text-red-700 dark:text-red-300">
                            {inc.incident_code} · {inc.status.toUpperCase()} ({inc.location_status} GPS)
                          </div>
                          <div className="text-sm font-bold text-slate-950 dark:text-white mt-0.5">
                            Citizen: {inc.citizen_name} {inc.citizen_phone ? `· ${inc.citizen_phone}` : ''}
                          </div>
                          <div className="text-slate-600 dark:text-slate-300 mt-0.5">
                            {inc.trigger_address || 'No street address'} · {inc.notes}
                          </div>
                          {(inc.blood_group || inc.medical_notes) && (
                            <div className="font-mono text-[11px] text-slate-600 dark:text-slate-300 mt-1">
                              Medical: Blood {inc.blood_group || 'N/A'} · Notes: {inc.medical_notes || 'None'}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {inc.citizen_phone && (
                            <a
                              href={`tel:${inc.citizen_phone}`}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-semibold"
                            >
                              <PhoneCall className="w-3.5 h-3.5 text-emerald-700" />
                              Call Citizen
                            </a>
                          )}
                          {inc.trigger_lat !== null && inc.trigger_lng !== null && (
                            <a
                              href={`https://www.openstreetmap.org/?mlat=${inc.trigger_lat}&mlon=${inc.trigger_lng}#map=16/${inc.trigger_lat}/${inc.trigger_lng}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-semibold"
                            >
                              <MapPin className="w-3.5 h-3.5 text-red-600" />
                              Map Pin
                            </a>
                          )}
                        </div>
                      </div>

                      {inc.caregivers && inc.caregivers.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="font-semibold text-slate-500">SOS Caregivers:</span>
                          {inc.caregivers.map((cg, idx) => (
                            <a
                              key={idx}
                              href={`tel:${cg.caregiver_phone}`}
                              className="px-2 py-1 rounded bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono"
                            >
                              {cg.caregiver_name} ({cg.caregiver_phone})
                            </a>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={sosNotesDraft[inc.id] ?? inc.response_notes ?? ''}
                          onChange={(e) => setSosNotesDraft((p) => ({ ...p, [inc.id]: e.target.value }))}
                          placeholder="Dispatch / responder notes..."
                          className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleUpdateSos(inc.id, 'acknowledged')}
                          className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-semibold cursor-pointer"
                        >
                          Acknowledge
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleUpdateSos(inc.id, 'resolved')}
                          className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold cursor-pointer"
                        >
                          Mark Resolved
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 5: Medical Help */}
          {activeMod === 'medical' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <HeartPulse className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Authority Medical Help Dispatch ({medicalList.length})
              </h3>
              {medicalList.length === 0 ? (
                <p className="text-xs text-slate-500">No citizen medical assistance requests logged yet.</p>
              ) : (
                <div className="space-y-4">
                  {medicalList.map((m) => (
                    <div
                      key={m.id}
                      className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3 text-xs"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                            {m.request_code} · {m.urgency.toUpperCase()} · {m.status}
                          </div>
                          <div className="text-sm font-bold text-slate-900 dark:text-white mt-0.5">
                            {m.request_type} — {m.citizen_name} {m.citizen_phone ? `(${m.citizen_phone})` : ''}
                          </div>
                          <div className="text-slate-600 dark:text-slate-300 mt-0.5">{m.description}</div>
                          <div className="text-[11px] text-slate-500 mt-1">
                            Location: {m.address} ({m.lat.toFixed(5)}, {m.lng.toFixed(5)})
                            {m.selected_facility_name ? ` · Selected Facility: ${m.selected_facility_name}` : ''}
                            {m.blood_group ? ` · Blood: ${m.blood_group}` : ''}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {m.citizen_phone && (
                            <a
                              href={`tel:${m.citizen_phone}`}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-semibold"
                            >
                              <PhoneCall className="w-3.5 h-3.5 text-emerald-700" />
                              Call
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => handleLookupIncidentHospitals(m)}
                            className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-semibold cursor-pointer"
                          >
                            Find Nearby Hospitals
                          </button>
                        </div>
                      </div>

                      {nearbyFacilitiesMap[m.id] && (
                        <div className="p-2.5 rounded-lg bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 space-y-1">
                          <div className="font-semibold text-slate-700 dark:text-slate-200">
                            Nearest Verified Hospitals (OpenStreetMap):
                          </div>
                          {nearbyFacilitiesMap[m.id].slice(0, 3).map((f) => (
                            <div key={f.id} className="flex items-center justify-between text-[11px]">
                              <span>
                                {f.name} ({f.distanceKm} km)
                              </span>
                              {f.phone && (
                                <a href={`tel:${f.phone}`} className="font-mono text-emerald-700 dark:text-emerald-400">
                                  {f.phone}
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={medNotesDraft[m.id] ?? m.responder_notes ?? ''}
                          onChange={(e) => setMedNotesDraft((p) => ({ ...p, [m.id]: e.target.value }))}
                          placeholder="Ambulance / coordination notes for citizen..."
                          className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        {(['Acknowledged', 'Dispatched', 'Coordinated', 'Resolved'] as const).map((st) => (
                          <button
                            key={st}
                            type="button"
                            disabled={busy}
                            onClick={() => handleUpdateMedical(m.id, st)}
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

          {/* MODULE 6: Officer Assignment */}
          {activeMod === 'assignment' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Department &amp; Officer Assignment Roster
              </h3>
              {reports.length === 0 ? (
                <p className="text-xs text-slate-500">No complaints to assign.</p>
              ) : (
                <div className="space-y-3">
                  {reports.slice(0, 20).map((r) => (
                    <div
                      key={r.id}
                      className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-[200px]">
                        <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                          {r.report_code} · {r.status}
                        </div>
                        <div className="font-semibold text-slate-900 dark:text-white">{r.title}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={assignDeptDraft[r.id] ?? r.department_id ?? ''}
                          onChange={(e) => setAssignDeptDraft((p) => ({ ...p, [r.id]: e.target.value }))}
                          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={assignOfficerDraft[r.id] ?? r.officer_id ?? ''}
                          onChange={(e) => setAssignOfficerDraft((p) => ({ ...p, [r.id]: e.target.value }))}
                          className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          <option value="">Select Officer...</option>
                          {officers.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name} ({o.badge_no})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            handleManageReport(r.id, {
                              status: 'Assigned',
                              departmentId: assignDeptDraft[r.id] ?? r.department_id ?? undefined,
                              officerId: assignOfficerDraft[r.id] ?? r.officer_id ?? undefined,
                              comment: 'Assigned via Authority Officer Assignment desk.',
                            })
                          }
                          className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold cursor-pointer"
                        >
                          Assign
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 7: Action Center */}
          {activeMod === 'action_center' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <Zap className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Prioritized Action Queue ({prioritizedQueue.length})
              </h3>
              {prioritizedQueue.length === 0 ? (
                <p className="text-xs text-slate-500">All open reports have been resolved or closed.</p>
              ) : (
                <div className="space-y-3">
                  {prioritizedQueue.map((r) => (
                    <div
                      key={r.id}
                      className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <div className="font-mono font-bold text-slate-900 dark:text-white">
                          {r.report_code} · {r.severity.toUpperCase()} {r.is_emergency ? '· EMERGENCY' : ''}{' '}
                          {r.isOverdue ? '· OVERDUE' : ''}
                        </div>
                        <div className="font-semibold mt-0.5">{r.title}</div>
                        <div className="text-slate-500">
                          SLA Due: {new Date(r.sla_deadline).toLocaleString()} · Current: {r.status}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {['Under Review', 'Verified', 'In Progress'].map((st) => (
                          <button
                            key={st}
                            type="button"
                            disabled={busy}
                            onClick={() => handleManageReport(r.id, { status: st })}
                            className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-semibold cursor-pointer"
                          >
                            {st}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            setResReportId(r.id);
                            setActiveMod('resolution');
                          }}
                          className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold cursor-pointer"
                        >
                          Upload Resolution Proof
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 8: Resolution & Proof */}
          {activeMod === 'resolution' && (
            <form
              onSubmit={handleSubmitResolutionProof}
              className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
            >
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Upload Field Resolution &amp; Before/After Proof
              </h3>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Select Target Civic Report
                </label>
                <select
                  required
                  value={resReportId}
                  onChange={(e) => setResReportId(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  <option value="">Choose complaint...</option>
                  {reports.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.report_code} — {r.title} ({r.status})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Official Resolution Notes (Sent to Citizen)
                </label>
                <textarea
                  required
                  rows={3}
                  value={resNotes}
                  onChange={(e) => setResNotes(e.target.value)}
                  placeholder="Detail field repair work completed, crew details, and verification..."
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2">
                  <div className="font-semibold">Before Inspection Photo ({beforePhotos.length}/4)</div>
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    Attach Before Photo
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleUploadProofPhoto(e, 'before')}
                      className="hidden"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {beforePhotos.map((u, i) => (
                      <img key={i} src={u} alt="Before" className="w-14 h-14 object-cover rounded border" />
                    ))}
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2">
                  <div className="font-semibold">After Resolution Proof ({afterPhotos.length}/4)</div>
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    Attach After Photo
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleUploadProofPhoto(e, 'after')}
                      className="hidden"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {afterPhotos.map((u, i) => (
                      <img key={i} src={u} alt="After" className="w-14 h-14 object-cover rounded border" />
                    ))}
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="px-5 py-2.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
              >
                Confirm Resolution &amp; Notify Citizen
              </button>
            </form>
          )}

          {/* MODULE 9: Citizen Grievances (Supervisory Summary) */}
          {activeMod === 'grievances' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <FileWarning className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Department Supervisory Grievances ({grievances.length})
              </h3>
              <p className="text-xs text-slate-500">
                Redacted supervisory summary for department accountability. Full investigation and resolution are handled by System Administrators.
              </p>
              {grievances.length === 0 ? (
                <p className="text-xs text-slate-500">No grievances filed against your department.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {grievances.map((g) => (
                    <div key={g.id} className="py-3 flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-mono font-bold text-amber-700 dark:text-amber-400">
                          {g.grievance_code} · {g.category}
                        </div>
                        <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{g.title}</div>
                        {g.related_report_code && (
                          <div className="text-slate-500">Related Report: {g.related_report_code}</div>
                        )}
                      </div>
                      <span className="font-mono font-bold">{g.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 10: Department Performance */}
          {activeMod === 'departments' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <Building2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Department SLA &amp; Resolution Performance
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 pr-3">Department</th>
                      <th className="py-2 pr-3">SLA Target</th>
                      <th className="py-2 pr-3">Assigned</th>
                      <th className="py-2 pr-3">Resolved</th>
                      <th className="py-2 pr-3">Overdue</th>
                      <th className="py-2 pr-3">Rate</th>
                      <th className="py-2 text-right">Avg Hours</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {(performance?.departmentMetrics || []).map((d) => (
                      <tr key={d.id}>
                        <td className="py-2.5 pr-3 font-semibold">{d.name}</td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums">{d.sla_hours}h</td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums">{d.totalAssigned}</td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                          {d.resolvedCount}
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-red-600">{d.overdueCount}</td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums">{d.resolutionRatePct}%</td>
                        <td className="py-2.5 text-right font-mono tabular-nums">{d.avgResolutionHours}h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* MODULE 11: Officer Leaderboard */}
          {activeMod === 'leaderboard' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-display font-bold flex items-center gap-2">
                <Trophy className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                Provisioned Officer Performance Leaderboard
              </h3>
              {!performance || performance.officerLeaderboard.length === 0 ? (
                <p className="text-xs text-slate-500">No officers provisioned yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                        <th className="py-2 pr-3">Rank</th>
                        <th className="py-2 pr-3">Officer</th>
                        <th className="py-2 pr-3">Department</th>
                        <th className="py-2 pr-3">Assigned</th>
                        <th className="py-2 pr-3">Resolved</th>
                        <th className="py-2 pr-3">SLA Compliance</th>
                        <th className="py-2 text-right">Score</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {performance.officerLeaderboard.map((o, idx) => (
                        <tr key={o.id}>
                          <td className="py-2.5 pr-3 font-mono tabular-nums">#{idx + 1}</td>
                          <td className="py-2.5 pr-3 font-semibold">
                            {o.name} <span className="font-mono text-[11px] text-slate-500">({o.badge_no})</span>
                          </td>
                          <td className="py-2.5 pr-3">{o.department_name}</td>
                          <td className="py-2.5 pr-3 font-mono tabular-nums">{o.assignedTotal}</td>
                          <td className="py-2.5 pr-3 font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                            {o.resolvedTotal}
                          </td>
                          <td className="py-2.5 pr-3 font-mono tabular-nums">{o.slaCompliancePct}%</td>
                          <td className="py-2.5 text-right font-mono font-bold tabular-nums">{o.performanceScore}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* MODULE 12: SLA Escalations */}
          {activeMod === 'escalations' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-base font-display font-bold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  SLA Breaches &amp; Escalations ({escalations.length})
                </h3>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleRunEscalationScan}
                  className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 cursor-pointer"
                >
                  Run SLA Escalation Scan
                </button>
              </div>
              {escalations.length === 0 ? (
                <p className="text-xs text-slate-500">No overdue or escalated complaints at this time.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {escalations.map((r) => (
                    <div key={r.id} className="py-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-mono font-bold text-red-600">
                          {r.report_code} · {r.status}
                        </div>
                        <div className="font-semibold text-slate-900 dark:text-white">{r.title}</div>
                        <div className="text-slate-500">
                          SLA Deadline: {new Date(r.sla_deadline).toLocaleString()} · Dept: {r.department_name || 'N/A'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setResReportId(r.id);
                          setActiveMod('resolution');
                        }}
                        className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold cursor-pointer"
                      >
                        Resolve Now
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 13: Notifications */}
          {activeMod === 'notifications' && (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-display font-bold flex items-center gap-2">
                  <Bell className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                  Officer Notifications ({notifications.length})
                </h3>
                {notifications.length > 0 && (
                  <button
                    type="button"
                    onClick={handleMarkAllNotificationsRead}
                    className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                  >
                    Mark All Read
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <p className="text-xs text-slate-500">No notifications recorded for your account.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {notifications.map((n) => (
                    <div key={n.id} className="py-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-white">{n.title}</div>
                        <div className="text-slate-600 dark:text-slate-300 mt-0.5">{n.message}</div>
                      </div>
                      <span className="font-mono text-[11px] text-slate-400 shrink-0">
                        {new Date(n.created_at).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MODULE 14: Analytics & Charts */}
          {activeMod === 'analytics' && <AnalyticsCenter user={user} />}

          {/* MODULE 15: Security, Audit & SMS */}
          {activeMod === 'security' && (
            <div className="space-y-6">
              <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-2 text-xs">
                <h3 className="text-base font-display font-bold flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                  Messaging Gateway &amp; Delivery Status
                </h3>
                <div className="font-mono text-slate-600 dark:text-slate-300">
                  Provider: {securityAudit?.messagingProvider.providerName || 'Unknown'} · SMS:{' '}
                  {securityAudit?.messagingProvider.smsConfigured ? 'Configured' : 'Not Configured'} · WhatsApp:{' '}
                  {securityAudit?.messagingProvider.whatsappConfigured ? 'Configured' : 'Not Configured'}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
                  <h4 className="text-sm font-display font-bold">Immutable Audit Trail</h4>
                  {!securityAudit || securityAudit.auditLogs.length === 0 ? (
                    <p className="text-xs text-slate-500">No audit entries logged yet.</p>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto text-xs">
                      {securityAudit.auditLogs.map((l) => (
                        <div key={l.id} className="py-2 flex items-start justify-between gap-2">
                          <div>
                            <div className="font-mono font-semibold">
                              {l.action} · {l.actor_role}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {l.target_type} ({l.target_id})
                            </div>
                          </div>
                          <span className="font-mono text-[11px] text-slate-400 shrink-0">
                            {new Date(l.created_at).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
                  <h4 className="text-sm font-display font-bold">SMS / WhatsApp Dispatch Log</h4>
                  {!securityAudit || securityAudit.smsLogs.length === 0 ? (
                    <p className="text-xs text-slate-500">No SMS/WhatsApp dispatches recorded yet.</p>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto text-xs">
                      {securityAudit.smsLogs.map((s) => (
                        <div key={s.id} className="py-2 flex items-start justify-between gap-2">
                          <div>
                            <div className="font-mono font-semibold">{s.event_type}</div>
                            <div className="text-[11px] text-slate-500">
                              {s.caregiver_phone} · SMS: {s.sms_status} · WA: {s.whatsapp_status}
                            </div>
                          </div>
                          <span className="font-mono text-[11px] text-slate-400 shrink-0">
                            {new Date(s.created_at).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
