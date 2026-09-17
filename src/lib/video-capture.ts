export type VideoSource = 'camera' | 'screen';

export interface FrameCaptureOptions {
  /** Frames per second to send. Gemini Live accepts at most 1. */
  fps?: number;
  /** Frames are downscaled so their width never exceeds this. */
  maxWidth?: number;
  /** JPEG quality 0..1. */
  quality?: number;
}

/**
 * Grabs still frames from a camera or screen share and hands them over as
 * base64 JPEG, which is what `sendRealtimeInput({ video })` expects.
 */
export class FrameCapture {
  private stream: MediaStream | null = null;
  private timer: number | null = null;
  private currentSource: VideoSource | null = null;
  private readonly canvas = document.createElement('canvas');
  private readonly fps: number;
  private readonly maxWidth: number;
  private readonly quality: number;

  /** Fires when the user stops sharing from the browser's own UI. */
  onEnded?: () => void;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFrame: (base64Jpeg: string) => void,
    options: FrameCaptureOptions = {},
  ) {
    this.fps = options.fps ?? 1;
    this.maxWidth = options.maxWidth ?? 768;
    this.quality = options.quality ?? 0.7;
  }

  get source(): VideoSource | null {
    return this.currentSource;
  }

  async start(source: VideoSource): Promise<void> {
    await this.stop();

    const stream =
      source === 'camera'
        ? await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
            audio: false,
          })
        : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });

    this.stream = stream;
    this.currentSource = source;
    this.video.srcObject = stream;
    this.video.muted = true;
    await this.video.play();

    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      void this.stop();
      this.onEnded?.();
    });

    this.timer = window.setInterval(() => this.captureFrame(), 1000 / this.fps);
  }

  private captureFrame(): void {
    const { video, canvas } = this;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const scale = Math.min(1, this.maxWidth / vw);
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', this.quality);
    this.onFrame(dataUrl.slice(dataUrl.indexOf(',') + 1));
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.currentSource = null;
    if (this.video.srcObject) {
      this.video.pause();
      this.video.srcObject = null;
    }
  }
}
