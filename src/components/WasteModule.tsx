import React, { useState } from 'react';
import { Trash2, Sparkles, Award, CheckCircle2, Recycle, Upload } from 'lucide-react';
import type { AuthUser, GeoLocationState, LanguageCode, RecyclingCentre, WasteBin, WasteCollection } from '../types.ts';
import { apiFetch } from '../api/client.ts';

interface WasteModuleProps {
  user: AuthUser | null;
  language: LanguageCode;
  geo: GeoLocationState;
  bins: WasteBin[];
  collections: WasteCollection[];
  recyclingCentres: RecyclingCentre[];
  leaderboard: Array<{ name: string; points: number; households_verified: number; streak_days: number }>;
  myRewards: { points: number; streak_days: number; badges: string[]; history: Array<{ date: string; action: string; points: number }> } | null;
  onRefresh: () => void;
  onRequireAuth: () => void;
}

export const WasteModule: React.FC<WasteModuleProps> = ({
  user,
  language,
  geo,
  bins,
  collections,
  recyclingCentres,
  leaderboard,
  myRewards,
  onRefresh,
  onRequireAuth,
}) => {
  const [subTab, setSubTab] = useState<'bins' | 'classify' | 'rewards' | 'operations'>('bins');
  const [wasteItemDesc, setWasteItemDesc] = useState('');
  const [wastePhotoBase64, setWastePhotoBase64] = useState<string | null>(null);
  const [wastePhotoMime, setWastePhotoMime] = useState<string | null>(null);
  const [aiClassResult, setAiClassResult] = useState<{
    category: string;
    recommendedBin: string;
    confidence: number;
    uncertain: boolean;
    explanation: string;
    disposalSteps?: string[];
    demoFallback?: boolean;
  } | null>(null);
  const [segNote, setSegNote] = useState('Morning Wet & Dry Household Segregation');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleClassify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return onRequireAuth();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<typeof aiClassResult>('/api/ai/waste/classify', {
        method: 'POST',
        body: JSON.stringify({
          description: wasteItemDesc,
          imageBase64: wastePhotoBase64 || undefined,
          imageMimeType: wastePhotoMime || undefined,
          language,
        }),
      });
      setAiClassResult(res);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Waste classification failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleWasteImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      setWastePhotoBase64(url.split(',')[1] || '');
      setWastePhotoMime(file.type || 'image/jpeg');
    };
    reader.readAsDataURL(file);
  };

  const handleReportOverflow = async (bin: WasteBin) => {
    if (!user) return onRequireAuth();
    await apiFetch('/api/civic/reports', {
      method: 'POST',
      body: JSON.stringify({
        category: 'Garbage dumping',
        title: `Overflowing Smart Bin ${bin.bin_code}`,
        description: `Citizen reported overflowing bin ${bin.bin_code} (${bin.fill_level_pct}% full) at ${bin.address}.`,
        lat: bin.lat,
        lng: bin.lng,
        locationSource: geo.lat ? 'gps' : 'manual',
        address: bin.address,
        ward: bin.ward,
        severity: 'high',
      }),
    });
    setMsg(`Overflow report submitted for ${bin.bin_code}.`);
    onRefresh();
  };

  const handleLogSegregation = async () => {
    if (!user) return onRequireAuth();
    await apiFetch('/api/waste/segregation-log', {
      method: 'POST',
      body: JSON.stringify({ itemNote: segNote }),
    });
    setMsg('Segregation activity logged (+25 verified points).');
    onRefresh();
  };

  const handleUpdateCollection = async (colId: string, status: 'in_progress' | 'completed' | 'missed') => {
    await apiFetch(`/api/waste/collections/${colId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    setMsg(`Collection task marked ${status}.`);
    onRefresh();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white">
            Intelligent Waste Management
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Smart bin fill monitoring, AI segregation classification, sanitation routing, and ward rewards.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg self-start">
          {(
            [
              ['bins', 'Smart Bins & Centres'],
              ['classify', 'AI Waste Classifier'],
              ['rewards', 'Rewards & Guide'],
              ['operations', 'Sanitation Operations'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setSubTab(k)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                subTab === k
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-300">
          {msg}
        </div>
      )}

      {subTab === 'bins' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-display font-semibold text-slate-900 dark:text-white">
              Public Smart Bins &amp; Sensor Telemetry
            </h3>
          </div>

          {bins.length === 0 ? (
            <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500">
              No smart bins registered yet. Use the AI Waste Classifier or Sanitation Operations to add records.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {bins.map((b) => (
              <div
                key={b.id}
                className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
              >
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="font-mono">
                    {b.bin_code} · {b.waste_type.toUpperCase()} ·{' '}
                    {b.sensor_type === 'simulated' ? 'Simulated Sensor' : 'Ultrasonic IoT'}
                  </span>
                  <span
                    className={`font-semibold ${
                      b.status === 'overflowing'
                        ? 'text-red-600 dark:text-red-400'
                        : b.status === 'nearly_full'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {b.status.replace('_', ' ').toUpperCase()}
                  </span>
                </div>

                <div className="text-sm font-semibold text-slate-900 dark:text-white">{b.address}</div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500">Fill Level</span>
                    <span className="font-mono tabular-nums font-semibold">{b.fill_level_pct}%</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        b.fill_level_pct >= 88
                          ? 'bg-red-600'
                          : b.fill_level_pct >= 70
                            ? 'bg-amber-500'
                            : 'bg-emerald-600'
                      }`}
                      style={{ width: `${b.fill_level_pct}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                  <span className="font-mono tabular-nums">
                    Battery {b.battery_pct}% · {b.capacity_l}L
                  </span>
                  <button
                    type="button"
                    onClick={() => handleReportOverflow(b)}
                    className="text-emerald-700 dark:text-emerald-400 font-medium hover:underline cursor-pointer"
                  >
                    Report Overflow
                  </button>
                </div>
              </div>
              ))}
            </div>
          )}

          <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <h3 className="text-base font-display font-semibold text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Recycle className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              Verified Recycling &amp; E-Waste Drop-Off Centres
            </h3>
            {recyclingCentres.length === 0 ? (
              <p className="text-xs text-slate-500">No recycling centres registered in the database yet.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {recyclingCentres.map((rc) => (
                  <div key={rc.id} className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 text-xs space-y-1">
                    <div className="font-semibold text-sm text-slate-900 dark:text-white">{rc.name}</div>
                    <div className="text-slate-500">
                      {rc.address} · {rc.hours}
                    </div>
                    <div className="text-emerald-700 dark:text-emerald-400 pt-1">
                      Accepts: {rc.acceptedTypes.join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'classify' && (
        <form
          onSubmit={handleClassify}
          className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 max-w-2xl"
        >
          <h3 className="text-lg font-display font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-emerald-700 dark:text-emerald-400" />
            AI Waste Segregation Assistant
          </h3>
          <p className="text-xs text-slate-500">
            Upload an item photo or describe the waste item to identify whether it belongs in Wet, Dry, Plastic, Paper, Glass, Metal, or E-waste.
          </p>
          <input
            type="text"
            value={wasteItemDesc}
            onChange={(e) => setWasteItemDesc(e.target.value)}
            placeholder="e.g., Used lithium battery, banana peels, rinsed PET bottle..."
            className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer">
              <Upload className="w-4 h-4" />
              <span>{wastePhotoBase64 ? 'Photo Selected' : 'Upload Item Photo'}</span>
              <input type="file" accept="image/*" onChange={handleWasteImageSelect} className="hidden" />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
            >
              {busy ? 'Classifying...' : 'Classify Waste Item'}
            </button>
          </div>

          {aiClassResult && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
              <div className="flex items-center justify-between font-semibold text-sm text-slate-900 dark:text-white">
                <span>
                  {aiClassResult.category} → {aiClassResult.recommendedBin}
                </span>
                <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                  {Math.round((aiClassResult.confidence || 0) * 100)}%
                </span>
              </div>
              {aiClassResult.uncertain && (
                <div className="text-amber-700 dark:text-amber-400 font-medium">
                  Note: Classification confidence is moderate — verify local municipal label before disposal.
                </div>
              )}
              <p className="text-slate-600 dark:text-slate-300">{aiClassResult.explanation}</p>
              {aiClassResult.disposalSteps && aiClassResult.disposalSteps.length > 0 && (
                <ul className="list-disc pl-4 space-y-1 text-slate-600 dark:text-slate-400">
                  {aiClassResult.disposalSteps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </form>
      )}

      {subTab === 'rewards' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Award className="w-5 h-5 text-emerald-700 dark:text-emerald-400" />
                Household Segregation Points
              </h3>
              <span className="text-xl font-display font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {myRewards?.points ?? 0} pts
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={segNote}
                onChange={(e) => setSegNote(e.target.value)}
                className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <button
                type="button"
                onClick={handleLogSegregation}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
              >
                Log +25 pts
              </button>
            </div>
            <div className="text-xs text-slate-500">
              Streak: {myRewards?.streak_days ?? 0} days · Badges: {(myRewards?.badges || []).join(', ') || 'Starter'}
            </div>
          </div>

          <div className="lg:col-span-6 bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
            <h3 className="text-base font-display font-semibold text-slate-900 dark:text-white mb-3">
              Ward Cleanliness Leaderboard
            </h3>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {leaderboard.map((row, idx) => (
                <div key={idx} className="py-2.5 flex items-center justify-between">
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {idx + 1}. {row.name}
                  </span>
                  <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                    {row.points} pts · {row.streak_days}d streak
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {subTab === 'operations' && (
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-display font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-emerald-700 dark:text-emerald-400" />
            Scheduled Sanitation Collection Tasks
          </h3>
          {collections.length === 0 ? (
            <p className="text-xs text-slate-500">No collection tasks scheduled yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {collections.map((col) => (
                <div key={col.id} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono text-slate-500">
                      {col.bin_code} · Vehicle {col.vehicle_code} · Driver: {col.driver_name}
                    </div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">{col.address}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{col.notes}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase">
                      {col.status}
                    </span>
                    {(user?.role === 'sanitation_driver' || user?.role === 'authority' || user?.role === 'admin') && col.status !== 'completed' && (
                      <button
                        type="button"
                        onClick={() => handleUpdateCollection(col.id, 'completed')}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Mark Collected
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
