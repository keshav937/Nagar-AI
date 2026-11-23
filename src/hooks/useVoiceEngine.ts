import { useState, useRef, useCallback, useEffect } from 'react';
import type { LanguageCode, VoiceSettings, VoiceState } from '../types.ts';
import { getSessionToken } from '../api/client.ts';

interface UseVoiceEngineOptions {
  settings: VoiceSettings;
  onTranscriptReady: (text: string, autoSubmit: boolean) => void;
}

export function useVoiceEngine({ settings, onTranscriptReady }: UseVoiceEngineOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [micPermission, setMicPermission] = useState<'prompt' | 'granted' | 'denied' | 'unsupported'>('prompt');
  const [isMuted, setIsMuted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [waveformBars, setWaveformBars] = useState<number[]>(() => new Array(24).fill(0.08));
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [lastAudioUrl, setLastAudioUrl] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const cancelledRecordingRef = useRef(false);

  const stopWaveformLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setAudioLevel(0);
    setWaveformBars(new Array(24).fill(0.08));
  }, []);

  const startWaveformLoop = useCallback((analyser: AnalyserNode) => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const step = Math.max(1, Math.floor(data.length / 24));
      const bars: number[] = [];
      let sum = 0;
      for (let i = 0; i < 24; i++) {
        const val = (data[i * step] || 0) / 255;
        sum += val;
        bars.push(Math.max(0.08, Math.min(1, val * 1.35)));
      }
      setAudioLevel(sum / 24);
      setWaveformBars(bars);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const cleanupMicStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    stopWaveformLoop();
  }, [stopWaveformLoop]);

  const stopSpeaking = useCallback(
    (asInterrupt = false) => {
      if (ttsAbortRef.current) {
        ttsAbortRef.current.abort();
        ttsAbortRef.current = null;
      }
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.currentTime = 0;
      }
      setIsPaused(false);
      stopWaveformLoop();
      setVoiceState(asInterrupt ? 'interrupted' : 'idle');
    },
    [stopWaveformLoop]
  );

  const togglePauseSpeaking = useCallback(() => {
    const el = audioElRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
      setIsPaused(false);
      setVoiceState('speaking');
    } else {
      el.pause();
      setIsPaused(true);
    }
  }, []);

  const replayLastAudio = useCallback(() => {
    if (!lastAudioUrl) return;
    stopSpeaking(false);
    const audio = new Audio(lastAudioUrl);
    audioElRef.current = audio;
    setVoiceState('speaking');
    audio.onended = () => {
      stopWaveformLoop();
      setVoiceState('idle');
    };
    audio.onerror = () => {
      setVoiceState('error');
      setVoiceError('Unable to replay audio clip.');
    };
    audio.play().catch(() => setVoiceState('idle'));
  }, [lastAudioUrl, stopSpeaking, stopWaveformLoop]);

  const speakWithElevenLabs = useCallback(
    async (text: string, language: LanguageCode): Promise<void> => {
      if (!settings.enabled || isMuted || !text.trim()) {
        setVoiceState('idle');
        return;
      }

      stopSpeaking(false);
      setVoiceError(null);
      setVoiceState('connecting');

      const controller = new AbortController();
      ttsAbortRef.current = controller;

      try {
        const token = getSessionToken();
        const resp = await fetch('/api/voice/tts', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'NAGAR-AI',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            text,
            voiceId: settings.voiceId || undefined,
            speed: settings.speed,
            language,
          }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const errJson = (await resp.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error || `ElevenLabs TTS error (${resp.status})`);
        }

        const blob = await resp.blob();
        if (controller.signal.aborted) return;

        const objectUrl = URL.createObjectURL(blob);
        setLastAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });

        const audio = new Audio(objectUrl);
        audioElRef.current = audio;

        try {
          if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
            audioCtxRef.current = new AudioContext();
          }
          if (audioCtxRef.current.state === 'suspended') {
            await audioCtxRef.current.resume();
          }
          const src = audioCtxRef.current.createMediaElementSource(audio);
          const analyser = audioCtxRef.current.createAnalyser();
          analyser.fftSize = 64;
          src.connect(analyser);
          analyser.connect(audioCtxRef.current.destination);
          analyserRef.current = analyser;
          startWaveformLoop(analyser);
        } catch {
          // Audio playback proceeds even if WebAudio visualizer fails in restricted iframe
        }

        setVoiceState('speaking');
        setIsPaused(false);

        await new Promise<void>((resolve) => {
          audio.onended = () => {
            stopWaveformLoop();
            setVoiceState('idle');
            resolve();
          };
          audio.onerror = () => {
            stopWaveformLoop();
            setVoiceState('error');
            setVoiceError('Audio playback failed.');
            resolve();
          };
          audio.play().catch((e) => {
            stopWaveformLoop();
            setVoiceState('error');
            setVoiceError(e instanceof Error ? e.message : 'Browser blocked audio playback.');
            resolve();
          });
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setVoiceState('error');
        setVoiceError(err instanceof Error ? err.message : 'ElevenLabs speech synthesis unavailable.');
      }
    },
    [settings.enabled, settings.voiceId, settings.speed, isMuted, stopSpeaking, startWaveformLoop, stopWaveformLoop]
  );

  const startListening = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setMicPermission('unsupported');
      setVoiceState('error');
      setVoiceError('Microphone capture is not supported in this browser. Please use the text input.');
      return;
    }

    // Barge-in: if currently speaking, interrupt immediately!
    if (voiceState === 'speaking') {
      stopSpeaking(true);
    }

    setVoiceError(null);
    cancelledRecordingRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      setMicPermission('granted');
      streamRef.current = stream;

      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContext();
      }
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
      const source = audioCtxRef.current.createMediaStreamSource(stream);
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;
      startWaveformLoop(analyser);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        const wasCancelled = cancelledRecordingRef.current;
        const recordedMime = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: recordedMime });
        cleanupMicStream();

        if (wasCancelled || blob.size < 400) {
          setVoiceState('idle');
          return;
        }

        setVoiceState('processing');
        try {
          const form = new FormData();
          form.append('audio', blob, 'speech.webm');
          form.append('language', settings.preferredLanguage);

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

          const data = (await resp.json().catch(() => ({}))) as { text?: string; error?: string };
          if (!resp.ok) {
            throw new Error(data.error || `Transcription failed (${resp.status})`);
          }
          if (!data.text) {
            setVoiceState('idle');
            setVoiceError('No clear speech detected. Please speak closer to the microphone or type below.');
            return;
          }

          setVoiceState('idle');
          onTranscriptReady(data.text, settings.continuousMode);
        } catch (err) {
          setVoiceState('error');
          setVoiceError(err instanceof Error ? err.message : 'ElevenLabs speech recognition failed.');
        }
      };

      recorder.start(250);
      setVoiceState('listening');
    } catch (err) {
      setMicPermission('denied');
      setVoiceState('error');
      setVoiceError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone permission denied. You can grant mic access in browser settings or type your request below.'
          : 'Could not access microphone. Please use text input.'
      );
      cleanupMicStream();
    }
  }, [voiceState, stopSpeaking, startWaveformLoop, cleanupMicStream, settings.preferredLanguage, settings.continuousMode, onTranscriptReady]);

  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      cleanupMicStream();
      setVoiceState('idle');
    }
  }, [cleanupMicStream]);

  const cancelListening = useCallback(() => {
    cancelledRecordingRef.current = true;
    stopListening();
  }, [stopListening]);

  useEffect(() => {
    return () => {
      cancelledRecordingRef.current = true;
      if (ttsAbortRef.current) ttsAbortRef.current.abort();
      if (audioElRef.current) audioElRef.current.pause();
      cleanupMicStream();
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, [cleanupMicStream]);

  return {
    voiceState,
    setVoiceState,
    micPermission,
    isMuted,
    setIsMuted,
    isPaused,
    audioLevel,
    waveformBars,
    voiceError,
    setVoiceError,
    lastAudioUrl,
    startListening,
    stopListening,
    cancelListening,
    speakWithElevenLabs,
    stopSpeaking,
    togglePauseSpeaking,
    replayLastAudio,
  };
}
