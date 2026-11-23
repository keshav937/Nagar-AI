import React, { useState } from 'react';
import { ShieldCheck, Eye, Trash2, KeyRound } from 'lucide-react';
import type {
  AccessibilitySettings,
  AuthUser,
  ElevenLabsStatus,
  LanguageCode,
  VoiceSettings,
} from '../types.ts';
import { VoiceSettingsPanel } from './VoiceSettingsPanel.tsx';
import { apiFetch, setSessionToken } from '../api/client.ts';

interface ProfileSettingsProps {
  user: AuthUser | null;
  language: LanguageCode;
  onChangeLanguage: (lang: LanguageCode) => void;
  voiceSettings: VoiceSettings;
  onChangeVoiceSettings: (next: VoiceSettings) => void;
  accessibility: AccessibilitySettings;
  onChangeAccessibility: (next: AccessibilitySettings) => void;
  elevenStatus: ElevenLabsStatus | null;
  onRefreshStatus: () => void;
  onLogout: () => void;
  onOpenAuth: () => void;
}

export const ProfileSettings: React.FC<ProfileSettingsProps> = ({
  user,
  language,
  onChangeLanguage,
  voiceSettings,
  onChangeVoiceSettings,
  accessibility,
  onChangeAccessibility,
  elevenStatus,
  onRefreshStatus,
  onLogout,
  onOpenAuth,
}) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);

  const handleDeleteAccount = async () => {
    try {
      await apiFetch('/api/auth/account', { method: 'DELETE' });
      setSessionToken(null);
      onLogout();
      setStatusMsg('Account deleted and session cleared.');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Unable to delete account.');
    }
  };

  const handleRotateRecoveryKey = async () => {
    try {
      const res = await apiFetch<{ recoveryKey: string }>('/api/auth/regenerate-recovery-key', {
        method: 'POST',
      });
      setNewRecoveryKey(res.recoveryKey);
      setStatusMsg('New personal recovery key generated. Save it securely.');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Failed to rotate recovery key.');
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-2xl font-display font-bold text-slate-950 dark:text-white">
          Profile, Accessibility &amp; Voice Settings
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Manage your language preferences, recovery credentials, Nagar Saathi ElevenLabs voice engine, and privacy controls.
        </p>
      </div>

      {statusMsg && (
        <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-200">
          {statusMsg}
        </div>
      )}

      {user ? (
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-xs text-emerald-700 dark:text-emerald-400 font-medium uppercase">
                Authenticated Account · {user.role.replace('_', ' ')}
              </div>
              <h3 className="text-lg font-display font-bold text-slate-900 dark:text-white mt-0.5">{user.name}</h3>
              <div className="text-xs text-slate-500">
                {user.email}
                {user.phone ? ` · ${user.phone}` : ''} · User ID: <span className="font-mono">{user.id}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRotateRecoveryKey}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5" />
                Rotate Recovery Key
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                Sign Out
              </button>
            </div>
          </div>

          {newRecoveryKey && (
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs">
              New Recovery Key: <code className="font-mono font-bold tracking-wider">{newRecoveryKey}</code> (your previous key is now invalidated).
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex items-center justify-between">
          <div className="text-sm text-slate-600 dark:text-slate-300">
            Sign in or register an account to persist voice, safety, and accessibility preferences.
          </div>
          <button
            type="button"
            onClick={onOpenAuth}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white cursor-pointer"
          >
            Sign In / Register
          </button>
        </div>
      )}

      {/* Accessibility Controls */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <h3 className="text-base font-display font-semibold flex items-center gap-2">
          <Eye className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
          Accessibility &amp; Readability
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="flex items-center justify-between p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer">
            <div>
              <div className="text-xs font-semibold">Large Text Mode</div>
              <div className="text-[11px] text-slate-500">Increases base UI typography scale</div>
            </div>
            <input
              type="checkbox"
              checked={accessibility.largeText}
              onChange={(e) => onChangeAccessibility({ ...accessibility, largeText: e.target.checked })}
              className="accent-emerald-700"
            />
          </label>
          <label className="flex items-center justify-between p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer">
            <div>
              <div className="text-xs font-semibold">High Contrast Mode</div>
              <div className="text-[11px] text-slate-500">Boosts contrast for bright outdoor visibility</div>
            </div>
            <input
              type="checkbox"
              checked={accessibility.highContrast}
              onChange={(e) => onChangeAccessibility({ ...accessibility, highContrast: e.target.checked })}
              className="accent-emerald-700"
            />
          </label>
        </div>
      </div>

      {/* Voice Settings */}
      <VoiceSettingsPanel
        user={user}
        language={language}
        onChangeLanguage={onChangeLanguage}
        settings={voiceSettings}
        onChangeSettings={onChangeVoiceSettings}
        elevenStatus={elevenStatus}
        onRefreshStatus={onRefreshStatus}
      />

      {/* Privacy Policy, Terms & Account Deletion */}
      <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3 text-xs text-slate-600 dark:text-slate-300">
        <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
          Privacy Policy, Terms &amp; Data Controls
        </h3>
        <p>
          GPS coordinates, safety sessions, and microphone audio are captured strictly upon explicit user interaction and consent. Voice audio is streamed directly to ElevenLabs for transcription without permanent server-side audio archiving.
        </p>
        {user && (
          <div className="pt-2">
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 hover:underline cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Request Account Deletion
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-red-600 font-medium">Confirm permanent deletion?</span>
                <button
                  type="button"
                  onClick={handleDeleteAccount}
                  className="px-3 py-1 rounded bg-red-600 text-white font-semibold cursor-pointer"
                >
                  Yes, Delete Account
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-1 rounded border border-slate-300 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
