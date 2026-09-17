/**
 * Audio round-trip check for the Live API, no browser involved.
 *
 *  1. Session A: ask gemini-3.8-live to speak a sentence; capture its 24 kHz PCM.
 *  2. Write it as a WAV (usable as a fake microphone file for Chrome:
 *     --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>%noloop).
 *  3. Session B: resample to 16 kHz and stream it back as realtime microphone
 *     input in 2048-sample chunks at real-time pace. Success = the server
 *     transcribes it (inputTranscription) and the model replies.
 *
 *   node scripts/audio-roundtrip.mjs [out.wav]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';

const OUT_WAV = process.argv[2] ?? 'user-utterance.wav';
const MODEL = 'gemini-3.8-live';
const SENTENCE = 'Hey there, can you tell me one fun fact about octopuses?';

function loadKey() {
  if (process.env.NEXT_PUBLIC_GEMINI_API_KEY) return process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  const match = env.match(/^NEXT_PUBLIC_GEMINI_API_KEY=(.+)$/m);
  if (!match) throw new Error('No API key found');
  return match[1].trim();
}

const ai = new GoogleGenAI({ apiKey: loadKey() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a session and resolve with helpers; `onMessage` sees every server message. */
function openSession(config, onMessage) {
  return new Promise((resolve, reject) => {
    let session;
    ai.live
      .connect({
        model: MODEL,
        config,
        callbacks: {
          onmessage: (m) => onMessage(m, session),
          onerror: (e) => console.log('  [error]', e.message ?? e),
          onclose: (e) => console.log('  [close]', e.code, e.reason || ''),
        },
      })
      .then((s) => {
        session = s;
        resolve(s);
      })
      .catch(reject);
  });
}

// ---------- 1. get speech from the model ----------
console.log('1. Generating speech for:', JSON.stringify(SENTENCE));
const pcm24Chunks = [];
let genDone;
const genFinished = new Promise((r) => (genDone = r));
const sessionA = await openSession(
  {
    responseModalities: [Modality.AUDIO],
    systemInstruction: 'You repeat the requested sentence verbatim and say nothing else.',
  },
  (m) => {
    for (const p of m.serverContent?.modelTurn?.parts ?? []) {
      if (p.inlineData?.data) pcm24Chunks.push(Buffer.from(p.inlineData.data, 'base64'));
    }
    if (m.serverContent?.turnComplete) genDone();
  },
);
sessionA.sendRealtimeInput({ text: `Say exactly this sentence, and nothing else: "${SENTENCE}"` });
await Promise.race([genFinished, sleep(25000)]);
sessionA.close();

const pcm24 = Buffer.concat(pcm24Chunks);
console.log(`   got ${pcm24.length} bytes of 24 kHz PCM (${(pcm24.length / 2 / 24000).toFixed(2)} s)`);
if (pcm24.length === 0) {
  console.log('FAIL: no audio generated');
  process.exit(1);
}

// ---------- 2. write WAV ----------
function writeWav(path, pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}
// Pad with 1.5 s of silence so end-of-speech detection has something to see.
const silence24 = Buffer.alloc(24000 * 2 * 1.5);
writeWav(OUT_WAV, Buffer.concat([pcm24, silence24]), 24000);
console.log('2. Wrote', OUT_WAV);

// ---------- 3. feed it back as microphone input ----------
function resampleTo16k(pcm) {
  const src = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const ratio = 24000 / 16000;
  const out = new Int16Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const s0 = src[i0];
    const s1 = src[Math.min(i0 + 1, src.length - 1)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

console.log('3. Streaming it back as 16 kHz microphone audio');
const pcm16 = resampleTo16k(Buffer.concat([pcm24, silence24]));
let inputText = '';
let outputText = '';
let replyAudioBytes = 0;
let replyDone;
const replyFinished = new Promise((r) => (replyDone = r));

const sessionB = await openSession(
  {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: 'You are a concise voice assistant. Answer in one sentence.',
  },
  (m) => {
    const c = m.serverContent;
    if (c?.inputTranscription?.text) {
      inputText += c.inputTranscription.text;
      console.log('   [inputTranscription]', JSON.stringify(c.inputTranscription.text));
    }
    if (c?.outputTranscription?.text) outputText += c.outputTranscription.text;
    for (const p of c?.modelTurn?.parts ?? []) {
      if (p.inlineData?.data) replyAudioBytes += Buffer.from(p.inlineData.data, 'base64').length;
    }
    if (c?.interrupted) console.log('   [interrupted]');
    if (c?.turnComplete) {
      console.log('   [turnComplete]');
      replyDone();
    }
  },
);

const CHUNK = 2048; // samples, same as the browser worklet
for (let i = 0; i < pcm16.length; i += CHUNK) {
  const slice = pcm16.subarray(i, i + CHUNK);
  const bytes = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
  sessionB.sendRealtimeInput({ audio: { data: bytes.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  await sleep((CHUNK / 16000) * 1000);
}
// Keep the "mic" open with silence while the model answers.
const silentChunk = Buffer.alloc(CHUNK * 2).toString('base64');
const keepAlive = setInterval(() => {
  sessionB.sendRealtimeInput({ audio: { data: silentChunk, mimeType: 'audio/pcm;rate=16000' } });
}, 128);

await Promise.race([replyFinished, sleep(20000)]);
clearInterval(keepAlive);
sessionB.close();

console.log('\nRESULT');
console.log('  heard :', JSON.stringify(inputText.trim()));
console.log('  reply :', JSON.stringify(outputText.trim()), `(${replyAudioBytes} audio bytes)`);
const ok = inputText.trim().length > 0 && replyAudioBytes > 0;
console.log(ok ? '  PASS' : '  FAIL');
setTimeout(() => process.exit(ok ? 0 : 1), 300);
