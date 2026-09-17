import { loadAudioModules } from './audio-modules';
import { base64ToUint8 } from './base64';
import type { AudioStreamer } from './vendor/live-api-web-console/audio-streamer';

export const OUTPUT_SAMPLE_RATE = 24000;

/**
 * Playback of the 24 kHz PCM Gemini streams back, on top of the vendored
 * `AudioStreamer` (scheduled, gapless, with a gain ramp on interrupt).
 *
 * Adds the app-level bits: a mute that survives an interrupt (upstream
 * recreates its gain node 200 ms after `stop()`, which would reset it), an
 * output level meter, and a playing/idle signal.
 */
export class AudioOutput {
  private streamer: AudioStreamer | null = null;
  private ctx: AudioContext | null = null;
  private isMuted = false;
  private isPlaying = false;
  private volume = 0;

  /** Fires when playback transitions between idle and speaking. */
  onPlayingChange?: (playing: boolean) => void;

  /** Must be called from a user gesture; the helper waits for one if needed. */
  async init(): Promise<void> {
    if (this.streamer) {
      await this.streamer.resume();
      this.applyMute();
      return;
    }

    const mods = await loadAudioModules();
    const ctx = await mods.audioContext({ id: 'gemini-live-output', sampleRate: OUTPUT_SAMPLE_RATE });
    const streamer = new mods.AudioStreamer(ctx);
    // The vendored handler receives the raw MessageEvent from the worklet port.
    const onMeter = (ev: MessageEvent<{ volume: number }>) => {
      this.volume = ev.data?.volume ?? 0;
    };
    await streamer.addWorklet('vumeter-out', mods.volMeterWorklet, onMeter);
    streamer.onComplete = () => this.setPlaying(false);

    this.ctx = ctx;
    this.streamer = streamer;
    await streamer.resume();
    this.applyMute();
  }

  private setPlaying(playing: boolean): void {
    if (this.isPlaying === playing) return;
    this.isPlaying = playing;
    if (!playing) this.volume = 0;
    this.onPlayingChange?.(playing);
  }

  private applyMute(): void {
    const gain = this.streamer?.gainNode;
    if (gain && this.ctx) gain.gain.setValueAtTime(this.isMuted ? 0 : 1, this.ctx.currentTime);
  }

  set muted(value: boolean) {
    this.isMuted = value;
    this.applyMute();
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  /** Output level in 0..1, from the vendored VU meter worklet. */
  level(): number {
    return this.isMuted ? 0 : this.volume;
  }

  enqueue(base64Pcm: string): void {
    const streamer = this.streamer;
    if (!streamer) return;
    streamer.addPCM16(base64ToUint8(base64Pcm));
    // The gain node is replaced shortly after every stop(), so reassert mute.
    this.applyMute();
    this.setPlaying(true);
  }

  /** Stop and discard everything queued (the model was interrupted). */
  interrupt(): void {
    this.streamer?.stop();
    this.setPlaying(false);
    // Upstream rebuilds the gain node 200 ms later; restore mute after that.
    window.setTimeout(() => this.applyMute(), 250);
  }

  async close(): Promise<void> {
    this.interrupt();
    this.streamer = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
  }
}
