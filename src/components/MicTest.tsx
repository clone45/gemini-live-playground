'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MicMatrix } from './MicMatrix';
import styles from './mic-test.module.css';

/**
 * Standalone microphone diagnostic. Deliberately self-contained: it does not
 * use the app's audio layer, so a failure here points at the browser or the
 * device rather than at the Live session code.
 *
 * It captures exactly what the app would send to Gemini (16-bit PCM, mono,
 * 16 kHz) so the captured audio can be played back and listened to.
 */

const TAP_WORKLET = `
class MicTestTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(2048);
    this.i = 0;
    this.blocks = 0;
    this.emptyBlocks = 0;
    this.framesSinceReport = 0;
  }
  toMono(channels) {
    if (!channels || channels.length === 0) return null;
    if (channels.length === 1) return channels[0];
    const length = channels[0].length;
    if (!this.mono || this.mono.length !== length) this.mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let loudest = 0, magnitude = -1;
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][i];
        const a = v < 0 ? -v : v;
        if (a > magnitude) { magnitude = a; loudest = v; }
      }
      this.mono[i] = loudest;
    }
    return this.mono;
  }
  process(inputs) {
    const input = inputs[0];
    const ch = this.toMono(input);
    this.blocks++;
    if (!ch || ch.length === 0) {
      this.emptyBlocks++;
    } else {
      for (let k = 0; k < ch.length; k++) {
        let s = ch[k];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.buf[this.i++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.i === this.buf.length) {
          const out = this.buf.slice(0);
          this.port.postMessage({ pcm: out.buffer }, [out.buffer]);
          this.i = 0;
        }
      }
    }
    this.framesSinceReport += 128;
    if (this.framesSinceReport >= sampleRate / 4) {
      this.framesSinceReport = 0;
      this.port.postMessage({ stats: { blocks: this.blocks, emptyBlocks: this.emptyBlocks } });
    }
    return true;
  }
}
registerProcessor('mic-test-tap', MicTestTap);
`;

interface Row {
  label: string;
  value: string;
  ok?: boolean;
}

interface TrackInfo {
  label: string;
  muted: boolean;
  enabled: boolean;
  readyState: string;
  settings: Record<string, unknown>;
}

const MAX_RECORD_SECONDS = 12;

function pcmToWav(pcm: Int16Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const dataLength = pcm.length * 2;
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataLength, true);
  return new Blob([header, pcm.buffer.slice(0) as ArrayBuffer], { type: 'audio/wav' });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function MicTest() {
  const [env, setEnv] = useState<Row[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [forceSixteenK, setForceSixteenK] = useState(true);
  const [processing, setProcessing] = useState(true);
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [chunks, setChunks] = useState(0);
  const [blocks, setBlocks] = useState({ blocks: 0, emptyBlocks: 0 });
  const [rms, setRms] = useState(0);
  const [peak, setPeak] = useState(0);
  const [contextRate, setContextRate] = useState<number | null>(null);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const [wavUrl, setWavUrl] = useState<string | null>(null);
  const [geminiState, setGeminiState] = useState<string>('');
  const [heard, setHeard] = useState<string>('');

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const recordRef = useRef<Int16Array[]>([]);
  const recordedRef = useRef<Int16Array | null>(null);
  const peakRef = useRef(0);

  // ---- 1. environment, no permission needed --------------------------------

  useEffect(() => {
    // The type system says these always exist. At runtime they do not, which is
    // exactly what this page is here to detect, so probe them dynamically.
    const media = (navigator as Partial<Navigator>).mediaDevices;
    const hasGum = typeof media?.getUserMedia === 'function';

    const rows: Row[] = [
      { label: 'Page origin', value: window.location.origin },
      {
        label: 'Secure context',
        value: String(window.isSecureContext),
        ok: window.isSecureContext,
      },
      {
        label: 'navigator.mediaDevices',
        value: media ? 'available' : 'MISSING',
        ok: Boolean(media),
      },
      {
        label: 'getUserMedia',
        value: hasGum ? 'available' : 'MISSING',
        ok: hasGum,
      },
      {
        label: 'AudioWorklet',
        value: typeof AudioWorkletNode !== 'undefined' ? 'available' : 'MISSING',
        ok: typeof AudioWorkletNode !== 'undefined',
      },
    ];
    setEnv(rows);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter((d) => d.kind === 'audioinput'));
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  // ---- 2. capture ----------------------------------------------------------

  const stop = useCallback(async () => {
    nodeRef.current?.port.close();
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
    setCapturing(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setChunks(0);
    setBlocks({ blocks: 0, emptyBlocks: 0 });
    setRms(0);
    setPeak(0);
    peakRef.current = 0;
    recordRef.current = [];
    recordedRef.current = null;
    setRecordedSeconds(0);
    setHeard('');
    setGeminiState('');
    if (wavUrl) {
      URL.revokeObjectURL(wavUrl);
      setWavUrl(null);
    }

    try {
      if (typeof (navigator as Partial<Navigator>).mediaDevices?.getUserMedia !== 'function') {
        throw new Error('getUserMedia is unavailable. Use http://localhost, not an IP address.');
      }

      const audio: MediaTrackConstraints = processing
        ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (deviceId) audio.deviceId = { exact: deviceId };

      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      streamRef.current = stream;
      await refreshDevices();

      const t = stream.getAudioTracks()[0];
      setTrack({
        label: t?.label || '(no label)',
        muted: t?.muted ?? false,
        enabled: t?.enabled ?? false,
        readyState: t?.readyState ?? 'unknown',
        settings: (t?.getSettings() ?? {}) as Record<string, unknown>,
      });

      const ctx = forceSixteenK ? new AudioContext({ sampleRate: 16000 }) : new AudioContext();
      ctxRef.current = ctx;
      setContextRate(ctx.sampleRate);

      const blobUrl = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'mic-test-tap');
      nodeRef.current = node;

      node.port.onmessage = (ev: MessageEvent<{ pcm?: ArrayBuffer; stats?: { blocks: number; emptyBlocks: number } }>) => {
        if (ev.data.stats) {
          setBlocks(ev.data.stats);
          return;
        }
        if (!ev.data.pcm) return;
        const samples = new Int16Array(ev.data.pcm);

        let sum = 0;
        let localPeak = 0;
        for (let i = 0; i < samples.length; i++) {
          const v = samples[i] / 32768;
          sum += v * v;
          const abs = v < 0 ? -v : v;
          if (abs > localPeak) localPeak = abs;
        }
        setRms(Math.sqrt(sum / samples.length));
        if (localPeak > peakRef.current) {
          peakRef.current = localPeak;
          setPeak(localPeak);
        }
        setChunks((c) => c + 1);

        const maxChunks = Math.ceil((MAX_RECORD_SECONDS * 16000) / 2048);
        if (recordRef.current.length < maxChunks) {
          recordRef.current.push(samples);
          setRecordedSeconds(+((recordRef.current.length * 2048) / 16000).toFixed(1));
        }
      };

      source.connect(node);
      if (ctx.state === 'suspended') await ctx.resume();
      setCapturing(true);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setError(message);
      await stop();
    }
  }, [deviceId, forceSixteenK, processing, refreshDevices, stop, wavUrl]);

  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  // ---- 3. what was captured ------------------------------------------------

  const collect = useCallback((): Int16Array | null => {
    if (recordedRef.current) return recordedRef.current;
    const parts = recordRef.current;
    if (parts.length === 0) return null;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Int16Array(total);
    let offset = 0;
    for (const p of parts) {
      all.set(p, offset);
      offset += p.length;
    }
    recordedRef.current = all;
    return all;
  }, []);

  const playBack = useCallback(async () => {
    const pcm = collect();
    if (!pcm) return;
    const ctx = new AudioContext();
    const buffer = ctx.createBuffer(1, pcm.length, 16000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => void ctx.close();
    source.start();
  }, [collect]);

  const makeWav = useCallback(() => {
    const pcm = collect();
    if (!pcm) return;
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    setWavUrl(URL.createObjectURL(pcmToWav(pcm, 16000)));
  }, [collect, wavUrl]);

  // ---- 4. does Gemini hear it ---------------------------------------------

  const sendToGemini = useCallback(async () => {
    const pcm = collect();
    if (!pcm) return;
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) {
      setGeminiState('NEXT_PUBLIC_GEMINI_API_KEY is not set');
      return;
    }

    setHeard('');
    setGeminiState('connecting…');
    try {
      const { LiveSession } = await import('@/lib/live-session');
      const { Modality } = await import('@google/genai');
      const session = new LiveSession(apiKey);
      let transcript = '';

      await session.connect(
        'gemini-3.8-live',
        { responseModalities: [Modality.AUDIO], inputAudioTranscription: {} },
        {
          onInputTranscription: (text) => {
            transcript += text;
            setHeard(transcript);
          },
          onTurnComplete: () => setGeminiState('done'),
          onError: (e) => setGeminiState(`error: ${e.message}`),
        },
      );

      setGeminiState('streaming the recording…');
      const CHUNK = 2048;
      for (let i = 0; i < pcm.length; i += CHUNK) {
        const slice = pcm.subarray(i, i + CHUNK);
        const copy = new Int16Array(slice);
        session.sendAudio(arrayBufferToBase64(copy.buffer));
        await new Promise((r) => setTimeout(r, (CHUNK / 16000) * 1000));
      }
      setGeminiState('sent, waiting for transcription…');

      const silence = arrayBufferToBase64(new Int16Array(CHUNK).buffer);
      for (let i = 0; i < 40; i++) {
        session.sendAudio(silence);
        await new Promise((r) => setTimeout(r, 128));
      }
      window.setTimeout(() => {
        session.close();
        setGeminiState((s) => (s === 'done' ? 'done' : 'finished'));
      }, 1500);
    } catch (err) {
      setGeminiState(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [collect]);

  const framesArriving = blocks.blocks > 0 && blocks.emptyBlocks < blocks.blocks;
  const meterPct = Math.min(100, Math.round(rms * 300));

  return (
    <main className={styles.page}>
      <h1>Microphone test</h1>
      <p className={styles.lede}>
        Captures exactly what the app sends to Gemini: mono 16-bit PCM at 16 kHz. Play it back to
        hear what Gemini would hear. <a href="/">Back to the console</a>
      </p>

      <section className={styles.card}>
        <h2>1. Environment</h2>
        <table className={styles.table}>
          <tbody>
            {env.map((row) => (
              <tr key={row.label}>
                <th>{row.label}</th>
                <td className={row.ok === false ? styles.bad : row.ok ? styles.good : undefined}>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <MicMatrix />

      <section className={styles.card}>
        <h2>2. Capture</h2>
        <div className={styles.controls}>
          <label>
            Input device
            <select name="device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={capturing}>
              <option value="">System default</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={forceSixteenK}
              onChange={(e) => setForceSixteenK(e.target.checked)}
              disabled={capturing}
            />
            Force a 16 kHz AudioContext (what the app does)
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={processing}
              onChange={(e) => setProcessing(e.target.checked)}
              disabled={capturing}
            />
            Echo cancellation, noise suppression, auto gain
          </label>
          <div className={styles.buttons}>
            {capturing ? (
              <button type="button" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <button type="button" className={styles.primary} onClick={() => void start()}>
                Start capture
              </button>
            )}
          </div>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {capturing && (
          <>
            <div className={styles.meterRow}>
              <span className={styles.meter}>
                <span className={styles.meterFill} style={{ width: `${meterPct}%` }} />
              </span>
              <code>
                rms {rms.toFixed(4)} · peak {peak.toFixed(4)}
              </code>
            </div>
            <p className={rms > 0.01 ? styles.good : styles.bad}>
              {rms > 0.01 ? 'Signal detected. Speak and watch the meter move.' : 'Silence. Say something now.'}
            </p>
            <table className={styles.table}>
              <tbody>
                <tr>
                  <th>AudioContext rate</th>
                  <td>{contextRate} Hz</td>
                </tr>
                <tr>
                  <th>PCM chunks captured</th>
                  <td className={chunks > 0 ? styles.good : styles.bad}>{chunks}</td>
                </tr>
                <tr>
                  <th>Render blocks / empty</th>
                  <td className={framesArriving ? styles.good : styles.bad}>
                    {blocks.blocks} / {blocks.emptyBlocks}
                  </td>
                </tr>
                <tr>
                  <th>Recorded</th>
                  <td>
                    {recordedSeconds}s of {MAX_RECORD_SECONDS}s
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        {track && (
          <details className={styles.details}>
            <summary>Track details</summary>
            <pre>{JSON.stringify(track, null, 2)}</pre>
          </details>
        )}
      </section>

      <section className={styles.card}>
        <h2>3. Hear what was captured</h2>
        <p className={styles.hint}>
          Record a few seconds above, stop, then play it back. Silence here means the browser never
          received audio, so nothing in the app could have worked.
        </p>
        <div className={styles.buttons}>
          <button type="button" onClick={() => void playBack()} disabled={recordedSeconds === 0}>
            Play back
          </button>
          <button type="button" onClick={makeWav} disabled={recordedSeconds === 0}>
            Make a WAV
          </button>
          {wavUrl && (
            <a href={wavUrl} download="mic-test-16k.wav">
              Download
            </a>
          )}
        </div>
      </section>

      <section className={styles.card}>
        <h2>4. Does Gemini hear it</h2>
        <p className={styles.hint}>
          Streams the recording to the Live API exactly as the app does and shows the transcription
          it returns.
        </p>
        <div className={styles.buttons}>
          <button type="button" onClick={() => void sendToGemini()} disabled={recordedSeconds === 0}>
            Send the recording to Gemini
          </button>
        </div>
        {geminiState && <p className={styles.hint}>Status: {geminiState}</p>}
        {heard && (
          <p className={styles.good}>
            Gemini heard: <strong>{heard}</strong>
          </p>
        )}
      </section>
    </main>
  );
}
