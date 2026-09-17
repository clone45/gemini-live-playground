/**
 * Browser-only loader for the vendored audio layer.
 *
 * The vendored `utils.ts` attaches `window` listeners at module scope, so a
 * static import of anything that reaches it throws during server rendering and
 * makes Next.js fall back to client rendering, which shows up as a hydration
 * mismatch. Importing it lazily keeps that code out of the server bundle
 * entirely.
 *
 * `loadAudioModules()` is memoized, and `useLiveSession` calls it on mount so
 * the vendored gesture listener is registered before the user clicks Connect.
 */
export interface AudioModules {
  AudioRecorder: (typeof import('./vendor/live-api-web-console/audio-recorder'))['AudioRecorder'];
  AudioStreamer: (typeof import('./vendor/live-api-web-console/audio-streamer'))['AudioStreamer'];
  audioContext: (typeof import('./vendor/live-api-web-console/utils'))['audioContext'];
  volMeterWorklet: string;
}

let pending: Promise<AudioModules> | null = null;

export function loadAudioModules(): Promise<AudioModules> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('The audio modules are browser-only'));
  }
  if (!pending) {
    pending = Promise.all([
      import('./vendor/live-api-web-console/audio-recorder'),
      import('./vendor/live-api-web-console/audio-streamer'),
      import('./vendor/live-api-web-console/utils'),
      import('./vendor/live-api-web-console/worklets/vol-meter'),
    ])
      .then(([recorder, streamer, utils, volMeter]) => ({
        AudioRecorder: recorder.AudioRecorder,
        AudioStreamer: streamer.AudioStreamer,
        audioContext: utils.audioContext,
        volMeterWorklet: volMeter.default,
      }))
      .catch((err: unknown) => {
        pending = null; // let a later attempt retry
        throw err;
      });
  }
  return pending;
}
