import { loadAudioModules } from './audio-modules';
import type { AudioRecorder } from './vendor/live-api-web-console/audio-recorder';

export const MIC_SAMPLE_RATE = 16000;

export interface MicInfo {
  deviceLabel: string;
  /** Rate of the capture AudioContext (16 kHz; the browser resamples the device). */
  contextSampleRate: number;
  /** Native rate the capture track reports, when the browser exposes it. */
  trackSampleRate: number | null;
  echoCancellation: boolean | null;
}

export interface MicEvents {
  /** Base64 16-bit PCM at 16 kHz, ready for `sendRealtimeInput`. */
  onChunk: (base64Pcm: string) => void;
  /** Smoothed input level in 0..1, from the vendored VU meter worklet. */
  onVolume?: (volume: number) => void;
}

/**
 * Wraps the vendored `AudioRecorder` with the things this app needs and the
 * upstream class does not provide:
 *
 *  - pause/resume that keeps the device open, so toggling the mic never
 *    re-prompts for permission;
 *  - device and sample-rate diagnostics for the event log;
 *  - real error propagation. Upstream's `start()` returns before capture is
 *    running, and a rejected `getUserMedia` leaves its internal promise
 *    forever pending, so failures would otherwise be silent.
 *
 * The vendored file itself is untouched.
 */
export class MicController {
  private recorder: AudioRecorder | null = null;
  private isPaused = false;
  private info: MicInfo | null = null;

  constructor(private readonly events: MicEvents) {}

  get running(): boolean {
    return this.recorder !== null;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get micInfo(): MicInfo | null {
    return this.info;
  }

  pause(): void {
    this.isPaused = true;
    this.recorder?.stream?.getAudioTracks().forEach((t) => (t.enabled = false));
    this.events.onVolume?.(0);
  }

  resume(): void {
    this.isPaused = false;
    this.recorder?.stream?.getAudioTracks().forEach((t) => (t.enabled = true));
  }

  async start(): Promise<MicInfo> {
    if (this.info) return this.info;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'This page has no microphone API. Capture requires a secure context: open the app on ' +
          'http://localhost:3000 rather than an http:// IP address, or serve it over https.',
      );
    }

    const mods = await loadAudioModules();

    // Ask for permission here so denial surfaces as a real rejection. Once
    // granted, the recorder's own getUserMedia call resolves immediately.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());

    const recorder = new mods.AudioRecorder(MIC_SAMPLE_RATE);
    recorder.on('data', (base64: string) => {
      if (!this.isPaused) this.events.onChunk(base64);
    });
    recorder.on('volume', (volume: number) => {
      this.events.onVolume?.(this.isPaused ? 0 : volume);
    });

    this.recorder = recorder;
    void recorder.start();

    // Upstream resolves start() before capture is live, so wait for the stream.
    const deadline = Date.now() + 10000;
    while (!(recorder.recording && recorder.stream && recorder.audioContext)) {
      if (Date.now() > deadline) {
        this.recorder = null;
        recorder.stop();
        throw new Error('Microphone did not start within 10 seconds');
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.isPaused) recorder.stream.getAudioTracks().forEach((t) => (t.enabled = false));

    const track = recorder.stream.getAudioTracks()[0];
    const settings = track?.getSettings() ?? {};
    this.info = {
      deviceLabel: track?.label || 'default microphone',
      contextSampleRate: recorder.audioContext.sampleRate,
      trackSampleRate: settings.sampleRate ?? null,
      echoCancellation: settings.echoCancellation ?? null,
    };
    return this.info;
  }

  async stop(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    this.info = null;
    if (!recorder) return;

    recorder.removeAllListeners();
    recorder.stop();
    // Upstream leaves the AudioContext open; browsers cap how many a page may
    // hold, so close it here.
    const ctx = recorder.audioContext;
    if (ctx && ctx.state !== 'closed') {
      await new Promise((r) => setTimeout(r, 50));
      await ctx.close().catch(() => {});
    }
  }
}
