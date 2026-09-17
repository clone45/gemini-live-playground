import type { UsageMetadata } from '@google/genai';

/**
 * Cost estimation for a dial-out call.
 *
 * Quantities are measured, not guessed: token counts come from the Live API's
 * own `usageMetadata`, and call durations from Daily's `/v1/meetings`. Neither
 * API returns money, so the rates below are transcribed from public pricing
 * pages and must be kept current by hand. Treat any total as an estimate.
 */

export const PRICING_AS_OF = '2026-09-17';

/**
 * Gemini API paid tier, gemini-3.8-live.
 * https://ai.google.dev/gemini-api/docs/pricing
 * The free tier is free of charge, so a key on it costs nothing.
 */
export const GEMINI_PRICES = {
  textInputPerMillionTokens: 0.75,
  audioInputPerMillionTokens: 3.0,
  textOutputPerMillionTokens: 4.5,
  audioOutputPerMillionTokens: 12.0,
} as const;

/**
 * Daily. PSTN and participant rates are published per minute.
 * https://www.daily.co/pricing/video-sdk/ and /pricing/daily-bots/
 * Daily bills telephony per started minute, so partial minutes round up.
 */
export const DAILY_PRICES = {
  pstnDialOutUsPerMinute: 0.025,
  participantPerMinute: 0.004,
  /** Recurring, not attributable to any single call. */
  usPhoneNumberPerMonth: 2.0,
} as const;

export interface CostLine {
  label: string;
  /** Human-readable measured amount, e.g. "1.2 min" or "4,210 tokens". */
  quantity: string;
  rate: string;
  cost: number;
  /** False when the quantity itself had to be assumed rather than measured. */
  measured: boolean;
}

export interface CostBreakdown {
  lines: CostLine[];
  total: number;
  notes: string[];
}

function tokensFor(details: { modality?: string; tokenCount?: number }[] | undefined, modality: string): number {
  return (details ?? [])
    .filter((d) => (d.modality ?? '').toUpperCase() === modality)
    .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
}

/**
 * Running totals across a session.
 *
 * Every usageMetadata message describes one billed request, so they are summed
 * rather than replaced. Measured with scripts/usage-accounting.mjs: the prompt
 * side is the whole conversation so far, each turn's audioIn being the previous
 * turn's audioIn plus its audioOut, while the response side reports only that
 * turn. Keeping just the newest message therefore counted a single turn and
 * under-reported every call.
 *
 * Because the prompt carries history, a long call re-bills its own context on
 * every turn. That is normal for token billing and is why cost climbs faster
 * than call duration.
 */
export interface UsageTotals {
  audioIn: number;
  textIn: number;
  audioOut: number;
  textOut: number;
  thoughts: number;
  /** Tokens in the reported total that no modality accounted for. */
  other: number;
  messages: number;
}

export const EMPTY_USAGE: UsageTotals = {
  audioIn: 0,
  textIn: 0,
  audioOut: 0,
  textOut: 0,
  thoughts: 0,
  other: 0,
  messages: 0,
};

/** Fold one usageMetadata message into the running totals. */
export function addUsage(totals: UsageTotals, usage: UsageMetadata): UsageTotals {
  const audioIn = tokensFor(usage.promptTokensDetails, 'AUDIO');
  const textIn = tokensFor(usage.promptTokensDetails, 'TEXT');
  const audioOut = tokensFor(usage.responseTokensDetails, 'AUDIO');
  const textOut = tokensFor(usage.responseTokensDetails, 'TEXT');

  // Thinking tokens sit outside totalTokenCount, which equals prompt + response,
  // so they are tracked separately and not folded into `other`.
  const counted = audioIn + textIn + audioOut + textOut;
  const other = Math.max(0, (usage.totalTokenCount ?? counted) - counted);

  return {
    audioIn: totals.audioIn + audioIn,
    textIn: totals.textIn + textIn,
    audioOut: totals.audioOut + audioOut,
    textOut: totals.textOut + textOut,
    thoughts: totals.thoughts + (usage.thoughtsTokenCount ?? 0),
    other: totals.other + other,
    messages: totals.messages + 1,
  };
}

/**
 * Sub-dollar amounts keep four decimals so a column of them lines up and
 * fractions of a cent stay visible; anything larger reads as normal money.
 */
function money(value: number): string {
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function formatTokens(n: number): string {
  return `${n.toLocaleString()} tokens`;
}

/** Cost of the Gemini Live session, from the API's own token accounting. */
export function priceGemini(totals: UsageTotals | null): CostLine[] {
  if (!totals || totals.messages === 0) return [];

  const lines: CostLine[] = [];
  const add = (label: string, tokens: number, perMillion: number, measured = true, note = '') => {
    if (tokens <= 0) return;
    lines.push({
      label,
      quantity: formatTokens(tokens),
      rate: `$${perMillion.toFixed(2)}/1M${note}`,
      cost: (tokens / 1_000_000) * perMillion,
      measured,
    });
  };

  add('Gemini audio in', totals.audioIn, GEMINI_PRICES.audioInputPerMillionTokens);
  add('Gemini text in', totals.textIn, GEMINI_PRICES.textInputPerMillionTokens);
  add('Gemini audio out', totals.audioOut, GEMINI_PRICES.audioOutputPerMillionTokens);
  add('Gemini text out', totals.textOut, GEMINI_PRICES.textOutputPerMillionTokens);
  add('Gemini thinking', totals.thoughts, GEMINI_PRICES.textOutputPerMillionTokens);
  add('Gemini unattributed', totals.other, GEMINI_PRICES.textInputPerMillionTokens, false, ' assumed');

  return lines;
}

export interface DailyUsage {
  /** Seconds the phone leg was connected. */
  pstnSeconds: number;
  /** Summed seconds across every participant, the phone included. */
  participantSeconds: number;
  /** False when durations came from the page's own clock, not Daily. */
  measured: boolean;
}

/** Cost of the Daily side. Telephony bills per started minute, so round up. */
export function priceDaily(usage: DailyUsage): CostLine[] {
  const lines: CostLine[] = [];

  if (usage.pstnSeconds > 0) {
    const minutes = Math.ceil(usage.pstnSeconds / 60);
    lines.push({
      label: 'Daily PSTN dial-out',
      quantity: `${(usage.pstnSeconds / 60).toFixed(2)} min, billed as ${minutes}`,
      rate: `$${DAILY_PRICES.pstnDialOutUsPerMinute.toFixed(3)}/min`,
      cost: minutes * DAILY_PRICES.pstnDialOutUsPerMinute,
      measured: usage.measured,
    });
  }

  if (usage.participantSeconds > 0) {
    const minutes = Math.ceil(usage.participantSeconds / 60);
    lines.push({
      label: 'Daily participant minutes',
      quantity: `${(usage.participantSeconds / 60).toFixed(2)} min, billed as ${minutes}`,
      rate: `$${DAILY_PRICES.participantPerMinute.toFixed(3)}/min`,
      cost: minutes * DAILY_PRICES.participantPerMinute,
      measured: usage.measured,
    });
  }

  return lines;
}

export function buildBreakdown(usage: UsageTotals | null, daily: DailyUsage): CostBreakdown {
  const lines = [...priceDaily(daily), ...priceGemini(usage)];
  const total = lines.reduce((sum, l) => sum + l.cost, 0);

  const notes: string[] = [`Rates transcribed ${PRICING_AS_OF}; neither API returns prices.`];
  if (!daily.measured) {
    notes.push('Durations came from this page, not Daily, so they may differ slightly from billing.');
  }
  if (lines.some((l) => !l.measured)) {
    notes.push('Some token quantities lacked a modality breakdown and were priced at an assumed rate.');
  }
  notes.push(
    `The phone number itself costs $${DAILY_PRICES.usPhoneNumberPerMonth.toFixed(2)}/month and is not included.`,
  );
  notes.push('A key on the Gemini free tier pays nothing for the Gemini lines.');
  if (usage && usage.messages > 0) {
    notes.push(
      `Summed over ${usage.messages} billed request${usage.messages === 1 ? '' : 's'}. Each turn re-bills ` +
        'the conversation so far, so cost grows faster than call length.',
    );
  }

  return { lines, total, notes };
}

export { money as formatMoney };
