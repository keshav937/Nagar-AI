import React, { useState, useRef, useEffect } from 'react';
import {
  Mic,
  Square,
  X,
  Volume2,
  VolumeX,
  Pause,
  Play,
  RotateCcw,
  Send,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import type {
  AuthUser,
  ElevenLabsStatus,
  GeoLocationState,
  LanguageCode,
  VoiceSettings,
} from '../types.ts';
import { t } from '../i18n/translations.ts';
import { apiFetch } from '../api/client.ts';
import { useVoiceEngine } from '../hooks/useVoiceEngine.ts';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  toolsUsed?: string[];
  pendingAction?: Record<string, unknown>;
}

interface NagarSaathiPanelProps {
  user: AuthUser | null;
  language: LanguageCode;
  onChangeLanguage: (lang: LanguageCode) => void;
  activeModule: string;
  geo: GeoLocationState;
  onRequestGps: () => Promise<GeoLocationState | null>;
  voiceSettings: VoiceSettings;
  onUpdateVoiceSettings: (next: VoiceSettings) => void;
  elevenStatus: ElevenLabsStatus | null;
  isOpen: boolean;
  onToggleOpen: (open: boolean) => void;
  onNavigateModule: (dest: string) => void;
  onRefreshCityData: () => void;
  onRequireAuth: () => void;
}

export const NagarSaathiPanel: React.FC<NagarSaathiPanelProps> = ({
  user,
  language,
  onChangeLanguage,
  activeModule,
  geo,
  onRequestGps,
  voiceSettings,
  onUpdateVoiceSettings,
  elevenStatus,
  isOpen,
  onToggleOpen,
  onNavigateModule,
  onRefreshCityData,
  onRequireAuth,
}) => {
  const copy = t(language);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draftText, setDraftText] = useState('');
  const [editableTranscript, setEditableTranscript] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const sendMessageToSaathi = async (textToSend: string) => {
    const clean = textToSend.trim();
    if (!clean) return;
    if (!user) {
      onRequireAuth();
      return;
    }

    setChatError(null);
    setEditableTranscript(null);
    setDraftText('');

    const userMsg: ChatMessage = {
      id: `m-${Date.now()}`,
      role: 'user',
      text: clean,
      timestamp: new Date().toISOString(),
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    voice.setVoiceState('thinking');

    try {
      const res = await apiFetch<{
        reply: string;
        navigationTarget?: string;
        pendingAction?: Record<string, unknown>;
        createdReport?: Record<string, unknown>;
        toolsUsed?: string[];
      }>('/api/saathi/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: clean,
          history: nextHistory.slice(-8).map((m) => ({ role: m.role, text: m.text })),
          language,
          activeModule,
          location:
            geo.lat !== null && geo.lng !== null
              ? { lat: geo.lat, lng: geo.lng, address: geo.address }
              : null,
        }),
      });

      const assistantMsg: ChatMessage = {
        id: `m-${Date.now() + 1}`,
        role: 'assistant',
        text: res.reply,
        timestamp: new Date().toISOString(),
        toolsUsed: res.toolsUsed,
        pendingAction: res.pendingAction,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      if (res.navigationTarget) {
        onNavigateModule(res.navigationTarget);
      }
      if (res.createdReport) {
        onRefreshCityData();
      }

      if (voiceSettings.enabled && voiceSettings.autoPlay && elevenStatus?.connected) {
        await voice.speakWithElevenLabs(res.reply, language);
      } else {
        voice.setVoiceState('idle');
      }
    } catch (err) {
      voice.setVoiceState('error');
      setChatError(err instanceof Error ? err.message : 'Unable to reach Nagar Saathi.');
    }
  };

  const voice = useVoiceEngine({
    settings: { ...voiceSettings, preferredLanguage: language },
    onTranscriptReady: (recognizedText, autoSubmit) => {
      if (autoSubmit) {
        sendMessageToSaathi(recognizedText);
      } else {
        setEditableTranscript(recognizedText);
      }
    },
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, editableTranscript, voice.voiceState]);

  const handleConfirmPendingAction = async (action: Record<string, unknown>) => {
    if (!user) return onRequireAuth();
    const confirmPhrase =
      language === 'hi'
        ? `हाँ, कृपया इस शिकायत (${String(action.category || action.binCode || '')}) को अभी सबमिट करें।`
        : `Yes, please confirm and submit this ${String(action.category || 'waste')} report now.`;
    await sendMessageToSaathi(confirmPhrase);
  };

  const handleMicPress = async () => {
    if (!user) return onRequireAuth();
    if (voice.voiceState === 'listening') {
      voice.stopListening();
      return;
    }
    if (!geo.lat) {
      onRequestGps().catch(() => {});
    }
    await voice.startListening();
  };

  const handleClear = () => {
    voice.stopSpeaking(false);
    setMessages([]);
    setEditableTranscript(null);
    setChatError(null);
    voice.setVoiceError(null);
  };

  const handleEndConversation = () => {
    voice.cancelListening();
    voice.stopSpeaking(false);
    onToggleOpen(false);
  };

  const contextualPrompts =
    language === 'hi'
      ? activeModule === 'mobility'
        ? ['मेरे पास साझा ऑटो खोजें', 'कनॉट प्लेस के लिए रूट दिखाएं']
        : activeModule === 'waste'
          ? ['सबसे नज़दीकी कचरा बिन कहाँ है?', 'गीला और सूखा कचरा कैसे अलग करें?']
          : ['मेरे पास सड़क पर गड्ढे की शिकायत दर्ज करें', 'मेरी शिकायत की स्थिति क्या है?']
      : activeModule === 'mobility'
        ? ['Find shared autos near me', 'Show transport options to Connaught Place']
        : activeModule === 'waste'
          ? ['Where is the nearest garbage bin?', 'Explain wet and dry waste segregation']
          : ['Report a pothole near my current location', 'What is happening with my complaint?'];

  return (
    <>
      {/* Floating NAGAR SAATHI Trigger Button */}
      {!isOpen && (
        <button
          type="button"
          onClick={() => onToggleOpen(true)}
          aria-label="Open Nagar Saathi Voice Companion"
          className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2.5 px-4 py-3 rounded-full bg-emerald-700 text-white shadow-lg hover:bg-emerald-800 transition-transform active:scale-95 cursor-pointer"
        >
          <Mic className="w-5 h-5" />
          <span className="text-sm font-display font-semibold whitespace-nowrap">{copy.saathiName}</span>
        </button>
      )}

      {/* Conversational Drawer / Panel */}
      {isOpen && (
        <aside
          role="dialog"
          aria-label="Nagar Saathi Voice Assistant"
          className="fixed bottom-0 right-0 sm:bottom-5 sm:right-5 z-50 w-full sm:w-[430px] h-[85vh] sm:h-[640px] max-h-[92vh] bg-[#F8FAF9] dark:bg-[#0E1512] border border-slate-200 dark:border-slate-800 sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="px-4 py-3.5 bg-white dark:bg-[#111916] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-display font-bold text-slate-950 dark:text-white">{copy.saathiName}</h3>
                <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                  · {activeModule}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{copy.saathiTagline}</p>
            </div>

            <div className="flex items-center gap-1.5">
              <select
                aria-label="Voice Language"
                value={language}
                onChange={(e) => onChangeLanguage(e.target.value as LanguageCode)}
                className="px-2 py-1 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
              >
                <option value="en">EN</option>
                <option value="hi">हिन्दी</option>
              </select>

              <button
                type="button"
                onClick={() => voice.setIsMuted(!voice.isMuted)}
                aria-label={voice.isMuted ? 'Unmute audio' : 'Mute audio'}
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                {voice.isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>

              <button
                type="button"
                onClick={handleClear}
                aria-label="Clear conversation"
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={handleEndConversation}
                aria-label="End conversation"
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Connection & Voice State Bar */}
          <div className="px-4 py-2 bg-slate-50 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px]">
            <span
              aria-live="polite"
              className={`font-medium ${
                voice.voiceState === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : voice.voiceState === 'listening' || voice.voiceState === 'speaking'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {copy.voiceStates[voice.voiceState]}
            </span>
            <span className="text-slate-500">
              {elevenStatus?.connected ? 'ElevenLabs Connected' : 'ElevenLabs Unconfigured'}
            </span>
          </div>

          {!elevenStatus?.connected && (
            <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-[11px] text-amber-800 dark:text-amber-300">
              {elevenStatus?.configured
                ? `ElevenLabs check failed: ${elevenStatus.error}`
                : 'ELEVENLABS_API_KEY not set on server. Text chat with Nagar Saathi works fully; configure key in Secrets for live ElevenLabs STT/TTS.'}
            </div>
          )}

          {/* Transcript Feed */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="space-y-3 py-4">
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  {language === 'hi'
                    ? 'आप सीधे माइक दबाकर बोल सकते हैं या नीचे दिए गए सुझावों में से चुन सकते हैं:'
                    : 'Tap the microphone to speak naturally in English or Hindi, or choose a quick city request:'}
                </p>
                <div className="flex flex-col gap-2">
                  {contextualPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => sendMessageToSaathi(prompt)}
                      className="text-left px-3.5 py-2.5 text-xs rounded-xl bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 hover:border-emerald-600 text-slate-800 dark:text-slate-200 cursor-pointer"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-emerald-700 text-white rounded-br-sm'
                      : 'bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-bl-sm'
                  }`}
                >
                  {m.text}
                  {m.toolsUsed && m.toolsUsed.length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      <span>Data: {m.toolsUsed.join(', ')}</span>
                    </div>
                  )}
                </div>

                {m.pendingAction && (
                  <div className="mt-2 w-[88%] p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs space-y-2">
                    <div className="font-semibold text-emerald-900 dark:text-emerald-200">
                      Confirm Submission Details
                    </div>
                    <div className="text-emerald-800 dark:text-emerald-300">
                      {String(m.pendingAction.category || 'Waste Report')} · {String(m.pendingAction.address || '')}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleConfirmPendingAction(m.pendingAction!)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Confirm & Submit
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Editable Transcript Review Box (prevents premature auto-submission) */}
          {editableTranscript !== null && (
            <div className="px-4 py-2.5 bg-emerald-50 dark:bg-emerald-950/40 border-t border-emerald-200 dark:border-emerald-800 space-y-2">
              <div className="text-[11px] font-medium text-emerald-900 dark:text-emerald-300">
                Review & edit recognized speech before sending:
              </div>
              <textarea
                rows={2}
                value={editableTranscript}
                onChange={(e) => setEditableTranscript(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditableTranscript(null)}
                  className="px-3 py-1 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => sendMessageToSaathi(editableTranscript)}
                  className="px-3 py-1 text-xs font-semibold rounded-lg bg-emerald-700 text-white cursor-pointer"
                >
                  Send to Nagar Saathi
                </button>
              </div>
            </div>
          )}

          {(voice.voiceError || chatError) && (
            <div className="px-4 py-2 bg-red-50 dark:bg-red-950/40 border-t border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{voice.voiceError || chatError}</span>
            </div>
          )}

          {/* Voice Control Deck + Audio-Reactive Waveform + Text Fallback */}
          <div className="p-4 bg-white dark:bg-[#111916] border-t border-slate-200 dark:border-slate-800 space-y-3">
            {/* Real Web Audio Analyser Waveform */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-0.5 h-8 flex-1 px-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                {voice.waveformBars.map((level, i) => (
                  <div
                    key={i}
                    className={`flex-1 rounded-full transition-transform duration-75 ${
                      voice.voiceState === 'listening' || voice.voiceState === 'speaking'
                        ? 'bg-emerald-600 dark:bg-emerald-400'
                        : 'bg-slate-300 dark:bg-slate-700'
                    }`}
                    style={{ height: `${Math.max(12, Math.round(level * 100))}%` }}
                  />
                ))}
              </div>

              {/* Playback Controls */}
              <div className="flex items-center gap-1">
                {voice.voiceState === 'speaking' && (
                  <>
                    <button
                      type="button"
                      onClick={voice.togglePauseSpeaking}
                      aria-label={voice.isPaused ? 'Resume audio' : 'Pause audio'}
                      className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
                    >
                      {voice.isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => voice.stopSpeaking(false)}
                      aria-label="Stop speaking"
                      className="p-2 rounded-lg border border-red-200 dark:border-red-900 text-red-600 cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                {voice.lastAudioUrl && voice.voiceState !== 'speaking' && (
                  <button
                    type="button"
                    onClick={voice.replayLastAudio}
                    aria-label="Replay last response"
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Large Circular Mic + Text Alternative */}
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={handleMicPress}
                aria-label={voice.voiceState === 'listening' ? 'Stop recording' : 'Start speaking'}
                className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                  voice.voiceState === 'listening'
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'bg-emerald-700 text-white hover:bg-emerald-800'
                }`}
              >
                {voice.voiceState === 'listening' ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>

              {voice.voiceState === 'listening' ? (
                <div className="flex-1 flex items-center justify-between px-3 py-2 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs">
                  <span className="font-medium text-red-700 dark:text-red-300">Recording speech...</span>
                  <button
                    type="button"
                    onClick={voice.cancelListening}
                    className="font-semibold text-red-700 dark:text-red-300 underline cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendMessageToSaathi(draftText);
                  }}
                  className="flex-1 flex items-center gap-1.5"
                >
                  <input
                    type="text"
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    placeholder={copy.saathiAskPlaceholder}
                    className="flex-1 px-3 py-2.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:outline-none focus:border-emerald-600"
                  />
                  <button
                    type="submit"
                    aria-label="Send message"
                    className="p-2.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 cursor-pointer"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              )}
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={voiceSettings.continuousMode}
                  onChange={(e) =>
                    onUpdateVoiceSettings({ ...voiceSettings, continuousMode: e.target.checked })
                  }
                  className="accent-emerald-700"
                />
                <span>Auto-submit speech (Continuous Mode)</span>
              </label>
              <span>Mic: {voice.micPermission}</span>
            </div>
          </div>
        </aside>
      )}
    </>
  );
};
