/**
 * Is Live API usageMetadata cumulative for the session, or per message?
 *
 * The cost panel keeps the newest usageMetadata on the assumption that it is
 * cumulative. If it is actually per message, that under-reports every call.
 * Drives three turns and prints the accounting after each message.
 *
 *   node scripts/usage-accounting.mjs
 */
import { readFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';

function loadKey() {
  if (process.env.NEXT_PUBLIC_GEMINI_API_KEY) return process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  const match = env.match(/^NEXT_PUBLIC_GEMINI_API_KEY=(.+)$/m);
  if (!match) throw new Error('No API key in .env.local');
  return match[1].trim();
}

const ai = new GoogleGenAI({ apiKey: loadKey() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modality = (details, want) =>
  (details ?? []).filter((d) => (d.modality ?? '').toUpperCase() === want).reduce((s, d) => s + (d.tokenCount ?? 0), 0);

const samples = [];
let turnResolve;
let turnDone = new Promise((r) => (turnResolve = r));

const session = await ai.live.connect({
  model: 'gemini-3.8-live',
  config: {
    responseModalities: [Modality.AUDIO],
    outputAudioTranscription: {},
    systemInstruction: 'Answer in one short sentence.',
  },
  callbacks: {
    onmessage: (m) => {
      if (m.usageMetadata) {
        const u = m.usageMetadata;
        samples.push({
          total: u.totalTokenCount ?? 0,
          promptTotal: u.promptTokenCount ?? 0,
          responseTotal: u.responseTokenCount ?? 0,
          audioIn: modality(u.promptTokensDetails, 'AUDIO'),
          textIn: modality(u.promptTokensDetails, 'TEXT'),
          audioOut: modality(u.responseTokensDetails, 'AUDIO'),
          textOut: modality(u.responseTokensDetails, 'TEXT'),
          thoughts: u.thoughtsTokenCount ?? 0,
        });
      }
      if (m.serverContent?.turnComplete) turnResolve();
    },
    onerror: (e) => console.log('[error]', e.message ?? e),
    onclose: () => {},
  },
});

const prompts = [
  'Name one colour.',
  'Now name a different colour and explain why you picked it.',
  'Count from one to eight out loud.',
];

for (const [i, prompt] of prompts.entries()) {
  turnDone = new Promise((r) => (turnResolve = r));
  session.sendRealtimeInput({ text: prompt });
  await Promise.race([turnDone, sleep(25000)]);
  console.log(`\n--- after turn ${i + 1} (${samples.length} usage messages so far) ---`);
  const s = samples[samples.length - 1];
  if (s) console.log(JSON.stringify(s));
  await sleep(500);
}

session.close();

console.log('\n=== every usage message in order ===');
samples.forEach((s, i) => console.log(String(i).padStart(2), JSON.stringify(s)));

const totals = samples.map((s) => s.total);
const monotonic = totals.every((v, i) => i === 0 || v >= totals[i - 1]);
const audioOuts = samples.map((s) => s.audioOut);

console.log('\n=== verdict ===');
console.log('totalTokenCount monotonically increasing:', monotonic, JSON.stringify(totals));
console.log('audioOut per message:', JSON.stringify(audioOuts));
console.log('  sum of audioOut :', audioOuts.reduce((a, b) => a + b, 0));
console.log('  last audioOut   :', audioOuts[audioOuts.length - 1] ?? 0);
console.log(
  monotonic
    ? 'totals look CUMULATIVE. Check whether the modality details are cumulative too.'
    : 'totals RESET, so usage is PER MESSAGE and must be summed.',
);
setTimeout(() => process.exit(0), 300);
