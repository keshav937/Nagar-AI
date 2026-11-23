import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldAlert,
  MapPin,
  KeyRound,
  Bell,
  CheckCircle2,
  Clock,
  PhoneCall,
  HeartPulse,
  Lock,
  RefreshCw,
} from 'lucide-react';
import type { AuthUser, CaregiverPortalData } from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface CaregiverPortalProps {
  user: AuthUser | null;
  initialAccessToken?: string | null;
  onClearInitialToken?: () => void;
}

export const CaregiverPortal: React.FC<CaregiverPortalProps> = ({
  user,
  initialAccessToken,
  onClearInitialToken,
}) => {
  const [data, setData] = useState<CaregiverPortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [verificationCode, setVerificationCode] = useState('');
  const [tokenInput, setTokenInput] = useState(initialAccessToken || '');
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPortal = useCallback(async () => {
    if (!user || user.role !== 'caregiver') return;
    try {
      const res = await apiFetch<CaregiverPortalData>('/api/caregiver/portal');
      setData(res);
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Unable to load caregiver portal.' });
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadPortal();
  }, [loadPortal]);

  useEffect(() => {
    if (initialAccessToken && user?.role === 'caregiver') {
      apiFetch<{ ok: boolean; citizenId: string }>('/api/caregiver/access-by-token', {
        method: 'POST',
        body: JSON.stringify({ token: initialAccessToken }),
      })
        .then(() => {
          setMsg({ type: 'ok', text: 'Caregiver access token verified and linked to your account.' });
          onClearInitialToken?.();
          loadPortal();
        })
        .catch((err) => {
          setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Invalid or expired caregiver token.' });
        });
    }
  }, [initialAccessToken, user?.role, onClearInitialToken, loadPortal]);

  if (!user || user.role !== 'caregiver') {
    return (
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-600 dark:text-slate-400">
        Caregiver Access Portal is restricted to authenticated Caregiver accounts.
      </div>
    );
  }

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/api/caregiver/verify-identity', {
        method: 'POST',
        body: JSON.stringify({ verificationCode }),
      });
      setVerificationCode('');
      setMsg({ type: 'ok', text: res.message });
      await loadPortal();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Verification failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRedeemToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch('/api/caregiver/access-by-token', {
        method: 'POST',
        body: JSON.stringify({ token: tokenInput }),
      });
      setTokenInput('');
      setMsg({ type: 'ok', text: 'Caregiver access token verified. Authorized citizen safety info loaded.' });
      await loadPortal();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : 'Token redemption failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleMarkRead = async (id: string) => {
    await apiFetch(`/api/caregiver/notifications/${id}/read`, { method: 'PATCH' });
    await loadPortal();
  };

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            VERIFIED CAREGIVER ACCESS PORTAL
          </div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white mt-0.5">
            Authorized Citizen Safety &amp; SOS Monitor
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Registered Mobile: <span className="font-mono">{user.phone || 'Not set'}</span> · Access is strictly limited to citizens who have approved you.
          </p>
        </div>
        <button
          type="button"
          onClick={loadPortal}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Status
        </button>
      </div>

      {msg && (
        <div
          className={`p-3.5 rounded-lg border text-xs ${
            msg.type === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* Identity Verification & Token Redemption */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <form
          onSubmit={handleVerifyCode}
          className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
        >
          <h3 className="text-sm font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Step 1: Verify Caregiver Invitation Code
          </h3>
          <p className="text-xs text-slate-500">
            Enter the 6-digit verification code provided by the citizen who added your mobile number ({user.phone}).
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              required
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              placeholder="6-digit code"
              className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
            >
              Verify Code
            </button>
          </div>
        </form>

        <form
          onSubmit={handleRedeemToken}
          className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
        >
          <h3 className="text-sm font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Step 2: Redeem Caregiver Access Token
          </h3>
          <p className="text-xs text-slate-500">
            Paste an expiring Caregiver Access Token shared by an approved citizen to unlock their live location &amp; SOS feed.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              required
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste access token..."
              className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 cursor-pointer"
            >
              Activate Link
            </button>
          </div>
        </form>
      </div>

      {/* Linked Citizens List */}
      <div className="space-y-4">
        <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
          Linked Citizens ({data?.linkedCitizens.length ?? 0})
        </h3>

        {loading ? (
          <div className="text-xs text-slate-500">Loading authorized citizen records...</div>
        ) : !data || data.linkedCitizens.length === 0 ? (
          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-xs text-slate-500">
            No citizens linked to your caregiver account yet. Ask a citizen to add your mobile number from their Women Safety dashboard.
          </div>
        ) : (
          data.linkedCitizens.map((c) => {
            const activeAlert = c.sosAlerts?.find((s) => s.status === 'active');
            return (
              <div
                key={c.relationshipId}
                className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-lg font-display font-bold text-slate-900 dark:text-white">
                      {c.citizenName}
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      Link Status: {c.status.replace(/_/g, ' ').toUpperCase()}
                      {c.citizenPhone ? ` · ${c.citizenPhone}` : ''}
                    </div>
                  </div>
                  {c.authorized && c.citizenPhone && (
                    <a
                      href={`tel:${c.citizenPhone}`}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700"
                    >
                      <PhoneCall className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                      Call Citizen
                    </a>
                  )}
                </div>

                {!c.authorized ? (
                  <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex items-center gap-2">
                    <Lock className="w-4 h-4 shrink-0" />
                    <span>
                      {c.status === 'pending_verification'
                        ? 'Pending verification: Enter the 6-digit verification code above to verify your identity.'
                        : 'Identity verified — waiting for the citizen to grant final approval & issue your Caregiver Access Token.'}
                    </span>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {activeAlert && (
                      <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800 space-y-1">
                        <div className="text-xs font-mono font-bold text-red-700 dark:text-red-300 flex items-center gap-1.5">
                          <ShieldAlert className="w-4 h-4" />
                          ACTIVE EMERGENCY SOS · {activeAlert.incident_code}
                        </div>
                        <div className="text-sm font-semibold text-red-950 dark:text-red-100">
                          {activeAlert.trigger_address || 'Coordinates logged'} ({activeAlert.location_status} GPS)
                        </div>
                        <div className="text-xs text-red-800 dark:text-red-300">{activeAlert.notes}</div>
                        {activeAlert.trigger_lat !== null && activeAlert.trigger_lng !== null && (
                          <a
                            href={`https://www.openstreetmap.org/?mlat=${activeAlert.trigger_lat}&mlon=${activeAlert.trigger_lng}#map=16/${activeAlert.trigger_lat}/${activeAlert.trigger_lng}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 dark:text-red-200 underline pt-1"
                          >
                            <MapPin className="w-3.5 h-3.5" />
                            Open SOS Location on Map
                          </a>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                      <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1.5">
                        <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                          <MapPin className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                          Live Safety Location Status
                        </div>
                        {c.activeSession ? (
                          <>
                            <div className="text-emerald-700 dark:text-emerald-400 font-semibold">
                              Safety Session ACTIVE (expires {new Date(c.activeSession.expires_at).toLocaleTimeString()})
                            </div>
                            <div className="text-slate-700 dark:text-slate-200">
                              {c.activeSession.last_address ||
                                (c.activeSession.last_lat !== null
                                  ? `${c.activeSession.last_lat.toFixed(5)}, ${c.activeSession.last_lng?.toFixed(5)}`
                                  : 'Awaiting GPS coordinate push')}
                            </div>
                            {c.activeSession.last_location_at && (
                              <div className="text-[11px] font-mono text-slate-500 flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                Last GPS update: {new Date(c.activeSession.last_location_at).toLocaleString()}
                                {c.activeSession.last_accuracy_m ? ` (±${c.activeSession.last_accuracy_m}m)` : ''}
                              </div>
                            )}
                            {c.activeSession.last_lat !== null && c.activeSession.last_lng !== null && (
                              <a
                                href={`https://www.openstreetmap.org/?mlat=${c.activeSession.last_lat}&mlon=${c.activeSession.last_lng}#map=16/${c.activeSession.last_lat}/${c.activeSession.last_lng}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block text-emerald-700 dark:text-emerald-400 font-semibold hover:underline pt-1"
                              >
                                View Citizen Pin on OpenStreetMap →
                              </a>
                            )}
                          </>
                        ) : (
                          <div className="text-slate-500">
                            Citizen does not currently have an active live location sharing session.
                          </div>
                        )}
                      </div>

                      <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1.5">
                        <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                          <HeartPulse className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                          Emergency Medical Profile
                        </div>
                        {c.emergencyProfile ? (
                          <div className="space-y-1 text-slate-600 dark:text-slate-300">
                            <div>Blood Group: {c.emergencyProfile.blood_group || 'Not specified'}</div>
                            <div>Emergency Phone: {c.emergencyProfile.emergency_phone || 'Not specified'}</div>
                            <div>Home Ward: {c.emergencyProfile.home_ward || 'Not specified'}</div>
                            <div>Medical Notes: {c.emergencyProfile.medical_notes || 'None'}</div>
                          </div>
                        ) : (
                          <div className="text-slate-500">No medical profile entered by citizen.</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Caregiver-Only Notifications */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
        <h3 className="text-base font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Bell className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
          Caregiver Safety &amp; SOS Notifications
        </h3>
        {!data || data.notifications.length === 0 ? (
          <p className="text-xs text-slate-500">No caregiver alerts received yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.notifications.map((n) => (
              <div key={n.id} className="py-3 flex items-start justify-between gap-4 text-xs">
                <div>
                  <div className="font-semibold text-slate-900 dark:text-white">{n.title}</div>
                  <div className="text-slate-600 dark:text-slate-300 mt-0.5">{n.message}</div>
                  <div className="font-mono text-[11px] text-slate-400 mt-1">
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
                {!n.in_app_read && (
                  <button
                    type="button"
                    onClick={() => handleMarkRead(n.id)}
                    className="text-emerald-700 dark:text-emerald-400 font-semibold hover:underline shrink-0 cursor-pointer"
                  >
                    Mark read
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
