/**
 * Node-side smoke test for the Live API: connects to gemini-3.8-live, sends a
 * text prompt, and reports the audio bytes + transcript that come back.
 * Reads NEXT_PUBLIC_GEMINI_API_KEY from .env.local (or the environment).
 *
 *   npm run smoke
 */
import { readFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';

function loadKey() {
  if (process.env.NEXT_PUBLIC_GEMINI_API_KEY) return process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    const match = env.match(/^NEXT_PUBLIC_GEMINI_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // fall through
  }
  throw new Error('No API key: set NEXT_PUBLIC_GEMINI_API_KEY in .env.local or the environment');
}

const model = 'gemini-3.8-live';
const ai = new GoogleGenAI({ apiKey: loadKey() });

let audioBytes = 0;
let transcript = '';
let session;

const finished = new Promise((resolve) => {
  ai.live
    .connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        systemInstruction: 'You are a terse assistant. Answer in one short sentence.',
      },
      callbacks: {
        onopen: () => console.log('[open]'),
        onmessage: (m) => {
          if (m.setupComplete) console.log('[setupComplete]');
          const sc = m.serverContent;
          for (const p of sc?.modelTurn?.parts ?? []) {
            if (p.inlineData?.data) {
              if (audioBytes === 0) console.log('[first audio]', p.inlineData.mimeType);
              audioBytes += Buffer.from(p.inlineData.data, 'base64').length;
            }
          }
          if (sc?.outputTranscription?.text) transcript += sc.outputTranscription.text;
          if (sc?.interrupted) console.log('[interrupted]');
          if (sc?.generationComplete) console.log('[generationComplete]');
          if (sc?.turnComplete) {
            console.log('[turnComplete]');
            resolve();
          }
          if (m.usageMetadata) console.log('[usage]', m.usageMetadata.totalTokenCount, 'tokens');
          if (m.toolCall) console.log('[toolCall]', JSON.stringify(m.toolCall));
        },
        onerror: (e) => {
          console.log('[error]', e.message ?? e);
          resolve();
        },
        onclose: (e) => {
          console.log('[close]', e.code, e.reason);
          resolve();
        },
      },
    })
    .then((s) => {
      session = s;
      console.log('[connected] sending text');
      s.sendRealtimeInput({ text: 'Say hello and tell me what model you are.' });
    })
    .catch((e) => {
      console.log('[connect error]', e.message ?? e);
      resolve();
    });
});

await Promise.race([finished, new Promise((r) => setTimeout(r, 25000))]);
console.log(JSON.stringify({ audioBytes, transcript }, null, 2));
session?.close();
setTimeout(() => process.exit(audioBytes > 0 ? 0 : 1), 300);
