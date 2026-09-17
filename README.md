# Gemini Live Playground

A small Next.js app for poking at the **Gemini Live API** (`gemini-3.8-live`) from the browser:
two-way audio, optional camera or screen video, live transcripts of both sides, asynchronous
function calling, and a raw event log of everything the server sends.

It uses the official `@google/genai` SDK's `ai.live.connect(...)` straight from the browser over
WebSockets. There is no proxy server.

## Run it

```bash
npm install
cp .env.example .env.local   # then paste your Gemini API key
npm run dev
```

Open <http://localhost:3000>, click **Connect**, allow the microphone, and talk. Chrome is the
best-tested browser for the Web Audio worklet used for capture.

## Microphone test page

If the microphone seems dead, open <http://localhost:3000/mic-test>. It shares no code with the
app's audio layer, so it separates a browser or device problem from a bug in the session code.

The **capture path comparison** at the top is the fast way in. It runs the microphone through
eight combinations of sample rate and node type, 2.5 seconds each, and reports peak and RMS for
every one, including per-channel peaks. A path that shows signal where another shows silence names
the broken ingredient immediately.

Below that, four manual steps:

1. **Environment.** Secure context, `mediaDevices`, `getUserMedia`, AudioWorklet.
2. **Capture.** Choose the input device, watch a live meter, and see PCM chunk counts plus render
   block counts.
3. **Hear what was captured.** Play back, or download as a WAV, the exact 16 kHz PCM that would be
   sent. Silence here means the browser never received audio.
4. **Does Gemini hear it.** Streams that recording to the Live API and prints the transcription.

### One trap worth knowing

A worklet that reads only `inputs[0][0]` gets the first channel. On a multi-channel audio interface
carrying a mono source, a USB interface presenting "Analogue 1 + 2", say, the voice can sit entirely
on the second channel. The worklet then runs perfectly, hundreds of calls per second with no error,
and captures silence. An AnalyserNode on the same device sounds fine because it down-mixes every
channel first. The vendored worklets are patched to fold all channels together; see
`src/lib/vendor/live-api-web-console/README.md`.

Other scripts:

| Script                     | What it does                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- |
| `npm run smoke`            | Node-only check: connects, sends a text prompt, prints audio bytes received.    |
| `node scripts/audio-roundtrip.mjs` | Has Gemini speak a sentence, then feeds it back as microphone input.    |
| `npm run typecheck`        | `tsc --noEmit`.                                                                 |
| `npm run build`            | Production build.                                                               |

## What's in the box

| Path                          | Role                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `src/lib/live-session.ts`     | Thin wrapper over `ai.live.connect`. Unpacks `LiveServerMessage` into typed callbacks.    |
| `src/lib/vendor/…`            | Google's audio capture and playback layer, vendored. See its own README.                  |
| `src/lib/audio-modules.ts`    | Browser-only loader for that layer. Nothing else may import it at runtime.                |
| `src/lib/mic-controller.ts`   | Wraps the vendored recorder: pause/resume, device diagnostics, real error propagation.    |
| `src/lib/audio-output.ts`     | Wraps the vendored streamer: mute that survives an interrupt, level meter, playing state. |
| `src/lib/video-capture.ts`    | Camera or screen frames as JPEG at 1 fps.                                                 |
| `src/lib/tools.ts`            | Demo function declarations and their implementations.                                     |
| `src/hooks/useLiveSession.ts` | Session state: connect and reconnect, transcript, tool dispatch, stats, media toggles.    |
| `src/components/*`            | The UI, plus the microphone test page.                                                    |

Both pages render client-side only, via `next/dynamic` with `ssr: false`. They are entirely live
device and socket state, so server rendering gains nothing and only invites hydration mismatches.

## Demo tools

All tools are declared `NON_BLOCKING` (the default on Gemini 3.8 Live), so the model keeps talking
while they run. Each response carries a `scheduling` hint:

| Tool               | Try saying                                  | Scheduling  |
| ------------------ | ------------------------------------------- | ----------- |
| `get_current_time` | "What time is it?"                          | `WHEN_IDLE` |
| `set_accent_color` | "Make the accent color orange"              | `WHEN_IDLE` |
| `start_timer`      | "Start a 20 second timer"                   | `INTERRUPT` (fires when the timer ends) |
| `save_note`        | "Make a note that the build is green"       | `SILENT`    |

The timer is the interesting one: the tool response is sent seconds after the call, and
`INTERRUPT` makes the model break in to announce it.

## Notes on Gemini 3.8 Live

- Model string is `gemini-3.8-live`. It replaces `gemini-3.1-flash-live-preview` and the 2.5
  `native-audio` models.
- Input audio is `audio/pcm;rate=16000`, output is 24 kHz PCM. Video frames go in as JPEG, max 1 fps.
- `thinkingLevel` is not supported on 3.8 (it reasons interleaved with speech). Affective dialog was
  removed from the API. Proactive audio is always on and `proactiveAudio: false` is an error.
- Session resumption is enabled by default in the settings panel; on a server-initiated close the app
  reconnects with the last resumption handle. Context window compression (sliding window) is also on,
  which lifts the session-length cap.

## About the API key

> **Do not deploy this as-is.** The key is read from `NEXT_PUBLIC_GEMINI_API_KEY`, and the
> `NEXT_PUBLIC_` prefix tells Next.js to inline the value into the JavaScript bundle at build time.
> Anyone loading a hosted copy can read it. That trade is deliberate for a local playground, where
> it keeps the app to a single process with no proxy.

`.env.local` is gitignored and never committed. Copy `.env.example` and paste your own key from
[Google AI Studio](https://aistudio.google.com/apikey).

To host this, switch to [ephemeral tokens](https://ai.google.dev/gemini-api/docs/ephemeral-tokens):
a Next.js route handler mints a short-lived token server-side with `ai.authTokens.create(...)`,
keeping the real key on the server, and the browser connects with
`new GoogleGenAI({ apiKey: token.name, httpOptions: { apiVersion: 'v1alpha' } })`.

## Credits and licence

This project is MIT licensed; see `LICENSE`.

The audio capture and playback layer under `src/lib/vendor/live-api-web-console/` is copied from
Google's [Live API web console](https://github.com/google-gemini/live-api-web-console), Apache
License 2.0, Copyright 2024 Google LLC. The original license headers are intact, local patches are
marked, and the reasoning is recorded in that directory's README.

## References

- [Live API overview](https://ai.google.dev/gemini-api/docs/live-api)
- [Get started with the SDK](https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk)
- [Capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Tools in the Live API](https://ai.google.dev/gemini-api/docs/live-api/tools)
- [Gemini 3.8 Live model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)
