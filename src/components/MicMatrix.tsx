'use client';

import { useCallback, useRef, useState } from 'react';
import styles from './mic-test.module.css';

/**
 * Runs the same microphone through every capture path we might use and reports
 * which ones actually carry signal.
 *
 * The reference project on this machine captures with a native-rate
 * `AudioContext` and an AnalyserNode, and uses no AudioWorklet at all, while
 * this app forces a 16 kHz context and reads through a worklet. This isolates
 * those two variables, plus whether a worklet needs connecting to the
 * destination to be pulled by the graph.
 */

const MEASURE_WORKLET = `
class MicMeasure extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peak = 0; this.sum = 0; this.n = 0; this.calls = 0; this.acc = 0;
    this.channelPeaks = [];
  }
  process(inputs) {
    const input = inputs[0];
    this.calls++;
    if (input && input.length) {
      const length = input[0].length;
      // Per-channel peaks, so a signal sitting on a later channel is visible.
      for (let c = 0; c < input.length; c++) {
        let p = this.channelPeaks[c] || 0;
        const samples = input[c];
        for (let i = 0; i < samples.length; i++) {
          const a = samples[i] < 0 ? -samples[i] : samples[i];
          if (a > p) p = a;
        }
        this.channelPeaks[c] = p;
      }
      // Combined signal: loudest channel per sample, which keeps full level
      // when only one channel carries audio.
      for (let i = 0; i < length; i++) {
        let loudest = 0, magnitude = -1;
        for (let c = 0; c < input.length; c++) {
          const v = input[c][i];
          const a = v < 0 ? -v : v;
          if (a > magnitude) { magnitude = a; loudest = v; }
        }
        if (magnitude > this.peak) this.peak = magnitude;
        this.sum += loudest * loudest;
        this.n++;
      }
    }
    this.acc += 128;
    if (this.acc >= sampleRate / 10) {
      this.acc = 0;
      this.port.postMessage({
        peak: this.peak,
        rms: this.n ? Math.sqrt(this.sum / this.n) : 0,
        calls: this.calls,
        channelPeaks: this.channelPeaks.slice(0),
      });
    }
    return true;
  }
}
registerProcessor('mic-measure', MicMeasure);
`;

type NodeKind = 'analyser' | 'script' | 'worklet';

interface PathSpec {
  id: string;
  label: string;
  rate: number | null; // null = the device's native rate
  node: NodeKind;
  connectDestination: boolean;
  note?: string;
}

const PATHS: PathSpec[] = [
  { id: 'native-analyser', label: 'Native rate · AnalyserNode', rate: null, node: 'analyser', connectDestination: false, note: 'What your working project uses' },
  { id: 'native-script', label: 'Native rate · ScriptProcessor', rate: null, node: 'script', connectDestination: true },
  { id: 'native-worklet', label: 'Native rate · AudioWorklet', rate: null, node: 'worklet', connectDestination: false },
  { id: 'native-worklet-dest', label: 'Native rate · AudioWorklet → destination', rate: null, node: 'worklet', connectDestination: true },
  { id: '16k-analyser', label: '16 kHz · AnalyserNode', rate: 16000, node: 'analyser', connectDestination: false },
  { id: '16k-script', label: '16 kHz · ScriptProcessor', rate: 16000, node: 'script', connectDestination: true },
  { id: '16k-worklet', label: '16 kHz · AudioWorklet', rate: 16000, node: 'worklet', connectDestination: false, note: 'What this app does' },
  { id: '16k-worklet-dest', label: '16 kHz · AudioWorklet → destination', rate: 16000, node: 'worklet', connectDestination: true },
];

interface Result {
  id: string;
  contextRate?: number;
  peak?: number;
  rms?: number;
  calls?: number;
  channelPeaks?: number[];
  error?: string;
}

const MEASURE_MS = 2500;

export function MicMatrix() {
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [constraintNote, setConstraintNote] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const measure = useCallback(async (spec: PathSpec, stream: MediaStream): Promise<Result> => {
    let ctx: AudioContext | null = null;
    try {
      ctx = spec.rate ? new AudioContext({ sampleRate: spec.rate }) : new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);

      let peak = 0;
      let rms = 0;
      let calls = 0;
      let channelPeaks: number[] | undefined;
      let cleanup = () => {};

      if (spec.node === 'analyser') {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        if (spec.connectDestination) analyser.connect(ctx.destination);
        const data = new Float32Array(analyser.fftSize);
        const timer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(data);
          calls++;
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = data[i];
            const a = v < 0 ? -v : v;
            if (a > peak) peak = a;
            sum += v * v;
          }
          rms = Math.sqrt(sum / data.length);
        }, 50);
        cleanup = () => window.clearInterval(timer);
      } else if (spec.node === 'script') {
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (ev) => {
          const data = ev.inputBuffer.getChannelData(0);
          calls++;
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = data[i];
            const a = v < 0 ? -v : v;
            if (a > peak) peak = a;
            sum += v * v;
          }
          rms = Math.sqrt(sum / data.length);
        };
        source.connect(proc);
        proc.connect(ctx.destination); // required for it to fire at all
        cleanup = () => {
          proc.onaudioprocess = null;
          proc.disconnect();
        };
      } else {
        const url = URL.createObjectURL(new Blob([MEASURE_WORKLET], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'mic-measure');
        node.port.onmessage = (
          ev: MessageEvent<{ peak: number; rms: number; calls: number; channelPeaks: number[] }>,
        ) => {
          peak = ev.data.peak;
          rms = ev.data.rms;
          calls = ev.data.calls;
          channelPeaks = ev.data.channelPeaks;
        };
        source.connect(node);
        if (spec.connectDestination) node.connect(ctx.destination);
        cleanup = () => {
          node.port.onmessage = null;
          node.disconnect();
        };
      }

      await new Promise((r) => setTimeout(r, MEASURE_MS));
      cleanup();
      source.disconnect();
      const contextRate = ctx.sampleRate;
      await ctx.close();
      return { id: spec.id, contextRate, peak, rms, calls, channelPeaks };
    } catch (err) {
      if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
      return { id: spec.id, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setFatal(null);
    setResults({});
    setConstraintNote(null);
    cancelRef.current = false;

    let stream: MediaStream | null = null;
    try {
      // Exactly the constraints the working project uses.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      const s = track?.getSettings() ?? {};
      setConstraintNote(
        `Device "${track?.label || 'unknown'}" · track ${s.sampleRate ?? '?'} Hz · ` +
          `echoCancellation=${String(s.echoCancellation)} · channels=${s.channelCount ?? '?'}`,
      );

      for (const spec of PATHS) {
        if (cancelRef.current) break;
        setCurrent(spec.id);
        const result = await measure(spec, stream);
        setResults((prev) => ({ ...prev, [spec.id]: result }));
      }
    } catch (err) {
      setFatal(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setCurrent(null);
      setRunning(false);
    }
  }, [measure]);

  const done = Object.keys(results).length;
  const withSignal = Object.values(results).filter((r) => (r.peak ?? 0) > 0.01);
  const anySignal = withSignal.length > 0;
  const allDone = done === PATHS.length && !running;

  return (
    <section className={styles.card}>
      <h2>Capture path comparison</h2>
      <p className={styles.hint}>
        Runs your microphone through every capture path, {MEASURE_MS / 1000} seconds each, about{' '}
        {Math.round((PATHS.length * MEASURE_MS) / 1000)} seconds in total.{' '}
        <strong>Speak continuously the whole time.</strong> Any path showing a peak means the
        microphone reached the browser through it.
      </p>

      <div className={styles.buttons}>
        <button type="button" className={styles.primary} onClick={() => void run()} disabled={running}>
          {running ? 'Running, keep talking…' : 'Run the comparison'}
        </button>
      </div>

      {constraintNote && <p className={styles.hint}>{constraintNote}</p>}
      {fatal && <p className={styles.error}>{fatal}</p>}

      <table className={styles.table}>
        <tbody>
          {PATHS.map((spec) => {
            const r = results[spec.id];
            const active = current === spec.id;
            const signal = (r?.peak ?? 0) > 0.01;
            return (
              <tr key={spec.id}>
                <th>
                  {spec.label}
                  {spec.note && <em className={styles.pathNote}> {spec.note}</em>}
                </th>
                <td className={r?.error ? styles.bad : signal ? styles.good : r ? styles.bad : undefined}>
                  {active && 'measuring…'}
                  {!active && !r && '—'}
                  {r?.error && r.error}
                  {r && !r.error && (
                    <>
                      {signal ? 'SIGNAL' : 'silent'} · peak {r.peak?.toFixed(4)} · rms {r.rms?.toFixed(4)} ·{' '}
                      {r.contextRate} Hz · {r.calls} reads
                      {r.channelPeaks && r.channelPeaks.length > 1 && (
                        <em className={styles.pathNote}>
                          per channel: {r.channelPeaks.map((p, i) => `ch${i} ${p.toFixed(4)}`).join(' · ')}
                        </em>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {allDone && anySignal && (
        <p className={styles.good}>
          {withSignal.length} of {PATHS.length} paths carried audio. The rows marked silent are the
          broken ingredients.
        </p>
      )}

      {allDone && !anySignal && (
        <div className={styles.bad}>
          <p>
            No path carried audio, so the browser never received sound on this origin. Since the
            same microphone works on other sites, the most likely cause is a per-site setting rather
            than the device.
          </p>
          <ul className={styles.checklist}>
            <li>
              <strong>Chrome picks a microphone per site.</strong> Click the icon to the left of the
              address bar, open Site settings, and check which device Microphone is set to for this
              origin. If it points at a disconnected headset or a virtual cable, it will be silent
              here while every other site works.
            </li>
            <li>
              The device shown above is what this origin was given. Compare it with the device your
              working mic-check site reports.
            </li>
            <li>
              Try the device selector in the next section, choosing each input explicitly rather
              than the system default.
            </li>
            <li>Windows: Settings, Privacy, Microphone, and confirm the browser is allowed.</li>
          </ul>
        </div>
      )}
    </section>
  );
}
