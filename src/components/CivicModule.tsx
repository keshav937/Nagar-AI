import React, { useState, useMemo } from 'react';
import {
  Plus,
  Sparkles,
  Clock,
  Download,
  Upload,
  Crosshair,
  AlertTriangle,
  MessageSquare,
} from 'lucide-react';
import type { AuthUser, CivicReport, GeoLocationState, LanguageCode } from '../types.ts';
import { apiFetch } from '../api/client.ts';

const CIVIC_CATEGORIES = [
  'Potholes',
  'Damaged roads',
  'Garbage dumping',
  'Broken streetlights',
  'Water leakage',
  'Drainage blockage',
  'Damaged footpaths',
  'Open manholes',
  'Public infrastructure damage',
  'Illegal dumping',
  'Other civic issues',
];

interface Department {
  id: string;
  name: string;
  code: string;
  sla_hours: number;
  head_name: string;
}

interface Officer {
  id: string;
  department_id: string;
  department_name: string;
  name: string;
  badge_no: string;
  ward: string;
}

interface CivicModuleProps {
  user: AuthUser | null;
  language: LanguageCode;
  geo: GeoLocationState;
  onRequestGps: () => void;
  reports: CivicReport[];
  departments: Department[];
  officers: Officer[];
  onRefresh: () => void;
  onRequireAuth: () => void;
}

async function compressImageFile(file: File): Promise<{ base64: string; mimeType: string; dataUrl: string }> {
  if (!file.type.startsWith('image/')) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    const b64 = btoa(bin);
    return { base64: b64, mimeType: file.type, dataUrl: `data:${file.type};base64,${b64}` };
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxDim = 960;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      URL.revokeObjectURL(url);
      resolve({ dataUrl, mimeType: 'image/jpeg', base64: dataUrl.split(',')[1] || '' });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Invalid image file'));
    };
    img.src = url;
  });
}

export const CivicModule: React.FC<CivicModuleProps> = ({
  user,
  language,
  geo,
  onRequestGps,
  reports,
  departments,
  officers,
  onRefresh,
  onRequireAuth,
}) => {
  const [subTab, setSubTab] = useState<'feed' | 'report' | 'authority'>('feed');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedReport, setSelectedReport] = useState<CivicReport | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Report form state
  const [category, setCategory] = useState('Potholes');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [landmark, setLandmark] = useState('');
  const [address, setAddress] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [isEmergency, setIsEmergency] = useState(false);
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [evidenceDataUrl, setEvidenceDataUrl] = useState<string | null>(null);
  const [evidenceBase64, setEvidenceBase64] = useState<string | null>(null);
  const [evidenceMime, setEvidenceMime] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  // Comment & Authority management state
  const [commentText, setCommentText] = useState('');
  const [manageStatus, setManageStatus] = useState('');
  const [manageOfficer, setManageOfficer] = useState('');
  const [manageComment, setManageComment] = useState('');

  const effectiveLat = geo.lat ?? (Number(manualLat) || null);
  const effectiveLng = geo.lng ?? (Number(manualLng) || null);
  const effectiveAddress = address.trim() || geo.address;

  const stats = useMemo(() => {
    const total = reports.length;
    const pending = reports.filter((r) => ['Submitted', 'Under Review'].includes(r.status)).length;
    const verified = reports.filter((r) => r.status === 'Verified').length;
    const inProgress = reports.filter((r) => ['Assigned', 'In Progress'].includes(r.status)).length;
    const resolved = reports.filter((r) => r.status === 'Resolved').length;
    const overdue = reports.filter((r) => r.isOverdue).length;
    return { total, pending, verified, inProgress, resolved, overdue };
  }, [reports]);

  const filteredReports = useMemo(() => {
    return reports.filter((r) => {
      if (statusFilter === 'overdue' && !r.isOverdue) return false;
      if (statusFilter !== 'all' && statusFilter !== 'overdue' && r.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && r.category !== categoryFilter) return false;
      return true;
    });
  }, [reports, statusFilter, categoryFilter]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImageFile(file);
      setEvidenceDataUrl(compressed.dataUrl);
      setEvidenceBase64(compressed.base64);
      setEvidenceMime(compressed.mimeType);
    } catch {
      setFeedbackMsg({ type: 'err', text: 'Could not process the selected evidence file.' });
    }
  };

  const handleEnhanceDescription = async () => {
    if (!user) return onRequireAuth();
    if (!description.trim()) {
      setFeedbackMsg({ type: 'err', text: 'Enter a short description first for the AI assistant to structure.' });
      return;
    }
    setBusy(true);
    setFeedbackMsg(null);
    try {
      const res = await apiFetch<{ enhancedText: string }>('/api/ai/civic/enhance-description', {
        method: 'POST',
        body: JSON.stringify({ draft: description, category, language }),
      });
      setDescription(res.enhancedText);
      setFeedbackMsg({
        type: 'ok',
        text: 'Description structured by Gemini AI.',
      });
    } catch (err) {
      setFeedbackMsg({ type: 'err', text: err instanceof Error ? err.message : 'AI enhancement failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRunAiTriage = async () => {
    if (!user) return onRequireAuth();
    setBusy(true);
    setFeedbackMsg(null);
    try {
      const res = await apiFetch<Record<string, unknown>>('/api/ai/civic/analyze', {
        method: 'POST',
        body: JSON.stringify({
          category,
          title: title || category,
          description: description || `${category} reported`,
          lat: effectiveLat ?? 28.6315,
          lng: effectiveLng ?? 77.2167,
          imageBase64: evidenceBase64 || undefined,
          imageMimeType: evidenceMime || undefined,
        }),
      });
      setAiResult(res);
      if (typeof res.predictedCategory === 'string' && CIVIC_CATEGORIES.includes(res.predictedCategory)) {
        setCategory(res.predictedCategory);
      }
      if (typeof res.severityEstimate === 'string' && ['low', 'medium', 'high', 'critical'].includes(res.severityEstimate)) {
        setSeverity(res.severityEstimate as 'low' | 'medium' | 'high' | 'critical');
      }
    } catch (err) {
      setFeedbackMsg({ type: 'err', text: err instanceof Error ? err.message : 'AI triage failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return onRequireAuth();
    if (effectiveLat === null || effectiveLng === null) {
      setFeedbackMsg({
        type: 'err',
        text: 'Please grant GPS permission or enter/pin coordinates before submitting.',
      });
      return;
    }
    setBusy(true);
    setFeedbackMsg(null);
    try {
      const res = await apiFetch<{ id: string; reportCode: string }>('/api/civic/reports', {
        method: 'POST',
        body: JSON.stringify({
          category,
          title,
          description,
          lat: effectiveLat,
          lng: effectiveLng,
          accuracyM: geo.accuracyM,
          locationSource: geo.status === 'acquired' ? 'gps' : 'manual',
          address: effectiveAddress || `Coordinates ${effectiveLat.toFixed(4)}, ${effectiveLng.toFixed(4)}`,
          landmark,
          ward: geo.ward || 'Local Ward',
          severity,
          isEmergency,
          evidenceUrls: evidenceDataUrl ? [evidenceDataUrl] : [],
          aiVerification: aiResult || {},
        }),
      });
      setFeedbackMsg({ type: 'ok', text: `Complaint ${res.reportCode} submitted and saved to database.` });
      setTitle('');
      setDescription('');
      setLandmark('');
      setIsEmergency(false);
      setEvidenceDataUrl(null);
      setEvidenceBase64(null);
      setAiResult(null);
      onRefresh();
      setSubTab('feed');
    } catch (err) {
      setFeedbackMsg({ type: 'err', text: err instanceof Error ? err.message : 'Submission failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handlePostComment = async (reportId: string) => {
    if (!user) return onRequireAuth();
    if (!commentText.trim()) return;
    try {
      await apiFetch(`/api/civic/reports/${reportId}/comment`, {
        method: 'POST',
        body: JSON.stringify({ comment: commentText }),
      });
      setCommentText('');
      onRefresh();
    } catch (err) {
      setFeedbackMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed to post comment.' });
    }
  };

  const handleAuthorityManage = async (reportId: string) => {
    if (!user || (user.role !== 'authority' && user.role !== 'admin')) return;
    try {
      await apiFetch(`/api/civic/reports/${reportId}/manage`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: manageStatus || undefined,
          officerId: manageOfficer || undefined,
          comment: manageComment || undefined,
        }),
      });
      setManageComment('');
      setFeedbackMsg({ type: 'ok', text: 'Complaint assignment and status updated.' });
      onRefresh();
    } catch (err) {
      setFeedbackMsg({ type: 'err', text: err instanceof Error ? err.message : 'Update failed.' });
    }
  };

  const handleExportCsv = async () => {
    try {
      const csv = await apiFetch<string>('/api/civic/export.csv');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nagar-civic-reports.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFeedbackMsg({ type: 'err', text: err instanceof Error ? err.message : 'CSV export failed.' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Sub-navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white">
            Civic Issue Management
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            GPS-verified municipal reporting, AI triage verification, and community confirmation.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setSubTab('feed')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              subTab === 'feed'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {user?.role === 'citizen' ? 'My Reports' : 'Assigned Queue'}
          </button>
          {(!user || user.role === 'citizen') && (
            <button
              type="button"
              onClick={() => setSubTab('report')}
              className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                subTab === 'report'
                  ? 'bg-emerald-700 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              Report Issue
            </button>
          )}
          {(user?.role === 'authority' || user?.role === 'admin') && (
            <button
              type="button"
              onClick={() => setSubTab('authority')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                subTab === 'authority'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Department Roster &amp; CSV
            </button>
          )}
        </div>
      </div>

      {/* KPI Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          ['Total Reports', stats.total],
          ['Pending', stats.pending],
          ['Verified', stats.verified],
          ['In Progress', stats.inProgress],
          ['Resolved', stats.resolved],
          ['Overdue SLA', stats.overdue],
        ].map(([label, val]) => (
          <div
            key={String(label)}
            className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-4"
          >
            <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
            <div className="mt-1 text-xl font-display font-bold tabular-nums text-slate-900 dark:text-white">
              {val}
            </div>
          </div>
        ))}
      </div>

      {feedbackMsg && (
        <div
          className={`p-3 rounded-lg border text-xs ${
            feedbackMsg.type === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
          }`}
        >
          {feedbackMsg.text}
        </div>
      )}

      {/* TAB 1: COMPLAINTS FEED */}
      {subTab === 'feed' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              <option value="all">All Statuses</option>
              <option value="Submitted">Submitted</option>
              <option value="Verified">Verified</option>
              <option value="Assigned">Assigned</option>
              <option value="In Progress">In Progress</option>
              <option value="Escalated">Escalated</option>
              <option value="Resolved">Resolved</option>
              <option value="overdue">Overdue Only</option>
            </select>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              <option value="all">All Categories</option>
              {CIVIC_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className={`${selectedReport ? 'lg:col-span-7' : 'lg:col-span-12'} space-y-3`}>
              {filteredReports.length === 0 ? (
                <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center">
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {reports.length === 0
                      ? 'No reports submitted yet.'
                      : 'No civic complaints match the current filter.'}
                  </p>
                </div>
              ) : (
                filteredReports.map((r) => (
                  <div
                    key={r.id}
                    onClick={() => {
                      setSelectedReport(r);
                      setManageStatus(r.status);
                      setManageOfficer(r.officer_id || '');
                    }}
                    className={`bg-white dark:bg-[#111916] border rounded-xl p-5 cursor-pointer transition-colors ${
                      selectedReport?.id === r.id
                        ? 'border-emerald-600'
                        : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono tabular-nums">
                        {r.report_code} · {r.category} · {r.ward}
                        {r.is_emergency ? ' · EMERGENCY PRIORITY' : ''}
                      </span>
                      <span
                        className={`font-semibold ${
                          r.status === 'Resolved'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : r.isOverdue || r.status === 'Escalated' || r.is_emergency
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {r.status}
                        {r.isOverdue ? ' (Overdue SLA)' : ''}
                      </span>
                    </div>

                    <h3 className="mt-1.5 text-base font-display font-semibold text-slate-900 dark:text-white">
                      {r.title}
                    </h3>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 line-clamp-2">{r.description}</p>

                    <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                      <span>
                        {r.address}
                        {r.distanceKm !== null ? ` · ${r.distanceKm} km away` : ''}
                      </span>
                      <span className="font-mono text-[11px]">{new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {selectedReport && (
              <div className="lg:col-span-5 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 h-fit space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono tabular-nums text-slate-500">
                      {selectedReport.report_code} · Severity: {selectedReport.severity.toUpperCase()}
                    </div>
                    <h3 className="mt-1 text-lg font-display font-bold text-slate-900 dark:text-white">
                      {selectedReport.title}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedReport(null)}
                    className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                  >
                    Close
                  </button>
                </div>

                {selectedReport.evidenceUrls.length > 0 && (
                  <img
                    src={selectedReport.evidenceUrls[0]}
                    alt="Complaint evidence"
                    className="w-full h-44 object-cover rounded-lg border border-slate-200 dark:border-slate-800"
                  />
                )}

                <div className="text-sm text-slate-700 dark:text-slate-300 space-y-1">
                  <p>{selectedReport.description}</p>
                  <p className="text-xs text-slate-500 pt-1">
                    Department: {selectedReport.department_name || 'Unassigned'} · Officer:{' '}
                    {selectedReport.officer_name || 'Pending'}
                  </p>
                  <p className="text-xs font-mono tabular-nums text-slate-500">
                    SLA Deadline: {new Date(selectedReport.sla_deadline).toLocaleString()}
                  </p>
                </div>

                {/* Activity Timeline */}
                <div className="border-t border-slate-200 dark:border-slate-800 pt-3">
                  <h4 className="text-xs font-semibold text-slate-900 dark:text-white mb-2 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    Status Lifecycle Timeline
                  </h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {selectedReport.activities.map((a) => (
                      <div key={a.id} className="text-xs border-b border-slate-100 dark:border-slate-800/60 pb-2">
                        <div className="font-medium text-slate-800 dark:text-slate-200">
                          {a.new_status} · {a.actor_name} ({a.actor_role})
                        </div>
                        <div className="text-slate-600 dark:text-slate-400 mt-0.5">{a.comment}</div>
                        <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                          {new Date(a.created_at).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Comment Input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add citizen/officer update..."
                    className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                  <button
                    type="button"
                    onClick={() => handlePostComment(selectedReport.id)}
                    className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 cursor-pointer"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Post
                  </button>
                </div>

                {/* Authority Actions inside Detail Panel */}
                {(user?.role === 'authority' || user?.role === 'admin') && (
                  <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-2">
                    <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      Authority Workflow Controls
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={manageStatus}
                        onChange={(e) => setManageStatus(e.target.value)}
                        className="px-2.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      >
                        {['Submitted', 'Under Review', 'Verified', 'Assigned', 'In Progress', 'Resolved', 'Rejected', 'Escalated'].map(
                          (s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          )
                        )}
                      </select>
                      <select
                        value={manageOfficer}
                        onChange={(e) => setManageOfficer(e.target.value)}
                        className="px-2.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      >
                        <option value="">Assign Officer...</option>
                        {officers.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name} ({o.ward})
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      type="text"
                      value={manageComment}
                      onChange={(e) => setManageComment(e.target.value)}
                      placeholder="Official action note..."
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => handleAuthorityManage(selectedReport.id)}
                      className="w-full py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                    >
                      Save Assignment & Status
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: REPORT ISSUE FORM */}
      {subTab === 'report' && (
        <form
          onSubmit={handleSubmitReport}
          className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
            <div>
              <h3 className="text-lg font-display font-semibold text-slate-900 dark:text-white">
                Submit Civic Complaint
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Requires verified GPS coordinates or manual map coordinates. AI checks do not replace authority review.
              </p>
            </div>
            <button
              type="button"
              onClick={onRequestGps}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
            >
              <Crosshair className="w-3.5 h-3.5" />
              {geo.lat ? 'GPS Captured' : 'Capture GPS Location'}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Issue Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                {CIVIC_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Severity Level</label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as 'low' | 'medium' | 'high' | 'critical')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-400 cursor-pointer">
            <input
              type="checkbox"
              checked={isEmergency}
              onChange={(e) => setIsEmergency(e.target.checked)}
              className="accent-red-600"
            />
            <span>Flag as Immediate Public Safety Hazard / Emergency Priority</span>
          </label>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Issue Title</label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Deep pothole near Metro Exit Gate 4"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Description</label>
              <button
                type="button"
                disabled={busy}
                onClick={handleEnhanceDescription}
                className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                AI Description Assistant
              </button>
            </div>
            <textarea
              required
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue, public hazard, and approximate size..."
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Street Address / Location
              </label>
              <input
                type="text"
                value={address || geo.address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Auto-filled when GPS or map pin is selected"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Landmark</label>
              <input
                type="text"
                value={landmark}
                onChange={(e) => setLandmark(e.target.value)}
                placeholder="Near pillar, school, market..."
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>

          {!geo.lat && (
            <div className="grid grid-cols-2 gap-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Manual Latitude (if GPS denied)</label>
                <input
                  type="number"
                  step="any"
                  value={manualLat}
                  onChange={(e) => setManualLat(e.target.value)}
                  placeholder="e.g. 28.6328"
                  className="w-full px-3 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Manual Longitude</label>
                <input
                  type="number"
                  step="any"
                  value={manualLng}
                  onChange={(e) => setManualLng(e.target.value)}
                  placeholder="e.g. 77.2197"
                  className="w-full px-3 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
          )}

          {/* Evidence Upload & AI Triage */}
          <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
            <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
              <Upload className="w-4 h-4" />
              <span>{evidenceDataUrl ? 'Photo Attached (Replace)' : 'Attach Photo / Video Evidence'}</span>
              <input type="file" accept="image/*,video/*" onChange={handleFileChange} className="hidden" />
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={handleRunAiTriage}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg border border-emerald-600 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Run AI Photo & Duplicate Triage
            </button>
          </div>

          {evidenceDataUrl && (
            <img
              src={evidenceDataUrl}
              alt="Evidence preview"
              className="w-48 h-32 object-cover rounded-lg border border-slate-200 dark:border-slate-800"
            />
          )}

          {aiResult && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
              <div className="font-semibold text-slate-900 dark:text-white flex items-center justify-between">
                <span>AI Civic Verification Preview (Human Review Pending)</span>
                <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                  Confidence: {Math.round(Number(aiResult.confidence || 0) * 100)}%
                </span>
              </div>
              <p className="text-slate-600 dark:text-slate-300">{String(aiResult.explanation || '')}</p>
              <p className="text-slate-500">
                Suggested Dept: {String(aiResult.departmentSuggested || '')} · Image Quality:{' '}
                {String(aiResult.imageQuality || 'n/a')}
              </p>
              {Array.isArray(aiResult.potentialDuplicates) && aiResult.potentialDuplicates.length > 0 && (
                <div className="pt-1 text-amber-700 dark:text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>
                    {aiResult.potentialDuplicates.length} nearby existing complaint(s) within 600m detected.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={busy}
              className="px-6 py-2.5 text-sm font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
            >
              {busy ? 'Submitting...' : 'Submit Civic Complaint'}
            </button>
          </div>
        </form>
      )}

      {/* TAB 3: AUTHORITY CONSOLE */}
      {subTab === 'authority' && (user?.role === 'authority' || user?.role === 'admin') && (
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-display font-semibold text-slate-900 dark:text-white">
                Municipal Departments & Field Officers
              </h3>
              <p className="text-xs text-slate-500">Manage SLA targets, department rosters, and export complaint logs.</p>
            </div>
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Export Reports CSV
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2 pr-4">Department</th>
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Department Head</th>
                  <th className="py-2 text-right">SLA Window</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {departments.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2.5 pr-4 font-medium text-slate-900 dark:text-white">{d.name}</td>
                    <td className="py-2.5 pr-4 font-mono">{d.code}</td>
                    <td className="py-2.5 pr-4 text-slate-600 dark:text-slate-300">{d.head_name}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums">{d.sla_hours}h</td>
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
