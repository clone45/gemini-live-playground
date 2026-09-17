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
 * Places a real phone call through Daily and puts Gemini on the line.
 *
 * The conversation happens over the phone. This tab is only the bridge: it
 * feeds the answering person's audio to a Gemini Live session and publishes
 * Gemini's speech back into the call as its own microphone track. Nobody at
 * this computer is part of the conversation unless the diagnostic mode below
 * is switched on.
 *
 * Gemini is connected and publishing as soon as the room is joined, before
 * anyone answers. An earlier version only started it when their audio track
 * arrived, so a failed receive transport meant Gemini never ran at all and the
 * line was simply silent.
 */

const MODEL_ID = 'gemini-3.8-live';

/** How long after they answer before a total lack of inbound audio is called out. */
const NO_AUDIO_WARN_MS = 8000;

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
  who: 'person' | 'gemini';
  text: string;
}

/** A number purchased on the Daily domain, usable as outbound caller ID. */
interface CallerId {
  /** Daily's identifier for the number. Dial-out's callerId resolves by this. */
  id: string;
  number: string;
  label: string;
  status: string;
  verified: boolean;
}

/** Log kinds map to their own classes so they do not collide with transcript styling. */
const LOG_CLASS: Record<LogRow['kind'], string> = {
  info: 'logInfo',
  daily: 'logDaily',
  gemini: 'logGemini',
  error: 'logError',
};

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
  const [listenIn, setListenIn] = useState(true);
  const [forceRelay, setForceRelay] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [numbersWarning, setNumbersWarning] = useState<string | null>(null);
  const [callerIds, setCallerIds] = useState<CallerId[]>([]);
  const [callerId, setCallerId] = useState<CallerId | null>(null);
  const [geminiSpeaking, setGeminiSpeaking] = useState(false);
  const [chunksIn, setChunksIn] = useState(0);
  const [bytesOut, setBytesOut] = useState(0);

  const callRef = useRef<DailyCall | null>(null);
  const sessionRef = useRef<LiveSession | null>(null);
  const recorderRef = useRef<TrackRecorder | null>(null);
  const sinkRef = useRef<CallAudioSink | null>(null);
  const dialoutSessionRef = useRef<string | null>(null);
  const personTurnRef = useRef<string | null>(null);
  const geminiTurnRef = useRef<string | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const chunksInRef = useRef(0);
  const bytesOutRef = useRef(0);
  const attachedRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);
  const aiAnswersRef = useRef(aiAnswers);
  const listenInRef = useRef(listenIn);

  aiAnswersRef.current = aiAnswers;
  listenInRef.current = listenIn;

  const log = useCallback((kind: LogRow['kind'], text: string) => {
    setLogs((prev) => [...prev.slice(-300), { id: newId(), at: Date.now(), kind, text }]);
  }, []);

  // Dial-out needs a purchased number for caller ID; check before the attempt.
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

        const usable = numbers.find((n) => n.verified) ?? numbers[0];
        setCallerId(usable);
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
    const own = who === 'person' ? personTurnRef : geminiTurnRef;
    const other = who === 'person' ? geminiTurnRef : personTurnRef;
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
    if (watchdogRef.current) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    attachedRef.current = false;
    dialoutSessionRef.current = null;
    personTurnRef.current = null;
    geminiTurnRef.current = null;

    sessionRef.current?.close();
    sessionRef.current = null;

    await recorderRef.current?.stop();
    recorderRef.current = null;

    await sinkRef.current?.close();
    sinkRef.current = null;

    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

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

  /**
   * Connect Gemini and publish its voice into the room. Done at join time so
   * the agent is live before anyone answers, independent of whether their
   * audio ever reaches us.
   */
  const startGemini = useCallback(async () => {
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) throw new Error('NEXT_PUBLIC_GEMINI_API_KEY is not set, so Gemini cannot answer.');

    const sink = new CallAudioSink();
    sink.monitoring = listenInRef.current;
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
        onAudio: (data) => {
          bytesOutRef.current += Math.floor((data.length * 3) / 4);
          setBytesOut(bytesOutRef.current);
          sink.enqueue(data);
        },
        onInputTranscription: (text) => appendTurn('person', text),
        onOutputTranscription: (text) => appendTurn('gemini', text),
        onInterrupted: () => {
          sink.interrupt();
          geminiTurnRef.current = null;
          log('gemini', 'They interrupted, flushing queued speech');
        },
        onTurnComplete: () => {
          personTurnRef.current = null;
          geminiTurnRef.current = null;
        },
        onError: (e) => {
          setError(e.message);
          log('error', `Gemini: ${e.message}`);
        },
        onClose: (code, reason) => log('gemini', `Gemini session closed (${code}${reason ? ` ${reason}` : ''})`),
      },
    );
    log('gemini', `Gemini connected, voice ${voiceName}`);

    await callRef.current?.setInputDevicesAsync({ audioSource: sink.track });
    await callRef.current?.setLocalAudio(true);
    log('daily', "Publishing Gemini's audio into the room");
  }, [appendTurn, instruction, log, voiceName]);

  /** Attach the phone's audio to Gemini once its track actually arrives. */
  const attachPhoneAudio = useCallback(
    async (track: MediaStreamTrack) => {
      if (attachedRef.current) return;
      attachedRef.current = true;

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = new MediaStream([track]);
        remoteAudioRef.current.muted = !(listenInRef.current || !aiAnswersRef.current);
        void remoteAudioRef.current.play().catch(() => {});
      }

      if (!aiAnswersRef.current) return;

      const recorder = new TrackRecorder((chunk) => {
        sessionRef.current?.sendAudio(chunk);
        chunksInRef.current += 1;
        setChunksIn(chunksInRef.current);
      });
      recorderRef.current = recorder;
      await recorder.start(track);
      log('daily', 'Streaming their audio to Gemini at 16 kHz');
    },
    [log],
  );

  const startCall = useCallback(async () => {
    if (!isE164(phoneNumber)) {
      setError('Enter the number in E.164 format, for example +12065551234.');
      return;
    }
    setError(null);
    setTurns([]);
    chunksInRef.current = 0;
    bytesOutRef.current = 0;
    setChunksIn(0);
    setBytesOut(0);
    setPhase('preparing');

    try {
      const response = await fetch('/api/daily/session', { method: 'POST' });
      const body = (await response.json()) as { roomUrl?: string; token?: string; error?: string };
      if (!response.ok || !body.roomUrl || !body.token) {
        throw new Error(body.error ?? 'Could not create the Daily room');
      }
      log('daily', `Room created: ${body.roomUrl}`);

      // Forcing ICE relay routes media over TCP/TLS 443 instead of direct UDP,
      // which helps behind restrictive firewalls. Daily gates iceConfig behind
      // the advanced_firewall_control add-on and ignores it otherwise, so this
      // is off by default and reported plainly when it is refused.
      const call = DailyIframe.createCallObject({
        subscribeToTracksAutomatically: true,
        ...(forceRelay ? { dailyConfig: { iceConfig: { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } } } : {}),
      });
      callRef.current = call;
      log('info', forceRelay ? 'Media forced through TURN relay' : 'Media using default ICE (direct if possible)');

      call.on('joined-meeting', () => log('daily', 'Joined the room as owner'));
      call.on('left-meeting', () => log('daily', 'Left the room'));
      call.on('participant-joined', (ev) =>
        log('daily', `participant-joined: ${ev?.participant?.user_name || ev?.participant?.session_id || 'unknown'}`),
      );
      call.on('participant-left', (ev) =>
        log('daily', `participant-left: ${ev?.participant?.user_name || 'unknown'}`),
      );

      // Transport health: this is what failed silently before.
      call.on('network-connection', (ev) => {
        const text = `network-connection ${ev?.type ?? ''} ${ev?.event ?? ''}`;
        const bad = /fail|disconnect|interrupt/i.test(String(ev?.event ?? ''));
        log(bad ? 'error' : 'daily', text);
        if (bad) {
          setError(
            `Daily media transport ${ev?.event} (${ev?.type}). The browser could not hold a media ` +
              'connection to Daily. If "force media through TURN relay" is already on, the likeliest ' +
              'cause is the browser environment itself: WebRTC from a browser running inside WSL is ' +
              'often unable to reach an SFU. Try Chrome on Windows against the same URL.',
          );
        }
      });
      call.on('network-quality-change', (ev) => {
        if (ev?.threshold && ev.threshold !== 'good') log('daily', `network quality: ${ev.threshold}`);
      });
      call.on('nonfatal-error', (ev) => {
        const message = String(ev?.errorMsg ?? '');
        if (/advanced_firewall_control/i.test(message)) {
          log(
            'info',
            'Daily ignored the TURN relay setting: iceConfig needs the advanced_firewall_control ' +
              'add-on, which this account does not have. The call is using default ICE.',
          );
          return;
        }
        log('error', `nonfatal-error ${ev?.type}: ${message}`);
      });
      call.on('error', (ev) => {
        const detail = ev?.errorMsg ?? JSON.stringify(ev ?? {});
        setError(`Daily error: ${detail}`);
        log('error', `Daily error: ${detail}`);
      });

      call.on('dialout-connected', () => {
        setPhase('ringing');
        log('daily', 'dialout-connected: the network accepted the call');
      });
      call.on('dialout-answered', () => {
        setPhase('connected');
        log('daily', 'dialout-answered: they picked up');

        if (aiAnswersRef.current && sessionRef.current) {
          sessionRef.current.sendText('The person has just answered the phone. Greet them now.');
          log('gemini', 'Asked Gemini to greet them');
        }

        // If nothing arrives from the phone, say so rather than sitting silent.
        watchdogRef.current = window.setTimeout(() => {
          if (chunksInRef.current === 0) {
            log('error', `No audio from the phone after ${NO_AUDIO_WARN_MS / 1000}s`);
            setError(
              'They answered, but no audio is arriving from the phone. The receive transport is ' +
                'likely broken, so Gemini cannot hear them even if Gemini is talking.',
            );
          }
        }, NO_AUDIO_WARN_MS);
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

      const onTrack = (ev?: { participant?: DailyParticipant | null; track?: MediaStreamTrack }) => {
        if (!ev?.track || ev.track.kind !== 'audio' || ev.participant?.local) return;
        log('daily', `Audio track from ${ev.participant?.user_name || 'the phone'}`);
        void attachPhoneAudio(ev.track);
      };
      call.on('track-started', onTrack);
      call.on('track-stopped', (ev) => {
        if (ev?.track?.kind === 'audio' && !ev.participant?.local) log('daily', 'Their audio track stopped');
      });

      setPhase('joining');
      await call.join({ url: body.roomUrl, token: body.token, startVideoOff: true, startAudioOff: true });

      // Dial-out requires the room on the SFU. A small room starts peer-to-peer
      // and Daily tries to switch when dial-out begins; when that fails it
      // reports only "Switch to soup failed, could not initiate dial out".
      // Doing it here makes the switch explicit and its failure legible.
      const topology = await call.setNetworkTopology({ topology: 'sfu' });
      if (topology?.error) {
        throw new Error(
          `Could not move the room onto Daily's SFU: ${topology.error}. Dial-out cannot start ` +
            'without it. This is the same failure as "Switch to soup failed".',
        );
      }
      log('daily', 'Room is on the SFU');

      if (aiAnswers) {
        await startGemini();
      } else {
        await call.setLocalAudio(true);
        log('daily', 'Your microphone is live; you will talk to them yourself');
      }

      setPhase('dialing');
      log('daily', `Starting dial-out to ${phoneNumber}`);
      const dialout = await call.startDialOut({
        phoneNumber: phoneNumber.trim(),
        displayName: 'Phone',
        ...(callerId?.id ? { callerId: callerId.id } : {}),
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
  }, [aiAnswers, attachPhoneAudio, callerId, forceRelay, log, phoneNumber, startGemini, teardown]);

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

  // "Listen in" covers both directions: Gemini's speech through the sink, and
  // their audio through the element below. In the diagnostic mode you must hear
  // them to hold a conversation, so it is forced on.
  const audible = listenIn || !aiAnswers;
  useEffect(() => {
    if (sinkRef.current) sinkRef.current.monitoring = audible;
    if (remoteAudioRef.current) remoteAudioRef.current.muted = !audible;
  }, [audible]);

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
        Calls a real phone through Daily and puts Gemini on the line. You talk to the agent on your
        phone, not through this computer. This tab is only the bridge and stays out of the
        conversation. <a href="/">Console</a> · <a href="/mic-test">Microphone test</a>
      </p>

      {numbersWarning && <p className={styles.warning}>{numbersWarning}</p>}

      <section className={styles.card}>
        <div className={styles.controls}>
          <label>
            Your phone number (E.164)
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
              <select
                name="callerId"
                value={callerId?.id ?? ''}
                onChange={(e) => setCallerId(callerIds.find((n) => n.id === e.target.value) ?? null)}
                disabled={locked}
              >
                {callerIds.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label} {n.verified ? '' : `(${n.status})`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            callerId?.number && (
              <p className={styles.hint}>
                Your phone will show <strong>{callerId.number}</strong>.
              </p>
            )
          )}

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={forceRelay}
              onChange={(e) => setForceRelay(e.target.checked)}
              disabled={locked}
            />
            <span>
              <strong>Force media through TURN relay.</strong> Routes audio over TCP/TLS 443 rather
              than direct UDP, which helps behind strict firewalls. Requires Daily&apos;s
              <code> advanced_firewall_control</code> add-on; without it Daily ignores the setting
              and says so in the log.
            </span>
          </label>

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={aiAnswers}
              onChange={(e) => setAiAnswers(e.target.checked)}
              disabled={locked}
            />
            <span>
              <strong>Gemini answers on the line.</strong> Leave this on. Turning it off is a
              diagnostic: it puts <em>you</em> on the call from this computer instead of Gemini, so
              you can check the phone leg works before blaming the AI bridge.
            </span>
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
                <input type="checkbox" checked={listenIn} onChange={(e) => setListenIn(e.target.checked)} />
                <span>
                  Listen in from this computer. Plays both sides through your speakers so you can
                  follow along. Your microphone stays out of the call either way.
                </span>
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
            {busy && (
              <span className={styles.meters}>
                from phone {chunksIn} chunks · from Gemini {Math.round(bytesOut / 1024)} KB
              </span>
            )}
          </div>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {/* Call-object mode renders no remote audio on its own. */}
        <audio ref={remoteAudioRef} autoPlay playsInline hidden />
      </section>

      <section className={styles.card}>
        <h2>Conversation</h2>
        {turns.length === 0 ? (
          <p className={styles.hint}>What you and Gemini say on the phone appears here once the call connects.</p>
        ) : (
          <div className={styles.turns}>
            {turns.map((t) => (
              <p key={t.id} className={t.who === 'person' ? styles.turnPerson : styles.turnGemini}>
                <strong>{t.who === 'person' ? 'Phone' : 'Gemini'}</strong> {t.text}
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
            <div key={row.id} className={styles[LOG_CLASS[row.kind]]}>
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
