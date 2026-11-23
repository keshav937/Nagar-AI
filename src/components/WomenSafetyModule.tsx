import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShieldAlert,
  PhoneCall,
  MapPin,
  Crosshair,
  UserPlus,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Copy,
  Check,
  Clock,
  HeartPulse,
  Trash2,
  Bell,
  Lock,
} from 'lucide-react';
import type {
  AuthUser,
  GeoLocationState,
  LanguageCode,
  SafetyDashboardData,
  SosIncident,
} from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface WomenSafetyModuleProps {
  user: AuthUser | null;
  language: LanguageCode;
  geo: GeoLocationState;
  onRequestGps: () => Promise<GeoLocationState | null>;
  onManualPin: (lat: number, lng: number, label?: string) => void;
  onNavigateTab: (tab: string) => void;
}

export const WomenSafetyModule: React.FC<WomenSafetyModuleProps> = ({
  user,
  geo,
  onRequestGps,
  onNavigateTab,
}) => {
  const [data, setData] = useState<SafetyDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Safety session duration
  const [durationMinutes, setDurationMinutes] = useState(60);

  // SOS confirmation & notes
  const [sosModalOpen, setSosModalOpen] = useState(false);
  const [sosNotes, setSosNotes] = useState('');

  // Emergency Medical Profile
  const [bloodGroup, setBloodGroup] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [homeWard, setHomeWard] = useState('');
  const [medicalNotes, setMedicalNotes] = useState('');

  // Emergency Contact Form
  const [ecName, setEcName] = useState('');
  const [ecRel, setEcRel] = useState('Family');
  const [ecPhone, setEcPhone] = useState('');

  // Add Caregiver Form
  const [cgName, setCgName] = useState('');
  const [cgPhone, setCgPhone] = useState('');
  const [cgSms, setCgSms] = useState(true);
  const [cgWhatsapp, setCgWhatsapp] = useState(false);
  const [issuedCodeInfo, setIssuedCodeInfo] = useState<{ caregiverName: string; code: string } | null>(null);
  const [issuedAccessToken, setIssuedAccessToken] = useState<{ caregiverName: string; token: string; expiresAt: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const lastPushRef = useRef<number>(0);

  const fetchDashboard = useCallback(async () => {
    if (!user || user.role !== 'citizen') return;
    try {
      const res = await apiFetch<SafetyDashboardData>('/api/safety/dashboard');
      setData(res);
      setBloodGroup(res.profile?.blood_group || '');
      setEmergencyPhone(res.profile?.emergency_phone || '');
      setHomeWard(res.profile?.home_ward || '');
      setMedicalNotes(res.profile?.medical_notes || '');
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to load safety dashboard.' });
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  // Foreground watchPosition when an active Safety Session is running
  const activeSessionId = data?.activeSession?.id || null;
  useEffect(() => {
    if (!activeSessionId || typeof navigator === 'undefined' || !navigator.geolocation) {
      if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastPushRef.current < 15_000) return;
        lastPushRef.current = now;
        apiFetch('/api/safety/session/location', {
          method: 'POST',
          body: JSON.stringify({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: Math.round(pos.coords.accuracy),
            address: geo.address || '',
          }),
        })
          .then(() => fetchDashboard())
          .catch(() => {});
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 }
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [activeSessionId, geo.address, fetchDashboard]);

  if (!user || user.role !== 'citizen') {
    return (
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-600 dark:text-slate-400">
        Women Safety & Caregiver features are strictly private to authenticated Citizen accounts.
      </div>
    );
  }

  const handleToggleSafetySession = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      if (data?.activeSession) {
        await apiFetch('/api/safety/session/stop', { method: 'POST' });
        setFeedback({ type: 'ok', text: 'Women Safety mode disabled and caregivers notified.' });
      } else {
        const freshGeo = (await onRequestGps()) || geo;
        const res = await apiFetch<{ sessionId: string; expiresAt: string; notifiedCount: number }>(
          '/api/safety/session/start',
          {
            method: 'POST',
            body: JSON.stringify({
              durationMinutes,
              lat: freshGeo.lat,
              lng: freshGeo.lng,
              accuracyM: freshGeo.accuracyM,
              address: freshGeo.address,
            }),
          }
        );
        setFeedback({
          type: 'ok',
          text: `Women Safety mode active for ${durationMinutes} min. ${res.notifiedCount} verified caregiver(s) notified.`,
        });
      }
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Unable to toggle safety mode.' });
    } finally {
      setBusy(false);
    }
  };

  const handlePushManualLocationNow = async () => {
    setBusy(true);
    try {
      const freshGeo = (await onRequestGps()) || geo;
      if (freshGeo.lat === null || freshGeo.lng === null) {
        setFeedback({ type: 'err', text: 'GPS permission was not granted. Please enable browser location access.' });
        return;
      }
      if (data?.activeSession) {
        await apiFetch('/api/safety/session/location', {
          method: 'POST',
          body: JSON.stringify({
            lat: freshGeo.lat,
            lng: freshGeo.lng,
            accuracyM: freshGeo.accuracyM,
            address: freshGeo.address,
          }),
        });
        setFeedback({ type: 'ok', text: 'Fresh live GPS coordinates shared with active verified caregivers.' });
        await fetchDashboard();
      } else {
        setFeedback({ type: 'ok', text: `GPS coordinates acquired (${freshGeo.lat.toFixed(5)}, ${freshGeo.lng.toFixed(5)}).` });
      }
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to push location update.' });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmSos = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const freshGeo = await onRequestGps();
      const targetLat = freshGeo?.lat ?? geo.lat;
      const targetLng = freshGeo?.lng ?? geo.lng;
      const targetAcc = freshGeo?.accuracyM ?? geo.accuracyM;
      const targetAddr = freshGeo?.address || geo.address;
      const locStatus = freshGeo?.lat ? 'live' : targetLat ? 'last_known' : 'unavailable';

      const res = await apiFetch<{
        incident: SosIncident;
        notificationsDispatched?: Array<{ caregiverName: string; smsStatus: string; whatsappStatus: string }>;
        deduplicated?: boolean;
      }>('/api/sos', {
        method: 'POST',
        body: JSON.stringify({
          lat: targetLat,
          lng: targetLng,
          accuracyM: targetAcc,
          address: targetAddr,
          locationStatus: locStatus,
          notes: sosNotes.trim() || 'Emergency SOS triggered by citizen.',
        }),
      });
      setSosModalOpen(false);
      setSosNotes('');
      const count = res.notificationsDispatched?.length ?? 0;
      setFeedback({
        type: 'ok',
        text: res.deduplicated
          ? `Active SOS (${res.incident.incident_code}) is already running.`
          : `SOS Alert ${res.incident.incident_code} activated (${locStatus.replace('_', ' ')} GPS). Dispatched to ${count} verified caregiver(s).`,
      });
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'SOS activation failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateSosStatus = async (id: string, status: 'resolved' | 'cancelled') => {
    setBusy(true);
    try {
      await apiFetch(`/api/sos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          notes: status === 'resolved' ? 'Citizen confirmed they are safe.' : 'Citizen cancelled SOS alert.',
        }),
      });
      setFeedback({ type: 'ok', text: `SOS marked ${status}. Linked caregivers notified.` });
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Unable to update SOS.' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch('/api/safety/profile', {
        method: 'PUT',
        body: JSON.stringify({ bloodGroup, medicalNotes, emergencyPhone, homeWard }),
      });
      setFeedback({ type: 'ok', text: 'Safety & medical profile saved.' });
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleAddEmergencyContact = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch('/api/safety/emergency-contacts', {
        method: 'POST',
        body: JSON.stringify({ name: ecName, relationship: ecRel, phone: ecPhone, isPrimary: false }),
      });
      setEcName('');
      setEcPhone('');
      setFeedback({ type: 'ok', text: 'Emergency contact added.' });
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to add contact.' });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEmergencyContact = async (id: string) => {
    await apiFetch(`/api/safety/emergency-contacts/${id}`, { method: 'DELETE' });
    await fetchDashboard();
  };

  const handleAddCaregiver = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setIssuedCodeInfo(null);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        id: string;
        status: string;
        smsDelivery: { status: string; error?: string };
        verificationCode?: string;
      }>('/api/safety/caregivers', {
        method: 'POST',
        body: JSON.stringify({
          caregiverName: cgName,
          caregiverPhone: cgPhone,
          notifySms: cgSms,
          notifyWhatsapp: cgWhatsapp,
        }),
      });
      if (res.verificationCode) {
        setIssuedCodeInfo({ caregiverName: cgName, code: res.verificationCode });
      }
      setCgName('');
      setCgPhone('');
      setFeedback({
        type: 'ok',
        text: res.verificationCode
          ? 'Caregiver added (Pending Verification). Share the 6-digit verification code shown below so your caregiver can verify in the Caregiver Portal.'
          : 'Caregiver invited and verification SMS sent.',
      });
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to add caregiver.' });
    } finally {
      setBusy(false);
    }
  };

  const handleApproveCaregiver = async (relId: string, caregiverName: string) => {
    setBusy(true);
    try {
      const res = await apiFetch<{ ok: boolean; accessToken: string; expiresAt: string }>(
        `/api/safety/caregivers/${relId}/approve`,
        { method: 'POST', body: JSON.stringify({ expiresHours: 168 }) }
      );
      setIssuedAccessToken({ caregiverName, token: res.accessToken, expiresAt: res.expiresAt });
      setFeedback({ type: 'ok', text: `Approved ${caregiverName}. Shareable Caregiver Access Token generated.` });
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Approval failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeCaregiver = async (relId: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/safety/caregivers/${relId}/revoke`, { method: 'POST' });
      setFeedback({ type: 'ok', text: 'Caregiver permissions and access tokens revoked immediately.' });
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Revoke failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleRetryNotification = async (notifId: string) => {
    setBusy(true);
    try {
      const res = await apiFetch<{ smsStatus: string; whatsappStatus: string }>(
        `/api/safety/caregiver-notifications/${notifId}/retry`,
        { method: 'POST' }
      );
      setFeedback({
        type: 'ok',
        text: `Retry completed — SMS: ${res.smsStatus}, WhatsApp: ${res.whatsappStatus}.`,
      });
      await fetchDashboard();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Retry failed.' });
    } finally {
      setBusy(false);
    }
  };

  const copyShareableLink = async (token: string) => {
    const shareUrl = `${window.location.origin}/?caregiverToken=${encodeURIComponent(token)}`;
    await navigator.clipboard.writeText(shareUrl);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
  };

  const activeSos = data?.sosIncidents.find((s) => s.status === 'active') || null;

  return (
    <div className="space-y-6">
      {/* Header + Emergency SOS Primary Action */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div>
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            CITIZEN SAFETY &amp; SOS SYSTEM
          </div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white mt-0.5">
            Women Safety, Live GPS &amp; Caregiver Network
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            All safety sessions, SOS alerts, and live GPS coordinates are shared exclusively with your verified, approved caregivers. Foreground GPS updates remain active while this dashboard stays open.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <a
            href="tel:112"
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <PhoneCall className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Call 112 Helpline
          </a>
          <button
            type="button"
            onClick={() => onNavigateTab('medical')}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <HeartPulse className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Nearby Hospitals &amp; Police
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setSosModalOpen(true)}
            className="inline-flex items-center gap-2 px-5 py-3 text-sm font-display font-bold rounded-lg bg-red-600 text-white hover:bg-red-700 shadow-sm cursor-pointer"
          >
            <ShieldAlert className="w-5 h-5" />
            TRIGGER SOS
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

      {/* Active SOS Alert Banner */}
      {activeSos && (
        <div className="bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs font-mono font-bold text-red-700 dark:text-red-300">
              ACTIVE SOS ALERT · {activeSos.incident_code} · GPS: {activeSos.location_status.toUpperCase()}
            </div>
            <div className="text-sm font-semibold text-red-950 dark:text-red-100">
              {activeSos.trigger_address ||
                (activeSos.trigger_lat !== null
                  ? `${activeSos.trigger_lat.toFixed(5)}, ${activeSos.trigger_lng?.toFixed(5)}`
                  : 'GPS Unavailable')}
            </div>
            <div className="text-xs text-red-800 dark:text-red-300">
              Triggered {new Date(activeSos.created_at).toLocaleString()} · {activeSos.notes}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={busy}
              onClick={() => handleUpdateSosStatus(activeSos.id, 'resolved')}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
            >
              I Am Safe (Resolve SOS)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleUpdateSosStatus(activeSos.id, 'cancelled')}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-red-300 dark:border-red-700 text-red-700 dark:text-red-200 cursor-pointer"
            >
              Cancel Alert
            </button>
          </div>
        </div>
      )}

      {/* Safety Mode + Live Location Tracking Control Card */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
                Women Safety Live Sharing Mode
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {data?.activeSession
                  ? `Active until ${new Date(data.activeSession.expires_at).toLocaleTimeString()}`
                  : 'Inactive — Only you can activate or stop sharing.'}
              </p>
            </div>
            <span
              className={`text-xs font-mono font-bold ${
                data?.activeSession ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500'
              }`}
            >
              {data?.activeSession ? 'LIVE SHARING ON' : 'OFF'}
            </span>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
            <div className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
              Current Location: {geo.lat ? `${geo.lat.toFixed(5)}, ${geo.lng?.toFixed(5)}` : 'GPS Not Yet Captured'}
              {geo.accuracyM !== null ? ` (±${geo.accuracyM}m)` : ''}
            </div>
            {geo.address && <div className="text-slate-600 dark:text-slate-400">{geo.address}</div>}
            {data?.activeSession?.last_location_at && (
              <div className="text-[11px] font-mono text-slate-500">
                Last shared with caregivers: {new Date(data.activeSession.last_location_at).toLocaleString()}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {!data?.activeSession && (
              <select
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={120}>2 hours</option>
                <option value={240}>4 hours</option>
              </select>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={handleToggleSafetySession}
              className={`px-4 py-2 text-xs font-semibold rounded-lg text-white cursor-pointer ${
                data?.activeSession ? 'bg-slate-900 hover:bg-slate-800' : 'bg-emerald-700 hover:bg-emerald-800'
              }`}
            >
              {data?.activeSession ? 'Stop Safety Mode' : 'Enable Safety Mode'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handlePushManualLocationNow}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Crosshair className="w-3.5 h-3.5" />
              Refresh &amp; Share GPS
            </button>
          </div>
        </div>

        {/* Citizen Medical & Emergency Profile */}
        <form
          onSubmit={handleSaveProfile}
          className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3"
        >
          <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
            Emergency Medical Profile (Shared on Active SOS)
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Blood Group</label>
              <input
                type="text"
                value={bloodGroup}
                onChange={(e) => setBloodGroup(e.target.value)}
                placeholder="e.g. O+"
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Emergency Phone</label>
              <input
                type="tel"
                value={emergencyPhone}
                onChange={(e) => setEmergencyPhone(e.target.value)}
                placeholder="+91..."
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Home Ward / Area</label>
              <input
                type="text"
                value={homeWard}
                onChange={(e) => setHomeWard(e.target.value)}
                placeholder="e.g. Sector 18"
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Allergies / Critical Medical Notes</label>
            <input
              type="text"
              value={medicalNotes}
              onChange={(e) => setMedicalNotes(e.target.value)}
              placeholder="Allergies, medication, or special instructions for caregivers/responders"
              className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 cursor-pointer"
          >
            Save Safety Profile
          </button>
        </form>
      </div>

      {/* Caregiver Linking & Management */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Lock className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Verified Caregiver Linking &amp; Permissions
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              1) Add Caregiver → 2) Caregiver verifies mobile code in Caregiver Portal → 3) You approve &amp; issue Access Token. Revoke anytime.
            </p>
          </div>
          {data?.messagingProvider && (
            <div className="text-[11px] font-mono text-slate-500">
              SMS: {data.messagingProvider.twilioSmsConfigured ? 'Configured' : 'Not Configured'} · WhatsApp:{' '}
              {data.messagingProvider.twilioWhatsappConfigured || data.messagingProvider.metaWhatsappConfigured
                ? 'Configured'
                : 'Not Configured'}
            </div>
          )}
        </div>

        <form onSubmit={handleAddCaregiver} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <div className="md:col-span-3">
            <label className="block text-[11px] text-slate-500 mb-1">Caregiver Full Name</label>
            <input
              type="text"
              required
              value={cgName}
              onChange={(e) => setCgName(e.target.value)}
              placeholder="e.g. Sunita Sharma"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div className="md:col-span-3">
            <label className="block text-[11px] text-slate-500 mb-1">Caregiver Mobile Phone</label>
            <input
              type="tel"
              required
              value={cgPhone}
              onChange={(e) => setCgPhone(e.target.value)}
              placeholder="+9198XXXXXXXX"
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div className="md:col-span-4 flex items-center gap-4 py-2 text-xs">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={cgSms} onChange={(e) => setCgSms(e.target.checked)} className="accent-emerald-700" />
              <span>SMS Alert</span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={cgWhatsapp} onChange={(e) => setCgWhatsapp(e.target.checked)} className="accent-emerald-700" />
              <span>WhatsApp Alert</span>
            </label>
          </div>
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5" />
              Add Caregiver
            </button>
          </div>
        </form>

        {issuedCodeInfo && (
          <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs space-y-1">
            <div className="font-semibold text-amber-900 dark:text-amber-200">
              Caregiver Verification Code for {issuedCodeInfo.caregiverName}
            </div>
            <div className="text-amber-800 dark:text-amber-300">
              SMS delivery is not configured on this server. Share this 6-digit code securely with {issuedCodeInfo.caregiverName} to enter inside their Caregiver Portal:
            </div>
            <div className="font-mono text-lg font-bold tracking-widest text-amber-950 dark:text-amber-100">
              {issuedCodeInfo.code}
            </div>
          </div>
        )}

        {issuedAccessToken && (
          <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs space-y-2">
            <div className="font-semibold text-emerald-900 dark:text-emerald-200">
              Secure Caregiver Access Token Generated for {issuedAccessToken.caregiverName} (Expires {new Date(issuedAccessToken.expiresAt).toLocaleDateString()})
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <code className="px-2.5 py-1.5 rounded bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 font-mono text-[11px] break-all">
                {issuedAccessToken.token}
              </code>
              <button
                type="button"
                onClick={() => copyShareableLink(issuedAccessToken.token)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-semibold cursor-pointer"
              >
                {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey ? 'Link Copied' : 'Copy Portal Link'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-xs text-slate-500">Loading caregivers...</div>
        ) : !data || data.caregivers.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
            No caregivers linked yet. Add a trusted family member or guardian above.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.caregivers.map((cg) => (
              <div key={cg.id} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">{cg.caregiver_name}</div>
                  <div className="text-xs font-mono text-slate-500">
                    {cg.caregiver_phone} · Channels: In-App{cg.notify_sms ? ', SMS' : ''}
                    {cg.notify_whatsapp ? ', WhatsApp' : ''}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-xs font-semibold uppercase ${
                      cg.status === 'active'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : cg.status === 'verified_awaiting_approval'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-slate-500'
                    }`}
                  >
                    {cg.status.replace(/_/g, ' ')}
                  </span>

                  {cg.status === 'verified_awaiting_approval' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleApproveCaregiver(cg.id, cg.caregiver_name)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Approve &amp; Issue Token
                    </button>
                  )}

                  {['pending_verification', 'verified_awaiting_approval', 'active'].includes(cg.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleRevokeCaregiver(cg.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Revoke Access
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Emergency Contacts + Caregiver Notification Delivery History + SOS History */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Emergency Contacts */}
        <div className="lg:col-span-5 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
            Personal Emergency Contacts
          </h3>
          <form onSubmit={handleAddEmergencyContact} className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                required
                value={ecName}
                onChange={(e) => setEcName(e.target.value)}
                placeholder="Contact name"
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <input
                type="text"
                value={ecRel}
                onChange={(e) => setEcRel(e.target.value)}
                placeholder="Relationship"
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div className="flex gap-2">
              <input
                type="tel"
                required
                value={ecPhone}
                onChange={(e) => setEcPhone(e.target.value)}
                placeholder="Phone number"
                className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <button
                type="submit"
                disabled={busy}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white cursor-pointer"
              >
                Add
              </button>
            </div>
          </form>

          {!data || data.contacts.length === 0 ? (
            <p className="text-xs text-slate-500">No emergency contacts saved yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.contacts.map((c) => (
                <div key={c.id} className="py-2.5 flex items-center justify-between text-xs">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">
                      {c.name} ({c.relationship})
                    </div>
                    <a href={`tel:${c.phone}`} className="font-mono text-emerald-700 dark:text-emerald-400 hover:underline">
                      {c.phone}
                    </a>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteEmergencyContact(c.id)}
                    aria-label="Delete contact"
                    className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Caregiver-Only Notification Dispatch & Retry Log */}
        <div className="lg:col-span-7 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Bell className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            Caregiver-Only Alert Delivery History
          </h3>
          {!data || data.caregiverNotifications.length === 0 ? (
            <p className="text-xs text-slate-500">
              No caregiver alerts dispatched yet. Alerts are sent exclusively to verified, active caregivers when safety mode or SOS changes.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
              {data.caregiverNotifications.map((n) => (
                <div key={n.id} className="py-3 space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {n.title} → {n.caregiver_name}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      {new Date(n.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-slate-600 dark:text-slate-300">{n.message}</p>
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] font-mono">
                    <span className="text-slate-500">
                      In-App: Delivered · SMS: {n.sms_status} · WhatsApp: {n.whatsapp_status}
                    </span>
                    {(n.sms_status === 'failed' || n.whatsapp_status === 'failed') && (
                      <button
                        type="button"
                        onClick={() => handleRetryNotification(n.id)}
                        className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Retry Delivery
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* SOS Incident History */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
        <h3 className="text-base font-display font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Clock className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
          My SOS Incident History
        </h3>
        {!data || data.sosIncidents.length === 0 ? (
          <p className="text-xs text-slate-500">No SOS incidents triggered on your account.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.sosIncidents.map((inc) => (
              <div key={inc.id} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <div className="font-mono font-semibold text-slate-900 dark:text-white">
                    {inc.incident_code} · {inc.status.toUpperCase()} ({inc.location_status} GPS)
                  </div>
                  <div className="text-slate-600 dark:text-slate-300 mt-0.5">
                    {inc.trigger_address || 'Coordinates not captured'} · {inc.notes}
                  </div>
                </div>
                <span className="font-mono text-slate-400">{new Date(inc.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Accidental-Tap Confirmation Modal for SOS */}
      {sosModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm Emergency SOS"
            className="w-full max-w-md bg-white dark:bg-[#111916] border border-red-300 dark:border-red-800 rounded-2xl p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center gap-3 text-red-600 dark:text-red-400">
              <ShieldAlert className="w-7 h-7 shrink-0" />
              <div>
                <h3 className="text-lg font-display font-bold">Confirm Emergency SOS</h3>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  Immediately fetches live GPS and alerts your linked verified caregivers.
                </p>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Optional Emergency Note
              </label>
              <input
                type="text"
                value={sosNotes}
                onChange={(e) => setSosNotes(e.target.value)}
                placeholder="e.g., Need immediate pickup near Metro Gate 2"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSosModalOpen(false)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleConfirmSos}
                className="px-5 py-2 text-xs font-bold rounded-lg bg-red-600 text-white hover:bg-red-700 cursor-pointer"
              >
                {busy ? 'Acquiring GPS & Alerting...' : 'Confirm & Send SOS'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
