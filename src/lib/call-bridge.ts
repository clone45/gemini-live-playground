import { loadAudioModules } from './audio-modules';
import { arrayBufferToBase64, base64ToInt16 } from './base64';

/**
 * Bridges a Daily call leg to a Gemini Live session, entirely in the browser.
 *
 *   phone --> Daily --> TrackRecorder --> 16 kHz PCM --> Gemini
 *   phone <-- Daily <-- CallAudioSink <-- 24 kHz PCM <-- Gemini
 *
 * The browser is the AI participant in the room: it consumes the caller's
 * remote track and publishes Gemini's speech back as its own microphone track.
 * No media server, no transcoding beyond what Web Audio already does.
 */

export const GEMINI_INPUT_RATE = 16000;
export const GEMINI_OUTPUT_RATE = 24000;

/**
 * Reads an existing MediaStreamTrack, the caller's audio, into 16 kHz PCM.
 *
 * The vendored recorder always opens its own microphone, so this reuses the
 * vendored worklet source against a supplied track instead.
 */
export class TrackRecorder {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(private readonly onChunk: (base64Pcm: string) => void) {}

  get running(): boolean {
    return this.ctx !== null;
  }

  async start(track: MediaStreamTrack): Promise<void> {
    if (this.ctx) await this.stop();
    const mods = await loadAudioModules();

    // A fresh context, not the shared cached one: this must run at 16 kHz.
    const ctx = new AudioContext({ sampleRate: GEMINI_INPUT_RATE });
    const workletName = 'call-leg-recorder';
    const url = mods.createWorkletFromSrc(workletName, mods.recordingWorklet);
    await ctx.audioWorklet.addModule(url);

    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, workletName);
    node.port.onmessage = (ev: MessageEvent<{ data?: { int16arrayBuffer?: ArrayBuffer } }>) => {
      const buffer = ev.data?.data?.int16arrayBuffer;
      if (buffer) this.onChunk(arrayBufferToBase64(buffer));
    };
    source.connect(node);

    if (ctx.state === 'suspended') await ctx.resume();

    this.ctx = ctx;
    this.node = node;
    this.source = source;
  }

  async stop(): Promise<void> {
    const { ctx, node, source } = this;
    this.ctx = null;
    this.node = null;
    this.source = null;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    source?.disconnect();
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
  }
}

/**
 * Plays Gemini's 24 kHz PCM into a MediaStreamTrack that Daily can publish.
 *
 * The vendored AudioStreamer always targets `context.destination`, the local
 * speakers. This schedules the same way but into a MediaStreamAudioDestination
 * so the audio leaves over the call, with an optional local monitor.
 */
export class CallAudioSink {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly monitor: GainNode;
  private readonly active = new Set<AudioBufferSourceNode>();
  private nextStart = 0;

  /** Lead time before a burst starts playing, to absorb jitter. */
  private static readonly LEAD_SECONDS = 0.08;

  onSpeakingChange?: (speaking: boolean) => void;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: GEMINI_OUTPUT_RATE });
    this.gain = this.ctx.createGain();
    this.destination = this.ctx.createMediaStreamDestination();
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = 0; // silent locally until asked for
    this.gain.connect(this.destination);
    this.gain.connect(this.monitor);
    this.monitor.connect(this.ctx.destination);
  }

  /** The track to publish into the call. */
  get track(): MediaStreamTrack {
    return this.destination.stream.getAudioTracks()[0];
  }

  /** Hear what the caller hears, locally. */
  set monitoring(on: boolean) {
    this.monitor.gain.value = on ? 1 : 0;
  }

  get speaking(): boolean {
    return this.active.size > 0;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  enqueue(base64Pcm: string): void {
    const int16 = base64ToInt16(base64Pcm);
    if (int16.length === 0) return;

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

    const buffer = this.ctx.createBuffer(1, float32.length, GEMINI_OUTPUT_RATE);
    buffer.copyToChannel(float32, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.ctx.currentTime;
    if (this.nextStart < now + CallAudioSink.LEAD_SECONDS) {
      this.nextStart = now + CallAudioSink.LEAD_SECONDS;
    }
    source.start(this.nextStart);
    this.nextStart += buffer.duration;

    const wasSpeaking = this.speaking;
    this.active.add(source);
    source.onended = () => {
      this.active.delete(source);
      if (this.active.size === 0) this.onSpeakingChange?.(false);
    };
    if (!wasSpeaking) this.onSpeakingChange?.(true);
  }

  /** Drop everything queued, for barge-in. */
  interrupt(): void {
    for (const source of this.active) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already finished
      }
    }
    const wasSpeaking = this.active.size > 0;
    this.active.clear();
    this.nextStart = 0;
    if (wasSpeaking) this.onSpeakingChange?.(false);
  }

  async close(): Promise<void> {
    this.interrupt();
    if (this.ctx.state !== 'closed') await this.ctx.close().catch(() => {});
  }
}
