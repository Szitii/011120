/**
 * Voice messages: the voices an Owner can pick for a Companion, the speech provider that says a
 * Companion's message aloud, and the speech recognition that turns the Owner's recordings into text.
 *
 * The voices are a config file (backend/config/voices.json, or the path in VOICES_FILE), like the
 * model catalog: adding or removing a voice needs no code change. The API key never goes in the
 * file; the provider names the environment variable that holds it. Without the key there are no
 * voice messages (the dev host speaks silence and "hears" a fixed sentence instead, so the app can
 * be built without a key).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The tones a voice message can take; the speech provider's own names. */
export const EMOTIONS = ["happy", "sad", "angry", "surprised", "calm", "fearful"] as const;
export type Emotion = typeof EMOTIONS[number];

export interface VoiceEntry {
  /** What the Owner's setting stores. */
  readonly id: string;
  readonly name: string;
  readonly gender: "FEMALE" | "MALE";
  readonly description: string;
  /** The provider's own voice id. */
  readonly providerVoice: string;
}

export interface VoiceFile {
  readonly provider: { readonly kind: "minimax"; readonly baseUrl: string; readonly apiKeyEnv: string; readonly model: string };
  /** What GET /v0/voices/{id}/sample says. */
  readonly sampleText: string;
  readonly voices: readonly VoiceEntry[];
}

/** One spoken message. */
export interface Clip {
  readonly bytes: Uint8Array;
  readonly mime: "audio/mpeg" | "audio/wav";
  readonly durationMs: number;
  /** What the provider billed. */
  readonly characters: number;
}

/** Why the speech provider made no clip. `code` is safe to log: a status, never the provider's own words. */
export class SpeechError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Something that can say a text in a voice. `signal` aborts when it takes too long: pass it on. */
export interface Speaker {
  speak(text: string, voice: VoiceEntry, emotion: Emotion | null, signal: AbortSignal): Promise<Clip>;
}

/** Recordings the Owner may send, by type; the speech recognition takes all of them. */
export const RECORDING_TYPES = { "audio/mp4": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" } as const;
export type RecordingType = keyof typeof RECORDING_TYPES;

/** What was said in a recording, and how long it is (ms; 0 when the provider did not say). */
export interface Heard { readonly text: string; readonly durationMs: number }

/** Something that can turn a recording into text. `signal` aborts when it takes too long: pass it on. */
export interface Transcriber {
  transcribe(bytes: Uint8Array, type: RecordingType, signal: AbortSignal): Promise<Heard>;
}

const DEFAULT_FILE = fileURLToPath(new URL("../../config/voices.json", import.meta.url));
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/; // the database checks the same

const fail = (message: string): never => { throw new Error(`Voice catalog: ${message}`); };

function check(file: VoiceFile): VoiceFile {
  const provider = file?.provider;
  if (!provider || provider.kind !== "minimax") fail("needs a minimax provider.");
  if (!/^https:\/\/\S+$/.test(provider.baseUrl ?? "")) fail("the provider needs an https baseUrl.");
  if (!/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv ?? "")) fail("the provider needs apiKeyEnv, an environment variable name.");
  if (typeof provider.model !== "string" || !provider.model) fail("the provider needs a model.");
  if (typeof file.sampleText !== "string" || !file.sampleText.trim()) fail("needs sampleText.");
  if (!Array.isArray(file.voices)) fail("needs voices.");
  const ids = new Set<string>();
  for (const voice of file.voices) {
    if (!ID.test(voice.id ?? "") || ids.has(voice.id)) fail(`voice id ${voice.id} is invalid or repeated.`);
    ids.add(voice.id);
    if (voice.gender !== "FEMALE" && voice.gender !== "MALE") fail(`voice ${voice.id} needs gender FEMALE or MALE.`);
    for (const key of ["name", "description", "providerVoice"] as const) {
      if (typeof voice[key] !== "string" || !voice[key]) fail(`voice ${voice.id} needs ${key}.`);
    }
  }
  return file;
}

export class VoiceCatalog {
  readonly #file: VoiceFile;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(file: VoiceFile, env: Readonly<Record<string, string | undefined>> = process.env) {
    this.#file = check(file);
    this.#env = env;
  }

  /** Reads VOICES_FILE or the default file; a broken file stops the server at start. */
  static load(env: Readonly<Record<string, string | undefined>> = process.env): VoiceCatalog {
    return new VoiceCatalog(JSON.parse(readFileSync(env.VOICES_FILE ?? DEFAULT_FILE, "utf8")) as VoiceFile, env);
  }

  get voices(): readonly VoiceEntry[] { return this.#file.voices; }
  get provider(): VoiceFile["provider"] { return this.#file.provider; }
  get sampleText(): string { return this.#file.sampleText; }

  find(id: string | null): VoiceEntry | undefined { return this.#file.voices.find(voice => voice.id === id); }

  apiKey(): string | undefined {
    const key = this.#env[this.#file.provider.apiKeyEnv]?.trim();
    return key ? key : undefined;
  }
}

type Fetch = typeof globalThis.fetch;

/**
 * MiniMax text-to-speech (POST /v1/t2a_v2, one request per message). 24 kHz mono MP3 at 32 kbit/s:
 * clear speech at about 4 KB per second, since the clips are kept in the database.
 */
export class MiniMaxSpeaker implements Speaker {
  readonly #url: string;
  readonly #model: string;
  readonly #key: string;
  readonly #fetch: Fetch;

  constructor(provider: VoiceFile["provider"], apiKey: string, fetchImpl: Fetch = globalThis.fetch) {
    this.#url = `${provider.baseUrl.replace(/\/$/, "")}/v1/t2a_v2`;
    this.#model = provider.model;
    this.#key = apiKey;
    this.#fetch = fetchImpl;
  }

  async speak(text: string, voice: VoiceEntry, emotion: Emotion | null, signal: AbortSignal): Promise<Clip> {
    const response = await this.#fetch(this.#url, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.#model, text, stream: false, language_boost: "auto",
        voice_setting: { voice_id: voice.providerVoice, speed: 1, vol: 1, pitch: 0, ...(emotion === null ? {} : { emotion }) },
        audio_setting: { sample_rate: 24000, bitrate: 32000, format: "mp3", channel: 1 },
      }),
    });
    if (!response.ok) throw new SpeechError(`HTTP_${response.status}`, `speech provider answered HTTP ${response.status}`);
    const payload = await response.json() as {
      data?: { audio?: unknown }; extra_info?: { audio_length?: unknown; usage_characters?: unknown };
      base_resp?: { status_code?: unknown; status_msg?: unknown };
    };
    const status = payload.base_resp?.status_code;
    if (status !== 0) {
      throw new SpeechError(typeof status === "number" ? `REFUSED_${status}` : "REFUSED",
        `speech provider refused: ${String(status)} ${String(payload.base_resp?.status_msg ?? "")}`.trim());
    }
    const hex = payload.data?.audio;
    const durationMs = payload.extra_info?.audio_length;
    if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)
      || typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 1) {
      throw new SpeechError("BAD_ANSWER", "speech provider answered in an unexpected shape");
    }
    const characters = payload.extra_info?.usage_characters;
    return {
      bytes: Buffer.from(hex, "hex"), mime: "audio/mpeg", durationMs,
      characters: typeof characters === "number" && Number.isInteger(characters) && characters >= 0 ? characters : 0,
    };
  }
}

/** MiniMax speech recognition (POST /v1/speech_to_text, asr-1.0); the language is detected. Billed by audio length. */
export class MiniMaxTranscriber implements Transcriber {
  readonly #url: string;
  readonly #key: string;
  readonly #fetch: Fetch;

  constructor(provider: VoiceFile["provider"], apiKey: string, fetchImpl: Fetch = globalThis.fetch) {
    this.#url = `${provider.baseUrl.replace(/\/$/, "")}/v1/speech_to_text`;
    this.#key = apiKey;
    this.#fetch = fetchImpl;
  }

  async transcribe(bytes: Uint8Array, type: RecordingType, signal: AbortSignal): Promise<Heard> {
    const form = new FormData();
    form.set("model", "asr-1.0");
    form.set("response_format", "json");
    form.set("file", new Blob([bytes], { type }), `voice.${RECORDING_TYPES[type]}`);
    const response = await this.#fetch(this.#url, { method: "POST", signal, headers: { authorization: `Bearer ${this.#key}` }, body: form });
    if (!response.ok) throw new Error(`speech recognition answered HTTP ${response.status}`);
    const payload = await response.json() as { text?: unknown; duration?: unknown };
    if (typeof payload.text !== "string") throw new Error("speech recognition answered in an unexpected shape");
    const seconds = payload.duration;
    return { text: payload.text, durationMs: typeof seconds === "number" && seconds > 0 ? Math.round(seconds * 1000) : 0 };
  }
}

/** Development only: every recording "says" the same sentence. */
export const devTranscriber: Transcriber = {
  async transcribe() { return { text: "（开发环境假转写）这是一条语音", durationMs: 0 }; },
};

/** Development only: silence (an 8 kHz WAV) about as long as it takes to say the text. */
export const devSpeaker: Speaker = {
  async speak(text) {
    const durationMs = Math.min(8000, 500 + 200 * Array.from(text).length);
    const samples = Math.round(8 * durationMs);
    const wav = Buffer.alloc(44 + samples, 0x80); // unsigned 8-bit: 0x80 is silence
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
    wav.write("data", 36); wav.writeUInt32LE(samples, 40);
    return { bytes: wav, mime: "audio/wav", durationMs, characters: 0 };
  },
};

/** The voice catalog and, when configured, the speaker and the transcriber. Samples are made once per server. */
export class Voices {
  readonly catalog: VoiceCatalog;
  readonly #speaker: Speaker | undefined;
  readonly #transcriber: Transcriber | undefined;
  readonly #samples = new Map<string, Promise<Clip>>();

  constructor(catalog: VoiceCatalog, speaker?: Speaker, transcriber?: Transcriber) {
    this.catalog = catalog;
    this.#speaker = speaker;
    this.#transcriber = transcriber;
  }

  /** With the provider's key, MiniMax; without it, the dev host fakes both and the Supabase host has no voice messages. */
  static fromEnvironment(mode: "stage1-mobile-dev" | "supabase-auth", env = process.env): Voices {
    const catalog = VoiceCatalog.load(env);
    const key = catalog.apiKey();
    if (key !== undefined) {
      return new Voices(catalog, new MiniMaxSpeaker(catalog.provider, key), new MiniMaxTranscriber(catalog.provider, key));
    }
    return mode === "stage1-mobile-dev" ? new Voices(catalog, devSpeaker, devTranscriber) : new Voices(catalog);
  }

  /** Companions can answer with voice messages. */
  get available(): boolean { return this.#speaker !== undefined; }

  /** The Owner can send voice messages. */
  get listening(): boolean { return this.#transcriber !== undefined; }

  transcribe(bytes: Uint8Array, type: RecordingType, signal: AbortSignal): Promise<Heard> {
    if (this.#transcriber === undefined) return Promise.reject(new Error("no speech recognition"));
    return this.#transcriber.transcribe(bytes, type, signal);
  }

  /** The voice a Companion speaks with: its chosen one, if voice messages can be made now. */
  pick(id: string | null | undefined): VoiceEntry | undefined {
    return this.#speaker === undefined ? undefined : this.catalog.find(id ?? null);
  }

  speak(text: string, voice: VoiceEntry, emotion: Emotion | null, signal: AbortSignal): Promise<Clip> {
    if (this.#speaker === undefined) return Promise.reject(new Error("no speech provider"));
    return this.#speaker.speak(text, voice, emotion, signal);
  }

  /** The voice saying the sample text, made on first request and kept (a failure is not kept). */
  sample(voice: VoiceEntry): Promise<Clip> {
    let clip = this.#samples.get(voice.id);
    if (clip === undefined) {
      clip = this.speak(this.catalog.sampleText, voice, "happy", AbortSignal.timeout(30_000));
      this.#samples.set(voice.id, clip);
      clip.catch(() => this.#samples.delete(voice.id));
    }
    return clip;
  }
}
