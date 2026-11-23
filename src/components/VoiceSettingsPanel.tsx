import React, { useEffect, useState } from 'react';
import { Volume2, Mic, RefreshCw, RotateCcw, CheckCircle2, AlertCircle } from 'lucide-react';
import type { AuthUser, ElevenLabsStatus, LanguageCode, VoiceOption, VoiceSettings } from '../types.ts';
import { apiFetch, getSessionToken } from '../api/client.ts';

interface VoiceSettingsPanelProps {
  user: AuthUser | null;
  language: LanguageCode;
  onChangeLanguage: (lang: LanguageCode) => void;
  settings: VoiceSettings;
  onChangeSettings: (next: VoiceSettings) => void;
  elevenStatus: ElevenLabsStatus | null;
  onRefreshStatus: () => void;
}

const DEFAULT_SETTINGS: VoiceSettings = {
  enabled: true,
  preferredLanguage: 'en',
  voiceId: '',
  speed: 1.0,
  autoPlay: true,
  continuousMode: false,
};

export const VoiceSettingsPanel: React.FC<VoiceSettingsPanelProps> = ({
  user,
  language,
  onChangeLanguage,
  settings,
  onChangeSettings,
  elevenStatus,
  onRefreshStatus,
}) => {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [micTestLevel, setMicTestLevel] = useState<number | null>(null);
  const [micStatus, setMicStatus] = useState<string>('Not tested');
  const [sttTestResult, setSttTestResult] = useState<string | null>(null);
  const [ttsTestMsg, setTtsTestMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !elevenStatus?.connected) return;
    apiFetch<{ voices: VoiceOption[] }>('/api/voice/voices')
      .then((res) => setVoices(res.voices || []))
      .catch(() => {});
  }, [user, elevenStatus?.connected]);

  const handleTestVoiceResponse = async () => {
    setTtsTestMsg('Generating ElevenLabs speech...');
    try {
      const token = getSessionToken();
      const sample =
        language === 'hi'
          ? 'नमस्ते, मैं नगर साथी हूँ। आपका स्मार्ट शहर अब आपकी आवाज़ सुन सकता है।'
          : 'Hello, I am Nagar Saathi. Your smart city services are ready to assist you.';
      const resp = await fetch('/api/voice/tts', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'NAGAR-AI',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          text: sample,
          voiceId: settings.voiceId || undefined,
          speed: settings.speed,
          language,
        }),
      });
      if (!resp.ok) {
        const err = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || 'TTS test failed');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      setTtsTestMsg('ElevenLabs voice playback succeeded.');
    } catch (err) {
      setTtsTestMsg(err instanceof Error ? err.message : 'ElevenLabs test failed.');
    }
  };

  const handleTestMicrophone = async () => {
    setMicStatus('Requesting microphone...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStatus('Granted — Sampling 2s audio level');
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const timer = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setMicTestLevel(Math.min(100, Math.round((avg / 128) * 100)));
      }, 100);
      setTimeout(() => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        setMicStatus('Microphone hardware verified');
      }, 2200);
    } catch {
      setMicStatus('Permission denied or unavailable');
    }
  };

  const handleTestStt = async () => {
    setSttTestResult('Listening for 3 seconds — please speak a short phrase...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'test.webm');
        form.append('language', language);
        const token = getSessionToken();
        const resp = await fetch('/api/voice/stt', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Requested-With': 'NAGAR-AI',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: form,
        });
        const data = (await resp.json().catch(() => ({}))) as { text?: string; error?: string; latencyMs?: number };
        if (!resp.ok) {
          setSttTestResult(`STT error: ${data.error || resp.status}`);
        } else {
          setSttTestResult(`Recognized (${data.latencyMs}ms): "${data.text || '(silence)'}"`);
        }
      };
      recorder.start();
      setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, 3000);
    } catch {
      setSttTestResult('Microphone access needed to test speech recognition.');
    }
  };

  return (
    <div className="bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h3 className="text-lg font-display font-semibold text-slate-900 dark:text-white">
            Nagar Saathi Voice & ElevenLabs Settings
          </h3>
          <p className="text-xs text-slate-500">
            Configure ElevenLabs Speech-to-Text, Multilingual TTS voice, speed, and hardware tests.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefreshStatus}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Verify Connection
        </button>
      </div>

      {/* Live Connection Status */}
      <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {elevenStatus?.connected ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          ) : (
            <AlertCircle className="w-4 h-4 text-amber-600" />
          )}
          <span className="font-medium text-slate-900 dark:text-white">
            {elevenStatus?.connected
              ? `ElevenLabs Active · Model ${elevenStatus.ttsModel} / STT ${elevenStatus.sttModel}`
              : elevenStatus?.error || 'ElevenLabs API not configured'}
          </span>
        </div>
        <span className="font-mono text-slate-500">Mic: {micStatus}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <label className="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer">
          <span className="text-xs font-medium">Enable Voice Assistant</span>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => onChangeSettings({ ...settings, enabled: e.target.checked })}
            className="accent-emerald-700"
          />
        </label>

        <label className="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer">
          <span className="text-xs font-medium">Auto-play Spoken Responses</span>
          <input
            type="checkbox"
            checked={settings.autoPlay}
            onChange={(e) => onChangeSettings({ ...settings, autoPlay: e.target.checked })}
            className="accent-emerald-700"
          />
        </label>

        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
            Preferred Voice & UI Language
          </label>
          <select
            value={language}
            onChange={(e) => {
              const nextLang = e.target.value as LanguageCode;
              onChangeLanguage(nextLang);
              onChangeSettings({ ...settings, preferredLanguage: nextLang });
            }}
            className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            <option value="en">English (en)</option>
            <option value="hi">Hindi / हिन्दी (hi)</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
            ElevenLabs Permitted Voice
          </label>
          <select
            value={settings.voiceId}
            onChange={(e) => onChangeSettings({ ...settings, voiceId: e.target.value })}
            className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            <option value="">Default Multilingual Voice</option>
            {voices.map((v) => (
              <option key={v.voiceId} value={v.voiceId}>
                {v.name} ({v.accent || v.category})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="font-medium text-slate-700 dark:text-slate-300">Speaking Speed</span>
          <span className="font-mono tabular-nums">{settings.speed.toFixed(2)}x</span>
        </div>
        <input
          type="range"
          min={0.75}
          max={1.2}
          step={0.05}
          value={settings.speed}
          onChange={(e) => onChangeSettings({ ...settings, speed: Number(e.target.value) })}
          className="w-full accent-emerald-700"
        />
      </div>

      {/* Interactive Diagnostics */}
      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={handleTestMicrophone}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
        >
          <Mic className="w-3.5 h-3.5" />
          Test Microphone
        </button>
        <button
          type="button"
          onClick={handleTestStt}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
        >
          Test Speech Recognition
        </button>
        <button
          type="button"
          onClick={handleTestVoiceResponse}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
        >
          <Volume2 className="w-3.5 h-3.5" />
          Test Voice Response
        </button>
        <button
          type="button"
          onClick={() => onChangeSettings(DEFAULT_SETTINGS)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-600 dark:text-slate-400 hover:underline cursor-pointer ml-auto"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset Defaults
        </button>
      </div>

      {micTestLevel !== null && (
        <div className="space-y-1">
          <div className="text-[11px] text-slate-500">Live Microphone Level: {micTestLevel}%</div>
          <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <div className="h-full bg-emerald-600 transition-all" style={{ width: `${micTestLevel}%` }} />
          </div>
        </div>
      )}
      {sttTestResult && <div className="text-xs text-slate-700 dark:text-slate-300">{sttTestResult}</div>}
      {ttsTestMsg && <div className="text-xs text-emerald-700 dark:text-emerald-400">{ttsTestMsg}</div>}
    </div>
  );
};
