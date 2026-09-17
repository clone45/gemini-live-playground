# Vendored audio layer

These files are copied **verbatim** from Google's Live API web console starter:

<https://github.com/google-gemini/live-api-web-console> (`src/lib/`), Apache License 2.0,
Copyright 2024 Google LLC. The license header in each file is intact.

| File                            | Role                                                                     |
| ------------------------------- | ------------------------------------------------------------------------ |
| `utils.ts`                      | `audioContext()` helper that waits for a user gesture; base64 decoding.  |
| `audioworklet-registry.ts`      | Turns worklet source strings into blob URLs; tracks worklets per context. |
| `worklets/audio-processing.ts`  | Mic worklet: Float32 to Int16, 2048-sample chunks.                        |
| `worklets/vol-meter.ts`         | VU meter worklet.                                                         |
| `audio-recorder.ts`             | getUserMedia plus the two worklets; emits `data` and `volume`.            |
| `audio-streamer.ts`             | Scheduled gapless playback of streamed PCM16, with gain-ramped `stop()`.  |

## Why vendored rather than reimplemented

Browser audio capture and gapless playback are full of device-specific traps. An earlier
version of this app hand-rolled both and broke capture, so the working upstream code is used
directly instead. Only the transport layer is ours: upstream predates `ai.live.connect` and
carries its own WebSocket client, which `src/lib/live-session.ts` replaces with the current
`@google/genai` SDK.

The worklets load from blob URLs rather than files under `public/`, which suits the Next.js
build better than a static path would.

## Server rendering: import these lazily

`utils.ts` registers `window` listeners at module scope:

```js
const didInteract = new Promise((res) => {
  window.addEventListener("pointerdown", res, { once: true });
  ...
});
```

That runs on import. Under Next.js it throws during server rendering, Next falls back to
client rendering for that subtree, and the partial server HTML shows up as a hydration
mismatch rather than an obvious error.

So nothing outside `src/lib/audio-modules.ts` may import these files at runtime. That module
loads them with dynamic `import()` and memoizes the result; `useLiveSession` calls it on mount,
which also gets the gesture listener attached before the first Connect click. Type-only imports
(`import type`) are fine anywhere, since they are erased at compile time.

## Local patches

Two worklets carry a marked `LOCAL PATCH`. Both fix the same upstream bug.

`worklets/audio-processing.ts` and `worklets/vol-meter.ts` read `inputs[0][0]`, the **first
channel only**. That is fine for a built-in laptop microphone, which is single-channel. It fails
completely on a multi-channel audio interface carrying a mono source: a Focusrite presenting
"Analogue 1 + 2" hands the browser a two-channel stream with the voice on one channel, so a
processor reading channel 0 gets silence and nothing audible ever reaches the model.

The symptom is specific and misleading. The worklet still runs, hundreds of process calls per
second, and reports no error. Only the samples are empty. An AnalyserNode or a
`createScriptProcessor(4096, 1, 1)` on the same device sounds fine, because both down-mix every
channel to mono first.

Both files now fold all channels together, taking the **largest magnitude** at each sample rather
than averaging. Averaging would halve a signal present on only one channel, costing 6 dB on an
input that is already quiet.

## Local additions

App-specific behaviour lives in wrappers rather than in these files:

- `src/lib/mic-controller.ts` adds pause/resume, device diagnostics, and real error
  propagation. Upstream's `start()` resolves before capture is live, and a rejected
  `getUserMedia` leaves its internal promise permanently pending.
- `src/lib/audio-output.ts` adds a mute that survives an interrupt, an output level meter,
  and a playing/idle signal.
