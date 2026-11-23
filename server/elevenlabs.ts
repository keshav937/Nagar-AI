import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

export interface ElevenLabsStatus {
  configured: boolean;
  connected: boolean;
  agentConfigured: boolean;
  defaultVoiceId: string;
  ttsModel: string;
  sttModel: string;
  tier?: string;
  characterCount?: number;
  characterLimit?: number;
  error?: string;
  checkedAt: string;
}

const DEFAULT_MULTILINGUAL_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel (supports eleven_multilingual_v2)

let cachedStatus: { data: ElevenLabsStatus; expiresAt: number } | null = null;

function getApiKey(): string | null {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function getDefaultVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_MULTILINGUAL_VOICE_ID;
}

export function getTtsModelId(): string {
  return process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2';
}

export function getSttModelId(): string {
  return process.env.ELEVENLABS_STT_MODEL_ID?.trim() || 'scribe_v1';
}

export function getAgentId(): string | null {
  const id = process.env.ELEVENLABS_AGENT_ID?.trim();
  return id && id.length > 0 ? id : null;
}

export async function checkElevenLabsStatus(forceRefresh = false): Promise<ElevenLabsStatus> {
  if (!forceRefresh && cachedStatus && Date.now() < cachedStatus.expiresAt) {
    return cachedStatus.data;
  }

  const apiKey = getApiKey();
  const base: ElevenLabsStatus = {
    configured: Boolean(apiKey),
    connected: false,
    agentConfigured: Boolean(getAgentId()),
    defaultVoiceId: getDefaultVoiceId(),
    ttsModel: getTtsModelId(),
    sttModel: getSttModelId(),
    checkedAt: new Date().toISOString(),
  };

  if (!apiKey) {
    base.error = 'ELEVENLABS_API_KEY is not configured in server environment secrets.';
    cachedStatus = { data: base, expiresAt: Date.now() + 15_000 };
    return base;
  }

  try {
    const resp = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(6000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      base.error = `ElevenLabs API check failed (${resp.status}): ${errText.slice(0, 140) || resp.statusText}`;
      cachedStatus = { data: base, expiresAt: Date.now() + 15_000 };
      return base;
    }

    const sub = (await resp.json()) as {
      tier?: string;
      character_count?: number;
      character_limit?: number;
    };

    const result: ElevenLabsStatus = {
      ...base,
      connected: true,
      tier: sub.tier,
      characterCount: sub.character_count,
      characterLimit: sub.character_limit,
    };
    cachedStatus = { data: result, expiresAt: Date.now() + 60_000 };
    return result;
  } catch (err) {
    base.error = err instanceof Error ? err.message : 'Unable to reach ElevenLabs API.';
    cachedStatus = { data: base, expiresAt: Date.now() + 15_000 };
    return base;
  }
}

export interface VoiceOption {
  voiceId: string;
  name: string;
  category: string;
  accent?: string;
  gender?: string;
  description?: string;
  previewUrl?: string;
  supportsMultilingual: boolean;
}

export async function listPermittedVoices(): Promise<{ voices: VoiceOption[]; error?: string }> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { voices: [], error: 'ELEVENLABS_API_KEY is not configured.' };
  }

  try {
    const client = new ElevenLabsClient({ apiKey });
    const response = await client.voices.getAll();
    const list = (response.voices || []).slice(0, 24).map((v) => ({
      voiceId: v.voiceId,
      name: v.name || 'Unnamed Voice',
      category: v.category || 'premade',
      accent: v.labels?.accent,
      gender: v.labels?.gender,
      description: v.labels?.description || v.description || undefined,
      previewUrl: v.previewUrl || undefined,
      supportsMultilingual: true,
    }));
    return { voices: list };
  } catch (err) {
    return {
      voices: [],
      error: err instanceof Error ? err.message : 'Failed to fetch ElevenLabs voices.',
    };
  }
}

export async function transcribeWithElevenLabs(
  audioBuffer: Buffer,
  mimeType: string,
  language?: 'en' | 'hi' | 'auto'
): Promise<{ text: string; languageCode: string; latencyMs: number }> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('ELEVENLABS_NOT_CONFIGURED');
  }

  const startedAt = Date.now();
  const form = new FormData();
  const ext = mimeType.includes('webm')
    ? 'webm'
    : mimeType.includes('ogg')
      ? 'ogg'
      : mimeType.includes('wav')
        ? 'wav'
        : mimeType.includes('mp4') || mimeType.includes('m4a')
          ? 'm4a'
          : 'mp3';

  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType || 'audio/webm' });
  form.append('file', blob, `speech.${ext}`);
  form.append('model_id', getSttModelId());
  if (language === 'en') form.append('language_code', 'eng');
  if (language === 'hi') form.append('language_code', 'hin');

  const resp = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
    },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`ElevenLabs STT failed (${resp.status}): ${body.slice(0, 200)}`);
    (err as Error & { statusCode?: number }).statusCode = resp.status;
    throw err;
  }

  const data = (await resp.json()) as {
    text?: string;
    language_code?: string;
  };

  return {
    text: (data.text || '').trim(),
    languageCode: data.language_code || (language === 'hi' ? 'hin' : 'eng'),
    latencyMs: Date.now() - startedAt,
  };
}

export async function synthesizeSpeechStream(
  text: string,
  options: {
    voiceId?: string;
    speed?: number;
    language?: 'en' | 'hi';
  }
): Promise<Response> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('ELEVENLABS_NOT_CONFIGURED');
  }

  const voiceId = options.voiceId?.trim() || getDefaultVoiceId();
  const clampedSpeed = Math.min(1.2, Math.max(0.7, Number(options.speed) || 1.0));
  const modelId = getTtsModelId();

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?optimize_streaming_latency=2`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.slice(0, 2500),
        model_id: modelId,
        voice_settings: {
          stability: 0.52,
          similarity_boost: 0.78,
          style: 0.15,
          use_speaker_boost: true,
          speed: clampedSpeed,
        },
      }),
      signal: AbortSignal.timeout(25_000),
    }
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`ElevenLabs TTS failed (${resp.status}): ${body.slice(0, 200)}`);
    (err as Error & { statusCode?: number }).statusCode = resp.status;
    throw err;
  }

  return resp;
}

export async function getConvAiSignedUrl(): Promise<{ signedUrl: string; agentId: string }> {
  const apiKey = getApiKey();
  const agentId = getAgentId();
  if (!apiKey) throw new Error('ELEVENLABS_NOT_CONFIGURED');
  if (!agentId) throw new Error('ELEVENLABS_AGENT_NOT_CONFIGURED');

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
    {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs ConvAI signed URL error (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { signed_url: string };
  return { signedUrl: data.signed_url, agentId };
}
