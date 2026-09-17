'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  EndSensitivity,
  FunctionResponseScheduling,
  MediaResolution,
  Modality,
  StartSensitivity,
  type FunctionCall,
  type FunctionResponse,
  type LiveConnectConfig,
  type LiveServerMessage,
  type UsageMetadata,
} from '@google/genai';
import { loadAudioModules } from '@/lib/audio-modules';
import { AudioOutput } from '@/lib/audio-output';
import { MicController } from '@/lib/mic-controller';
import { base64ByteLength } from '@/lib/base64';
import { newId } from '@/lib/ids';
import { LiveSession, type LiveSessionHandlers } from '@/lib/live-session';
import { DEMO_TOOLS, type ToolContext } from '@/lib/tools';
import { FrameCapture, type VideoSource } from '@/lib/video-capture';
import { DEFAULT_VOICE } from '@/lib/voices';

export const MODEL_ID = 'gemini-3.8-live';
export const DEFAULT_ACCENT = '#4f8cff';

const MAX_LOG_ENTRIES = 400;
const MAX_RECONNECT_ATTEMPTS = 3;
const TICK_MS = 100;
/**
 * Input level below this counts as silence for the dead-microphone warning.
 * Roughly -50 dBFS, a conventional speech threshold. A quiet audio-interface
 * input can sit near -43 dB, so anything stricter gives false alarms.
 */
const SILENCE_LEVEL = 0.00316;
/** How long the mic may stay silent before the event log says so. */
const SILENCE_WARN_MS = 6000;

export const DEFAULT_SYSTEM_INSTRUCTION =
  "You are a friendly, concise voice assistant inside a developer's playground for the Gemini Live API. " +
  'Keep answers short and conversational. You have tools for the current time, changing the accent color ' +
  'of the app, starting timers and saving notes; use them whenever they help.';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface SessionSettings {
  voiceName: string;
  systemInstruction: string;
  inputTranscription: boolean;
  outputTranscription: boolean;
  toolsEnabled: boolean;
  startSensitivity: StartSensitivity;
  endSensitivity: EndSensitivity;
  mediaResolution: MediaResolution;
  contextCompression: boolean;
  sessionResumption: boolean;
}

export const DEFAULT_SETTINGS: SessionSettings = {
  voiceName: DEFAULT_VOICE,
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
  inputTranscription: true,
  outputTranscription: true,
  toolsEnabled: true,
  startSensitivity: StartSensitivity.START_SENSITIVITY_UNSPECIFIED,
  endSensitivity: EndSensitivity.END_SENSITIVITY_UNSPECIFIED,
  mediaResolution: MediaResolution.MEDIA_RESOLUTION_UNSPECIFIED,
  contextCompression: true,
  sessionResumption: true,
};

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'model';
  text: string;
  at: number;
  interrupted?: boolean;
}

export type LogKind = 'info' | 'send' | 'recv' | 'tool' | 'error';

export interface LogEntry {
  id: string;
  at: number;
  kind: LogKind;
  summary: string;
  detail?: string;
}

export interface PendingToolCall {
  /** The function-call id minted by the server. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
}

export interface Note {
  id: string;
  text: string;
  at: number;
}

export interface Stats {
  audioChunksSent: number;
  audioBytesReceived: number;
  videoFramesSent: number;
  usage?: UsageMetadata;
}

export interface Levels {
  mic: number;
  output: number;
}

function buildConfig(s: SessionSettings, resumeHandle: string | undefined): LiveConnectConfig {
  const config: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voiceName } } },
  };
  const instruction = s.systemInstruction.trim();
  if (instruction) config.systemInstruction = instruction;
  if (s.inputTranscription) config.inputAudioTranscription = {};
  if (s.outputTranscription) config.outputAudioTranscription = {};
  if (s.toolsEnabled) config.tools = [{ functionDeclarations: DEMO_TOOLS.map((t) => t.declaration) }];

  const vad: NonNullable<NonNullable<LiveConnectConfig['realtimeInputConfig']>['automaticActivityDetection']> = {};
  if (s.startSensitivity !== StartSensitivity.START_SENSITIVITY_UNSPECIFIED) {
    vad.startOfSpeechSensitivity = s.startSensitivity;
  }
  if (s.endSensitivity !== EndSensitivity.END_SENSITIVITY_UNSPECIFIED) {
    vad.endOfSpeechSensitivity = s.endSensitivity;
  }
  if (Object.keys(vad).length) config.realtimeInputConfig = { automaticActivityDetection: vad };

  if (s.mediaResolution !== MediaResolution.MEDIA_RESOLUTION_UNSPECIFIED) config.mediaResolution = s.mediaResolution;
  if (s.contextCompression) config.contextWindowCompression = { slidingWindow: {} };
  if (s.sessionResumption) config.sessionResumption = resumeHandle ? { handle: resumeHandle } : {};
  return config;
}

/** JSON for the event log, with base64 payloads collapsed to their size. */
function compactJson(value: unknown): string {
  return JSON.stringify(
    value,
    (key, v) => (key === 'data' && typeof v === 'string' && v.length > 64 ? `<${base64ByteLength(v)} bytes base64>` : v),
    2,
  );
}

/** One-line summary of a server message, or null for pure audio chunks and empty keepalive frames. */
function describeMessage(m: LiveServerMessage): string | null {
  const bits: string[] = [];
  if (m.setupComplete) bits.push('setupComplete');

  const c = m.serverContent;
  if (c) {
    const parts = c.modelTurn?.parts ?? [];
    const audioParts = parts.filter((p) => p.inlineData).length;
    const textParts = parts.filter((p) => p.text && !p.thought).length;
    const thoughtParts = parts.filter((p) => p.thought).length;
    if (textParts) bits.push(`modelTurn text×${textParts}`);
    if (thoughtParts) bits.push(`thought×${thoughtParts}`);
    if (c.interimInputTranscription?.text) bits.push(`interimInput "${c.interimInputTranscription.text}"`);
    if (c.inputTranscription?.text) bits.push(`inputTranscription "${c.inputTranscription.text}"`);
    if (c.outputTranscription?.text) bits.push(`outputTranscription "${c.outputTranscription.text}"`);
    if (c.interrupted) bits.push('interrupted');
    if (c.generationComplete) bits.push('generationComplete');
    if (c.turnComplete) bits.push(c.turnCompleteReason ? `turnComplete (${c.turnCompleteReason})` : 'turnComplete');
    if (c.waitingForInput) bits.push('waitingForInput');
    if (c.interactionStatus) bits.push(`interactionStatus=${c.interactionStatus}`);
    if (audioParts && bits.length === 0) return null;
    if (audioParts) bits.push(`audio×${audioParts}`);
  }

  if (m.toolCall?.functionCalls) bits.push(`toolCall ${m.toolCall.functionCalls.map((f) => f.name).join(', ')}`);
  if (m.toolCallCancellation?.ids) bits.push(`toolCallCancellation ${m.toolCallCancellation.ids.join(', ')}`);
  if (m.usageMetadata) bits.push(`usage total=${m.usageMetadata.totalTokenCount ?? '?'}`);
  if (m.goAway) bits.push(`goAway timeLeft=${m.goAway.timeLeft ?? '?'}`);
  if (m.sessionResumptionUpdate) bits.push(`sessionResumptionUpdate resumable=${m.sessionResumptionUpdate.resumable ?? false}`);
  if (m.voiceActivity) bits.push(`voiceActivity ${m.voiceActivity.voiceActivityType ?? ''}`);
  if (m.voiceActivityDetectionSignal) bits.push(`vadSignal ${m.voiceActivityDetectionSignal.vadSignalType ?? ''}`);
  return bits.length ? bits.join(' · ') : null;
}

export function useLiveSession(videoRef: RefObject<HTMLVideoElement | null>) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [settings, setSettings] = useState<SessionSettings>(DEFAULT_SETTINGS);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [interimInput, setInterimInput] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pendingTools, setPendingTools] = useState<PendingToolCall[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [accent, setAccentState] = useState(DEFAULT_ACCENT);
  const [stats, setStats] = useState<Stats>({ audioChunksSent: 0, audioBytesReceived: 0, videoFramesSent: 0 });
  const [levels, setLevels] = useState<Levels>({ mic: 0, output: 0 });
  const [now, setNow] = useState(() => Date.now());
  const [micOn, setMicOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [videoSource, setVideoSourceState] = useState<VideoSource | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const settingsRef = useRef(settings);
  const sessionRef = useRef<LiveSession | null>(null);
  const playerRef = useRef<AudioOutput | null>(null);
  const recorderRef = useRef<MicController | null>(null);
  const captureRef = useRef<FrameCapture | null>(null);
  const wantConnectedRef = useRef(false);
  const resumeHandleRef = useRef<string | undefined>(undefined);
  const reconnectAttemptsRef = useRef(0);
  const currentUserEntryRef = useRef<string | null>(null);
  const currentModelEntryRef = useRef<string | null>(null);
  const toolAbortsRef = useRef(new Map<string, AbortController>());
  const statsRef = useRef<Stats>({ audioChunksSent: 0, audioBytesReceived: 0, videoFramesSent: 0 });
  const micLevelRef = useRef(0);
  const mutedRef = useRef(false);
  const lastSoundAtRef = useRef(0);
  const silenceWarnedRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // ---- logging -------------------------------------------------------------

  const log = useCallback((kind: LogKind, summary: string, detail?: string) => {
    const entry: LogEntry = { id: newId(), at: Date.now(), kind, summary, detail };
    setLogs((prev) => (prev.length >= MAX_LOG_ENTRIES ? [...prev.slice(prev.length - MAX_LOG_ENTRIES + 1), entry] : [...prev, entry]));
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  // ---- transcript ----------------------------------------------------------

  const appendTranscript = useCallback((role: TranscriptEntry['role'], text: string) => {
    const ownRef = role === 'user' ? currentUserEntryRef : currentModelEntryRef;
    const otherRef = role === 'user' ? currentModelEntryRef : currentUserEntryRef;
    otherRef.current = null; // a new speaker closes the other side's bubble
    if (ownRef.current) {
      const id = ownRef.current;
      setTranscript((prev) => prev.map((e) => (e.id === id ? { ...e, text: e.text + text } : e)));
    } else {
      const entry: TranscriptEntry = { id: newId(), role, text, at: Date.now() };
      ownRef.current = entry.id;
      setTranscript((prev) => [...prev, entry]);
    }
  }, []);

  const clearTranscript = useCallback(() => {
    currentUserEntryRef.current = null;
    currentModelEntryRef.current = null;
    setTranscript([]);
    setInterimInput('');
  }, []);

  // ---- tools ---------------------------------------------------------------

  const toolContext: ToolContext = {
    setAccentColor: (color) => {
      setAccentState(color);
      document.documentElement.style.setProperty('--accent', color);
    },
    addNote: (text) => {
      const note: Note = { id: newId(), text, at: Date.now() };
      setNotes((prev) => [...prev, note]);
      return notesCountRef.current + 1;
    },
  };
  const notesCountRef = useRef(0);
  useEffect(() => {
    notesCountRef.current = notes.length;
  }, [notes]);
  const toolContextRef = useRef(toolContext);
  toolContextRef.current = toolContext;

  const finishToolCall = useCallback(
    (response: FunctionResponse) => {
      const id = response.id ?? '';
      toolAbortsRef.current.delete(id);
      setPendingTools((prev) => prev.filter((p) => p.id !== id));
      const session = sessionRef.current;
      if (!session?.connected) {
        log('tool', `Dropped response for ${response.name}: session closed`);
        return;
      }
      session.sendToolResponse([response]);
      log('tool', `→ toolResponse ${response.name} [${response.scheduling}]`, compactJson(response));
    },
    [log],
  );

  const handleToolCalls = useCallback(
    (calls: FunctionCall[]) => {
      for (const call of calls) {
        const id = call.id ?? newId();
        const name = call.name ?? '';
        const args = call.args ?? {};
        log('tool', `← toolCall ${name}(${JSON.stringify(args)})`, compactJson(call));

        const controller = new AbortController();
        toolAbortsRef.current.set(id, controller);
        setPendingTools((prev) => [...prev, { id, name, args, startedAt: Date.now() }]);

        const tool = DEMO_TOOLS.find((t) => t.declaration.name === name);
        if (!tool) {
          finishToolCall({ id, name, response: { error: `Unknown tool "${name}"` }, scheduling: FunctionResponseScheduling.WHEN_IDLE });
          continue;
        }

        tool
          .run(args, toolContextRef.current, controller.signal)
          .then((result) => finishToolCall({ id, name, response: result.response, scheduling: result.scheduling }))
          .catch((err: unknown) => {
            if (controller.signal.aborted) {
              toolAbortsRef.current.delete(id);
              setPendingTools((prev) => prev.filter((p) => p.id !== id));
              log('tool', `Cancelled ${name}`);
              return;
            }
            finishToolCall({ id, name, response: { error: String(err) }, scheduling: FunctionResponseScheduling.WHEN_IDLE });
          });
      }
    },
    [finishToolCall, log],
  );

  const cancelToolCalls = useCallback(
    (ids: string[]) => {
      for (const id of ids) toolAbortsRef.current.get(id)?.abort();
      log('recv', `toolCallCancellation ${ids.join(', ')}`);
    },
    [log],
  );

  const abortAllTools = useCallback(() => {
    for (const controller of toolAbortsRef.current.values()) controller.abort();
    toolAbortsRef.current.clear();
    setPendingTools([]);
  }, []);

  // ---- media ---------------------------------------------------------------

  const startMic = useCallback(async () => {
    const existing = recorderRef.current;
    if (existing) {
      if (existing.paused) {
        existing.resume();
        setMicOn(true);
        log('send', 'Microphone resumed');
      }
      return;
    }

    const recorder = new MicController({
      onChunk: (base64) => {
        const session = sessionRef.current;
        if (!session?.connected) return;
        session.sendAudio(base64);
        statsRef.current.audioChunksSent += 1;
      },
      onVolume: (volume) => {
        micLevelRef.current = volume;
        if (volume >= SILENCE_LEVEL) {
          lastSoundAtRef.current = Date.now();
          silenceWarnedRef.current = false;
        }
      },
    });
    recorderRef.current = recorder;
    log('info', 'Requesting microphone…');
    try {
      const info = await recorder.start();
      setMicOn(!recorder.paused);
      lastSoundAtRef.current = Date.now();
      silenceWarnedRef.current = false;
      log(
        'send',
        `Microphone streaming: ${info.deviceLabel}`,
        compactJson({
          deviceLabel: info.deviceLabel,
          contextSampleRate: info.contextSampleRate,
          trackSampleRate: info.trackSampleRate,
          echoCancellation: info.echoCancellation,
          sentTo: 'Gemini as audio/pcm;rate=16000',
        }),
      );
    } catch (err) {
      if (recorderRef.current === recorder) recorderRef.current = null;
      const message = err instanceof Error ? err.message : String(err);
      setLastError(`Microphone: ${message}`);
      log('error', `Microphone failed: ${message}`);
    }
  }, [log]);

  /** "Mic off" keeps the device open (no permission re-prompt) but stops sending audio. */
  const pauseMic = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.paused) return;
    recorder.pause();
    micLevelRef.current = 0;
    setMicOn(false);
    if (sessionRef.current?.connected) {
      sessionRef.current.sendAudioStreamEnd();
      log('send', 'audioStreamEnd (microphone paused)');
    }
  }, [log]);

  /** Release the device entirely (disconnect / unmount). */
  const releaseMic = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    micLevelRef.current = 0;
    setMicOn(false);
    await recorder?.stop();
  }, []);

  const toggleMic = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && !recorder.paused) pauseMic();
    else void startMic();
  }, [pauseMic, startMic]);

  const stopVideo = useCallback(async () => {
    const capture = captureRef.current;
    if (capture?.source) {
      await capture.stop();
      log('send', 'Video stopped');
    }
    setVideoSourceState(null);
  }, [log]);

  const startVideo = useCallback(
    async (source: VideoSource) => {
      const el = videoRef.current;
      if (!el) return;
      if (!captureRef.current) {
        captureRef.current = new FrameCapture(
          el,
          (jpeg) => {
            const session = sessionRef.current;
            if (!session?.connected) return;
            session.sendVideoFrame(jpeg);
            statsRef.current.videoFramesSent += 1;
          },
          { fps: 1, maxWidth: 768 },
        );
        captureRef.current.onEnded = () => {
          setVideoSourceState(null);
          log('send', 'Video ended by browser');
        };
      }
      try {
        await captureRef.current.start(source);
        setVideoSourceState(source);
        log('send', `${source === 'camera' ? 'Camera' : 'Screen'} streaming at 1 fps`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLastError(`Video: ${message}`);
        log('error', `Video failed: ${message}`);
        setVideoSourceState(null);
      }
    },
    [log, videoRef],
  );

  const setVideoSource = useCallback(
    (source: VideoSource | null) => {
      if (source === null) void stopVideo();
      else void startVideo(source);
    },
    [startVideo, stopVideo],
  );

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (playerRef.current) playerRef.current.muted = next;
  }, []);

  // ---- session -------------------------------------------------------------

  const openSessionRef = useRef<(resumeHandle: string | undefined) => Promise<void>>(async () => {});

  const teardownToDisconnected = useCallback(async () => {
    wantConnectedRef.current = false;
    resumeHandleRef.current = undefined;
    reconnectAttemptsRef.current = 0;
    abortAllTools();
    await releaseMic();
    await stopVideo();
    playerRef.current?.interrupt();
    setSpeaking(false);
    setInterimInput('');
    currentUserEntryRef.current = null;
    currentModelEntryRef.current = null;
    setStatus('disconnected');
  }, [abortAllTools, releaseMic, stopVideo]);

  const openSession = useCallback(
    async (resumeHandle: string | undefined) => {
      const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (!apiKey) {
        setLastError('NEXT_PUBLIC_GEMINI_API_KEY is not set. Add it to .env.local and restart the dev server.');
        await teardownToDisconnected();
        return;
      }

      const config = buildConfig(settingsRef.current, resumeHandle);
      const session = new LiveSession(apiKey);
      sessionRef.current = session;
      log('info', resumeHandle ? 'Reconnecting with session resumption handle' : `Connecting to ${MODEL_ID}`, compactJson(config));

      const handlers: LiveSessionHandlers = {
        onOpen: () => log('info', 'WebSocket open'),
        onAudio: (data) => {
          statsRef.current.audioBytesReceived += base64ByteLength(data);
          playerRef.current?.enqueue(data);
        },
        onText: (text) => appendTranscript('model', text),
        onInterimInputTranscription: (text) => setInterimInput(text),
        onInputTranscription: (text) => {
          setInterimInput('');
          appendTranscript('user', text);
        },
        onOutputTranscription: (text) => appendTranscript('model', text),
        onInterrupted: () => {
          playerRef.current?.interrupt();
          const id = currentModelEntryRef.current;
          if (id) setTranscript((prev) => prev.map((e) => (e.id === id ? { ...e, interrupted: true } : e)));
          currentModelEntryRef.current = null;
        },
        onTurnComplete: () => {
          currentUserEntryRef.current = null;
          currentModelEntryRef.current = null;
          setInterimInput('');
        },
        onToolCall: handleToolCalls,
        onToolCallCancellation: cancelToolCalls,
        onUsage: (usage) => {
          statsRef.current.usage = usage;
        },
        onGoAway: (timeLeft) => log('info', `Server goAway, time left ${timeLeft ?? 'unknown'}; will reconnect on close`),
        onSessionResumptionUpdate: (handle, resumable) => {
          if (resumable && handle) resumeHandleRef.current = handle;
        },
        onMessage: (message) => {
          const summary = describeMessage(message);
          if (summary) log('recv', summary, compactJson(message));
        },
        onError: (error) => {
          setLastError(error.message);
          log('error', error.message);
        },
        onClose: (code, reason) => {
          if (sessionRef.current === session) sessionRef.current = null;
          log('info', `WebSocket closed (${code}${reason ? ` ${reason}` : ''})`);
          if (!wantConnectedRef.current) return;

          const handle = resumeHandleRef.current;
          if (handle && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttemptsRef.current += 1;
            setStatus('reconnecting');
            window.setTimeout(() => {
              if (wantConnectedRef.current) void openSessionRef.current(handle);
            }, 400);
          } else {
            setLastError(reason ? `Connection closed: ${reason}` : 'Connection closed by server');
            void teardownToDisconnected();
          }
        },
      };

      try {
        await session.connect(MODEL_ID, config, handlers);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLastError(message);
        log('error', `Connect failed: ${message}`);
        if (sessionRef.current === session) sessionRef.current = null;
        await teardownToDisconnected();
        return;
      }

      if (!wantConnectedRef.current) {
        session.close();
        return;
      }
      reconnectAttemptsRef.current = 0;
      setStatus('connected');
      log('info', resumeHandle ? 'Session resumed' : 'Session ready');
      await startMic();
    },
    [appendTranscript, cancelToolCalls, handleToolCalls, log, startMic, teardownToDisconnected],
  );

  useEffect(() => {
    openSessionRef.current = openSession;
  }, [openSession]);

  const connect = useCallback(async () => {
    if (wantConnectedRef.current) return;
    wantConnectedRef.current = true;
    setLastError(null);
    setStatus('connecting');
    statsRef.current = { audioChunksSent: 0, audioBytesReceived: 0, videoFramesSent: 0 };

    // The output AudioContext must be created inside a user gesture.
    if (!playerRef.current) {
      const player = new AudioOutput();
      player.onPlayingChange = setSpeaking;
      player.muted = mutedRef.current;
      playerRef.current = player;
    }
    try {
      await playerRef.current.init();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(`Audio output: ${message}`);
      log('error', `Audio output failed: ${message}`);
      await teardownToDisconnected();
      return;
    }
    await openSession(undefined);
  }, [log, openSession, teardownToDisconnected]);

  const disconnect = useCallback(async () => {
    wantConnectedRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.close();
    await teardownToDisconnected();
    log('info', 'Disconnected');
  }, [log, teardownToDisconnected]);

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      const session = sessionRef.current;
      if (!trimmed || !session?.connected) return;
      currentModelEntryRef.current = null;
      currentUserEntryRef.current = null;
      const entry: TranscriptEntry = { id: newId(), role: 'user', text: trimmed, at: Date.now() };
      setTranscript((prev) => [...prev, entry]);
      session.sendText(trimmed);
      log('send', `text "${trimmed}"`);
    },
    [log],
  );

  const updateSettings = useCallback((patch: Partial<SessionSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetAccent = useCallback(() => toolContextRef.current.setAccentColor(DEFAULT_ACCENT), []);

  // ---- periodic UI refresh (levels, stats, timers) --------------------------

  useEffect(() => {
    if (status === 'disconnected') {
      setLevels({ mic: 0, output: 0 });
      return;
    }
    const timer = window.setInterval(() => {
      setLevels({ mic: micLevelRef.current, output: playerRef.current?.level() ?? 0 });
      setStats({ ...statsRef.current });
      setNow(Date.now());

      // A microphone that is open and sending but carries no signal is the
      // single most confusing failure here, so name it explicitly.
      const recorder = recorderRef.current;
      if (
        recorder?.running &&
        !recorder.paused &&
        !silenceWarnedRef.current &&
        lastSoundAtRef.current > 0 &&
        Date.now() - lastSoundAtRef.current > SILENCE_WARN_MS
      ) {
        silenceWarnedRef.current = true;
        const info = recorder.micInfo;
        log(
          'error',
          `Microphone has been silent for ${Math.round(SILENCE_WARN_MS / 1000)}s — Gemini is receiving no sound`,
          compactJson({
            device: info?.deviceLabel,
            contextSampleRate: info?.contextSampleRate,
            trackSampleRate: info?.trackSampleRate,
            checks: [
              'Is the right input device selected in the OS sound settings?',
              'Is the browser tab muted, or the mic muted in the OS or on the hardware?',
              'Does the mic meter in the bottom bar move when you speak?',
              'Another app holding the device exclusively can silence it.',
            ],
          }),
        );
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [status, log]);

  // ---- preload the browser-only audio layer --------------------------------

  // Loaded here rather than imported at module scope: the vendored helper
  // registers `window` listeners on import, which breaks server rendering.
  // Doing it on mount also means its user-gesture listener is already attached
  // when the first Connect click arrives.
  useEffect(() => {
    let cancelled = false;
    loadAudioModules().catch((err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      log('error', `Audio modules failed to load: ${message}`);
    });
    return () => {
      cancelled = true;
    };
  }, [log]);

  // ---- unmount -------------------------------------------------------------

  useEffect(() => {
    return () => {
      wantConnectedRef.current = false;
      sessionRef.current?.close();
      sessionRef.current = null;
      void recorderRef.current?.stop();
      void captureRef.current?.stop();
      void playerRef.current?.close();
      playerRef.current = null;
    };
  }, []);

  return {
    model: MODEL_ID,
    status,
    settings,
    updateSettings,
    transcript,
    interimInput,
    clearTranscript,
    logs,
    clearLogs,
    pendingTools,
    notes,
    accent,
    resetAccent,
    stats,
    levels,
    now,
    micOn,
    toggleMic,
    muted,
    toggleMuted,
    speaking,
    videoSource,
    setVideoSource,
    lastError,
    dismissError: () => setLastError(null),
    connect,
    disconnect,
    sendText,
  };
}

export type LiveSessionApi = ReturnType<typeof useLiveSession>;
