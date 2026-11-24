import React, { useState, useEffect, useCallback } from 'react';
import {
  FileWarning,
  Send,
  Upload,
  CheckCircle2,
  Clock,
  ShieldCheck,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import type { AuthUser, AuthorityGrievance } from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface DepartmentItem {
  id: string;
  name: string;
  code: string;
}

interface AuthorityGrievanceBoxProps {
  user: AuthUser | null;
  departments: DepartmentItem[];
  onRequireAuth: () => void;
  refreshTrigger?: number;
}

const GRIEVANCE_CATEGORIES = [
  'Delayed Complaint Resolution',
  'Officer Misconduct / Unresponsive Behavior',
  'Incorrect Closure Without Resolution',
  'Improper Handling / Quality Failure',
  'Escalation Request to Administration',
];

const STATUS_TIMELINE = ['Submitted', 'Under Review', 'Investigating', 'Resolved'];

export const AuthorityGrievanceBox: React.FC<AuthorityGrievanceBoxProps> = ({
  user,
  departments,
  onRequireAuth,
  refreshTrigger,
}) => {
  const [grievances, setGrievances] = useState<AuthorityGrievance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [category, setCategory] = useState(GRIEVANCE_CATEGORIES[0]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [relatedReportCode, setRelatedReportCode] = useState('');
  const [targetDepartmentId, setTargetDepartmentId] = useState(departments[0]?.id || '');
  const [targetOfficerName, setTargetOfficerName] = useState('');
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const loadGrievances = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiFetch<{ grievances: AuthorityGrievance[] }>('/api/grievances');
      setGrievances(res.grievances || []);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Unable to load grievances.' });
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadGrievances();
  }, [loadGrievances, refreshTrigger]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setFeedback(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch<{ dataUrl: string }>('/api/uploads/evidence', {
        method: 'POST',
        body: formData,
      });
      setEvidenceUrls((prev) => [...prev, res.dataUrl].slice(0, 4));
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Evidence upload failed.' });
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return onRequireAuth();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ id: string; grievanceCode: string }>('/api/grievances', {
        method: 'POST',
        body: JSON.stringify({
          category,
          title,
          description,
          relatedReportCode,
          targetDepartmentId,
          targetOfficerName,
          evidenceUrls,
        }),
      });
      setTitle('');
      setDescription('');
      setRelatedReportCode('');
      setTargetOfficerName('');
      setEvidenceUrls([]);
      setFeedback({
        type: 'ok',
        text: `Supervisory Grievance ${res.grievanceCode} filed and escalated directly to the Administration Portal.`,
      });
      await loadGrievances();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Submission failed.' });
    } finally {
      setBusy(false);
    }
  };

  if (!user || user.role !== 'citizen') {
    return (
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-600 dark:text-slate-400">
        Authority Complaint Box is dedicated to authenticated Citizens to escalate department delays or officer misconduct directly to System Administrators.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            CITIZEN ACCOUNTABILITY CHANNEL
          </div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white flex items-center gap-2 mt-0.5">
            <FileWarning className="w-6 h-6 text-emerald-700 dark:text-emerald-400" />
            Authority &amp; Department Grievance Box
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            Separate from normal civic issues. File formal grievances regarding delayed resolution, improper closure, or officer conduct — reviewed directly by City Administration.
          </p>
        </div>
        <button
          type="button"
          onClick={loadGrievances}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Status
        </button>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-lg border text-xs flex items-center gap-2 ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
          }`}
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{feedback.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Grievance Submission Form */}
        <form
          onSubmit={handleSubmit}
          className="lg:col-span-5 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 h-fit"
        >
          <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
            Submit Formal Grievance
          </h3>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Grievance Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              {GRIEVANCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Target Department
              </label>
              <select
                value={targetDepartmentId}
                onChange={(e) => setTargetDepartmentId(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="">General Municipal Administration</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Related Report Code (Optional)
              </label>
              <input
                type="text"
                value={relatedReportCode}
                onChange={(e) => setRelatedReportCode(e.target.value)}
                placeholder="e.g. NGR-2026-1042"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Officer Name or Badge (Optional)
            </label>
            <input
              type="text"
              value={targetOfficerName}
              onChange={(e) => setTargetOfficerName(e.target.value)}
              placeholder="Officer name or badge number if known"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Grievance Subject
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Concise summary of the administrative issue"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Detailed Account &amp; Dates
            </label>
            <textarea
              required
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what happened, SLA timelines missed, or why the prior resolution was inaccurate..."
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Supporting Evidence ({evidenceUrls.length}/4)
            </label>
            <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              {uploading ? 'Uploading...' : 'Attach Image / Document Proof'}
              <input
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                disabled={uploading || evidenceUrls.length >= 4}
                className="hidden"
              />
            </label>
            {evidenceUrls.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {evidenceUrls.map((url, idx) => (
                  <img
                    key={idx}
                    src={url}
                    alt={`Grievance attachment ${idx + 1}`}
                    className="w-16 h-16 object-cover rounded-lg border border-slate-200 dark:border-slate-700"
                  />
                ))}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={busy || uploading}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            {busy ? 'Submitting to Admin...' : 'Submit Grievance to Administration'}
          </button>
        </form>

        {/* Citizen Grievance Tracker */}
        <div className="lg:col-span-7 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
              My Filed Grievances ({grievances.length})
            </h3>
            <span className="text-[11px] font-mono text-slate-500">Private to your account</span>
          </div>

          {loading ? (
            <p className="text-xs text-slate-500">Loading your grievances...</p>
          ) : grievances.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-500">
              No authority grievances filed yet.
            </div>
          ) : (
            <div className="space-y-4">
              {grievances.map((g) => {
                const isDismissed = g.status === 'Dismissed';
                const currentStep = STATUS_TIMELINE.indexOf(g.status);
                return (
                  <div
                    key={g.id}
                    className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-xs font-bold text-emerald-700 dark:text-emerald-400">
                          {g.grievance_code} · {g.category}
                        </div>
                        <h4 className="text-sm font-display font-bold text-slate-950 dark:text-white mt-0.5">
                          {g.title}
                        </h4>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {g.department_name || 'General Municipal Administration'}
                          {g.related_report_code ? ` · Ref: ${g.related_report_code}` : ''}
                          {g.target_officer_name ? ` · Officer: ${g.target_officer_name}` : ''}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-mono font-bold uppercase ${
                          g.status === 'Resolved'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : g.status === 'Dismissed'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {g.status}
                      </span>
                    </div>

                    <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                      {g.description}
                    </p>

                    {g.evidenceUrls && g.evidenceUrls.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {g.evidenceUrls.map((u, idx) => (
                          <img
                            key={idx}
                            src={u}
                            alt={`Evidence ${idx + 1}`}
                            className="w-14 h-14 object-cover rounded-lg border border-slate-200 dark:border-slate-700"
                          />
                        ))}
                      </div>
                    )}

                    {/* Status Timeline */}
                    {!isDismissed && (
                      <div className="grid grid-cols-4 gap-2 pt-1">
                        {STATUS_TIMELINE.map((step, idx) => {
                          const reached = currentStep >= idx;
                          return (
                            <div key={step} className="space-y-1">
                              <div
                                className={`h-1.5 rounded-sm ${
                                  reached ? 'bg-emerald-700' : 'bg-slate-200 dark:bg-slate-800'
                                }`}
                              />
                              <div
                                className={`text-[10px] font-mono ${
                                  reached
                                    ? 'text-emerald-800 dark:text-emerald-300 font-semibold'
                                    : 'text-slate-400'
                                }`}
                              >
                                {step}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {g.resolution_notes && (
                      <div className="p-3 rounded-lg bg-white dark:bg-[#111916] border border-emerald-200 dark:border-emerald-900 text-xs space-y-1">
                        <div className="font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          Administration Review &amp; Resolution Notes
                        </div>
                        <p className="text-slate-700 dark:text-slate-300">{g.resolution_notes}</p>
                      </div>
                    )}

                    <div className="text-[11px] font-mono text-slate-400 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Filed {new Date(g.created_at).toLocaleString()}
                      </span>
                      {g.resolved_at && (
                        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="w-3 h-3" />
                          Closed {new Date(g.resolved_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
