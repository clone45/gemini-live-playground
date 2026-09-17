'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import DailyIframe, { type DailyCall, type DailyParticipant } from '@daily-co/daily-js';
import { Modality } from '@google/genai';
import { CallAudioSink, TrackRecorder } from '@/lib/call-bridge';
import { newId } from '@/lib/ids';
import { LiveSession } from '@/lib/live-session';
import { DEFAULT_VOICE, VOICES } from '@/lib/voices';
import styles from './dial-out.module.css';

/**
 * Dial-out test: Daily places a PSTN call, and the browser acts as the AI
 * participant in the room, bridging the caller's audio to a Gemini Live
 * session and publishing Gemini's speech back as its own microphone track.
 */

const MODEL_ID = 'gemini-3.8-live';

const DEFAULT_INSTRUCTION =
  'You are placing a brief, friendly test call. The person agreed in advance to receive it. ' +
  'Open by saying you are an AI assistant calling to test a phone integration, then ask how ' +
  'the audio sounds on their end. Keep every reply to one or two short sentences, and let them ' +
  'lead. If they ask you to hang up or say they are done, thank them and say goodbye.';

type Phase = 'idle' | 'preparing' | 'joining' | 'dialing' | 'ringing' | 'connected' | 'ended';

interface LogRow {
  id: string;
  at: number;
  kind: 'info' | 'daily' | 'gemini' | 'error';
  text: string;
}

interface Turn {
  id: string;
  who: 'caller' | 'gemini';
  text: string;
}

/** A number purchased on the Daily domain, usable as outbound caller ID. */
interface CallerId {
  number: string;
  label: string;
  status: string;
  verified: boolean;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Idle',
  preparing: 'Creating room…',
  joining: 'Joining room…',
  dialing: 'Dialing…',
  ringing: 'Ringing',
  connected: 'Connected',
  ended: 'Call ended',
};

function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value.trim());
}

export function DialOut() {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [voiceName, setVoiceName] = useState(DEFAULT_VOICE);
  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION);
  const [aiAnswers, setAiAnswers] = useState(true);
  const [monitor, setMonitor] = useState(true);

  const [phase, setPhase] = useState<Phase>('idle');
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [numbersWarning, setNumbersWarning] = useState<string | null>(null);
  const [callerIds, setCallerIds] = useState<CallerId[]>([]);
  const [callerId, setCallerId] = useState('');
  const [geminiSpeaking, setGeminiSpeaking] = useState(false);

  const callRef = useRef<DailyCall | null>(null);
  const sessionRef = useRef<LiveSession | null>(null);
  const recorderRef = useRef<TrackRecorder | null>(null);
  const sinkRef = useRef<CallAudioSink | null>(null);
  const bridgedRef = useRef(false);
  const dialoutSessionRef = useRef<string | null>(null);
  const callerTurnRef = useRef<string | null>(null);
  const geminiTurnRef = useRef<string | null>(null);

  const log = useCallback((kind: LogRow['kind'], text: string) => {
    setLogs((prev) => [...prev.slice(-250), { id: newId(), at: Date.now(), kind, text }]);
  }, []);

  // Dial-out needs a purchased number for caller ID; warn before the attempt.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/daily/numbers')
      .then((r) => r.json())
      .then((body: { count?: number; numbers?: CallerId[]; error?: string }) => {
        if (cancelled) return;
        const numbers = body.numbers ?? [];
        setCallerIds(numbers);

        if (body.error) {
          setNumbersWarning(body.error);
          return;
        }
        if (numbers.length === 0) {
          setNumbersWarning(
            'This Daily account has no purchased phone numbers. Dial-out uses one for caller ID, ' +
              'so the call will be rejected until you buy a number and attach billing in the Daily dashboard.',
          );
          return;
        }

        // Prefer a verified number; an unverified one can be refused outbound.
        const usable = numbers.find((n) => n.verified) ?? numbers[0];
        setCallerId(usable.number);
        setNumbersWarning(
          usable.verified
            ? null
            : `Caller ID ${usable.number} is not verified (status: ${usable.status}). Daily may refuse the call.`,
        );
        log('info', `Caller ID: ${usable.number}${usable.verified ? ' (verified)' : ''}`);
      })
      .catch(() => {
        if (!cancelled) setNumbersWarning('Could not check for purchased Daily numbers.');
      });
    return () => {
      cancelled = true;
    };
  }, [log]);

  const appendTurn = useCallback((who: Turn['who'], text: string) => {
    const own = who === 'caller' ? callerTurnRef : geminiTurnRef;
    const other = who === 'caller' ? geminiTurnRef : callerTurnRef;
    other.current = null;
    if (own.current) {
      const id = own.current;
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, text: t.text + text } : t)));
    } else {
      const turn: Turn = { id: newId(), who, text };
      own.current = turn.id;
      setTurns((prev) => [...prev, turn]);
    }
  }, []);

  const teardown = useCallback(async () => {
    bridgedRef.current = false;
    dialoutSessionRef.current = null;
    callerTurnRef.current = null;
    geminiTurnRef.current = null;

    sessionRef.current?.close();
    sessionRef.current = null;

    await recorderRef.current?.stop();
    recorderRef.current = null;

    await sinkRef.current?.close();
    sinkRef.current = null;

    const call = callRef.current;
    callRef.current = null;
    if (call) {
      try {
        await call.leave();
      } catch {
        // already gone
      }
      call.destroy();
    }
    setGeminiSpeaking(false);
  }, []);

  /** Wire the caller's audio to Gemini and Gemini's speech back into the call. */
  const bridgeToGemini = useCallback(
    async (track: MediaStreamTrack) => {
      if (bridgedRef.current) return;
      bridgedRef.current = true;

      const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (!apiKey) {
        setError('NEXT_PUBLIC_GEMINI_API_KEY is not set, so Gemini cannot answer.');
        return;
      }

      const sink = new CallAudioSink();
      sink.monitoring = monitor;
      sink.onSpeakingChange = setGeminiSpeaking;
      await sink.resume();
      sinkRef.current = sink;

      const session = new LiveSession(apiKey);
      sessionRef.current = session;

      await session.connect(
        MODEL_ID,
        {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          systemInstruction: instruction.trim() || DEFAULT_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        {
          onAudio: (data) => sink.enqueue(data),
          onInputTranscription: (text) => appendTurn('caller', text),
          onOutputTranscription: (text) => appendTurn('gemini', text),
          onInterrupted: () => {
            sink.interrupt();
            geminiTurnRef.current = null;
            log('gemini', 'Caller interrupted, flushing queued speech');
          },
          onTurnComplete: () => {
            callerTurnRef.current = null;
            geminiTurnRef.current = null;
          },
          onError: (e) => {
            setError(e.message);
            log('error', `Gemini: ${e.message}`);
          },
          onClose: (code, reason) => log('gemini', `Gemini session closed (${code}${reason ? ` ${reason}` : ''})`),
        },
      );
      log('gemini', `Connected to ${MODEL_ID} as voice ${voiceName}`);

      // Publish Gemini's voice as this participant's microphone.
      await callRef.current?.setInputDevicesAsync({ audioSource: sink.track });
      await callRef.current?.setLocalAudio(true);
      log('daily', 'Publishing Gemini audio into the call');

      const recorder = new TrackRecorder((chunk) => sessionRef.current?.sendAudio(chunk));
      recorderRef.current = recorder;
      await recorder.start(track);
      log('daily', "Streaming the caller's audio to Gemini at 16 kHz");

      // Speak first: the callee answered, so open the conversation.
      session.sendText('The person has just answered the phone. Greet them now.');
    },
    [appendTurn, instruction, log, monitor, voiceName],
  );

  const startCall = useCallback(async () => {
    if (!isE164(phoneNumber)) {
      setError('Enter the number in E.164 format, for example +12065551234.');
      return;
    }
    setError(null);
    setTurns([]);
    setPhase('preparing');

    try {
      const response = await fetch('/api/daily/session', { method: 'POST' });
      const body = (await response.json()) as { roomUrl?: string; token?: string; error?: string };
      if (!response.ok || !body.roomUrl || !body.token) {
        throw new Error(body.error ?? 'Could not create the Daily room');
      }
      log('daily', `Room created: ${body.roomUrl}`);

      const call = DailyIframe.createCallObject({ subscribeToTracksAutomatically: true });
      callRef.current = call;

      call.on('joined-meeting', () => log('daily', 'Joined the room as owner'));
      call.on('left-meeting', () => log('daily', 'Left the room'));
      call.on('dialout-connected', (ev) => {
        setPhase('ringing');
        log('daily', `dialout-connected ${JSON.stringify(ev?.['sipCallId'] ?? '')}`);
      });
      call.on('dialout-answered', () => {
        setPhase('connected');
        log('daily', 'dialout-answered: they picked up');
      });
      call.on('dialout-stopped', () => {
        setPhase('ended');
        log('daily', 'dialout-stopped: the far end hung up');
        void teardown();
      });
      call.on('dialout-error', (ev) => {
        const detail = JSON.stringify(ev ?? {});
        setError(`Daily dial-out error: ${detail}`);
        log('error', `dialout-error ${detail}`);
        setPhase('ended');
      });
      call.on('dialout-warning', (ev) => log('daily', `dialout-warning ${JSON.stringify(ev ?? {})}`));
      call.on('error', (ev) => {
        const detail = ev?.errorMsg ?? JSON.stringify(ev ?? {});
        setError(`Daily error: ${detail}`);
        log('error', `Daily error: ${detail}`);
      });

      // The caller joins as a participant; their audio track is our input.
      const onTrack = (ev?: { participant?: DailyParticipant | null; track?: MediaStreamTrack; type?: string }) => {
        if (!ev?.track || ev.track.kind !== 'audio') return;
        if (ev.participant?.local) return;
        log('daily', `Remote audio track from ${ev.participant?.user_name || 'caller'}`);
        if (aiAnswers) void bridgeToGemini(ev.track);
      };
      call.on('track-started', onTrack);

      setPhase('joining');
      await call.join({ url: body.roomUrl, token: body.token, startVideoOff: true, startAudioOff: true });

      if (!aiAnswers) {
        await call.setLocalAudio(true);
        log('daily', 'Your microphone is live; you will talk to the caller yourself');
      }

      setPhase('dialing');
      log('daily', `Starting dial-out to ${phoneNumber}`);
      const dialout = await call.startDialOut({
        phoneNumber: phoneNumber.trim(),
        displayName: 'Caller',
        // Explicit, rather than letting Daily fall back to the oldest number on the domain.
        ...(callerId ? { callerId } : {}),
      });
      dialoutSessionRef.current = dialout?.session?.sessionId ?? null;
      log('daily', `Dial-out session ${dialoutSessionRef.current ?? 'unknown'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      log('error', message);
      setPhase('ended');
      await teardown();
    }
  }, [aiAnswers, bridgeToGemini, log, phoneNumber, teardown]);

  const hangUp = useCallback(async () => {
    log('info', 'Hanging up');
    const sessionId = dialoutSessionRef.current;
    if (sessionId) {
      try {
        await callRef.current?.stopDialOut({ sessionId });
      } catch {
        // the leg may already be gone
      }
    }
    await teardown();
    setPhase('ended');
  }, [log, teardown]);

  useEffect(() => {
    if (sinkRef.current) sinkRef.current.monitoring = monitor;
  }, [monitor]);

  useEffect(() => {
    return () => {
      void teardown();
    };
  }, [teardown]);

  const busy = phase !== 'idle' && phase !== 'ended';
  const locked = busy;

  return (
    <main className={styles.page}>
      <h1>Daily dial-out test</h1>
      <p className={styles.lede}>
        Daily places a PSTN call and this browser tab acts as the AI participant, bridging the
        caller to Gemini Live. <a href="/">Console</a> · <a href="/mic-test">Microphone test</a>
      </p>

      {numbersWarning && <p className={styles.warning}>{numbersWarning}</p>}

      <section className={styles.card}>
        <div className={styles.controls}>
          <label>
            Number to call (E.164)
            <input
              type="tel"
              name="phoneNumber"
              value={phoneNumber}
              placeholder="+12065551234"
              onChange={(e) => setPhoneNumber(e.target.value)}
              disabled={locked}
            />
          </label>

          {callerIds.length > 1 ? (
            <label>
              Caller ID they will see
              <select name="callerId" value={callerId} onChange={(e) => setCallerId(e.target.value)} disabled={locked}>
                {callerIds.map((n) => (
                  <option key={n.number} value={n.number}>
                    {n.label} {n.verified ? '' : `(${n.status})`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            callerId && (
              <p className={styles.hint}>
                They will see <strong>{callerId}</strong> as the caller.
              </p>
            )
          )}

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={aiAnswers}
              onChange={(e) => setAiAnswers(e.target.checked)}
              disabled={locked}
            />
            Let Gemini do the talking. Unchecked, your own microphone is used, which tests the phone
            leg on its own.
          </label>

          {aiAnswers && (
            <>
              <label>
                Voice
                <select name="voice" value={voiceName} onChange={(e) => setVoiceName(e.target.value)} disabled={locked}>
                  {VOICES.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} · {v.character}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                What it should say
                <textarea
                  name="instruction"
                  rows={5}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  disabled={locked}
                />
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />
                Monitor locally, so you hear what the caller hears
              </label>
            </>
          )}

          <div className={styles.buttons}>
            {busy ? (
              <button type="button" className={styles.danger} onClick={() => void hangUp()}>
                Hang up
              </button>
            ) : (
              <button type="button" className={styles.primary} onClick={() => void startCall()}>
                Place the call
              </button>
            )}
            <span className={`${styles.phase} ${phase === 'connected' ? styles.phaseLive : ''}`}>
              {PHASE_LABEL[phase]}
              {geminiSpeaking && phase === 'connected' ? ' · Gemini speaking' : ''}
            </span>
          </div>
        </div>

        {error && <p className={styles.error}>{error}</p>}
      </section>

      <section className={styles.card}>
        <h2>Conversation</h2>
        {turns.length === 0 ? (
          <p className={styles.hint}>Transcripts of both sides appear here once the call connects.</p>
        ) : (
          <div className={styles.turns}>
            {turns.map((t) => (
              <p key={t.id} className={t.who === 'caller' ? styles.caller : styles.gemini}>
                <strong>{t.who === 'caller' ? 'Caller' : 'Gemini'}</strong> {t.text}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className={styles.card}>
        <h2>Call events</h2>
        <div className={styles.logs}>
          {logs.length === 0 && <p className={styles.hint}>Nothing yet.</p>}
          {logs.map((row) => (
            <div key={row.id} className={styles[row.kind]}>
              <span className={styles.time}>{new Date(row.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className={styles.kind}>{row.kind}</span>
              <span>{row.text}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
