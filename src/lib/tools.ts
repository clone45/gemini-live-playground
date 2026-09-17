import { Behavior, FunctionResponseScheduling, Type, type FunctionDeclaration } from '@google/genai';

/** Side effects a tool may have on the app. Provided by the UI layer. */
export interface ToolContext {
  setAccentColor: (cssColor: string) => void;
  /** Adds a note and returns the new note count. */
  addNote: (text: string) => number;
}

export interface ToolResult {
  response: Record<string, unknown>;
  /**
   * How the model should treat the result of a NON_BLOCKING call:
   * INTERRUPT = speak about it right away, WHEN_IDLE = after finishing the
   * current thought, SILENT = just remember it.
   */
  scheduling: FunctionResponseScheduling;
}

export interface DemoTool {
  declaration: FunctionDeclaration;
  run: (args: Record<string, unknown>, ctx: ToolContext, signal: AbortSignal) => Promise<ToolResult>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Demo tools. All are NON_BLOCKING (the Gemini 3.8 Live default) so the model
 * keeps talking while they run; `start_timer` is the interesting one because
 * it resolves seconds later and interrupts the model with the result.
 */
export const DEMO_TOOLS: ReadonlyArray<DemoTool> = [
  {
    declaration: {
      name: 'get_current_time',
      description: "Returns the current date, time and time zone on the user's device.",
      behavior: Behavior.NON_BLOCKING,
    },
    async run() {
      const now = new Date();
      return {
        response: {
          iso: now.toISOString(),
          local: now.toLocaleString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        scheduling: FunctionResponseScheduling.WHEN_IDLE,
      };
    },
  },
  {
    declaration: {
      name: 'set_accent_color',
      description: "Changes the accent color of the app's user interface.",
      behavior: Behavior.NON_BLOCKING,
      parameters: {
        type: Type.OBJECT,
        properties: {
          color: {
            type: Type.STRING,
            description: 'Any CSS color, for example "hotpink", "#ff6600" or "rgb(20, 200, 120)".',
          },
        },
        required: ['color'],
      },
    },
    async run(args, ctx) {
      const color = asString(args.color).trim();
      if (!color || !CSS.supports('color', color)) {
        return {
          response: { ok: false, error: `"${color}" is not a valid CSS color` },
          scheduling: FunctionResponseScheduling.WHEN_IDLE,
        };
      }
      ctx.setAccentColor(color);
      return { response: { ok: true, color }, scheduling: FunctionResponseScheduling.WHEN_IDLE };
    },
  },
  {
    declaration: {
      name: 'start_timer',
      description:
        'Starts a countdown timer. This function only returns once the timer has elapsed, ' +
        'so acknowledge that the timer is running and carry on with the conversation; ' +
        'when the result arrives, tell the user the timer is done.',
      behavior: Behavior.NON_BLOCKING,
      parameters: {
        type: Type.OBJECT,
        properties: {
          seconds: { type: Type.NUMBER, description: 'Duration in seconds (1 to 3600).' },
          label: { type: Type.STRING, description: 'Optional short label, e.g. "eggs".' },
        },
        required: ['seconds'],
      },
    },
    async run(args, _ctx, signal) {
      const seconds = Math.min(3600, Math.max(1, Math.round(asNumber(args.seconds, 10))));
      const label = asString(args.label) || 'timer';
      await delay(seconds * 1000, signal);
      return {
        response: { status: 'finished', label, seconds },
        scheduling: FunctionResponseScheduling.INTERRUPT,
      };
    },
  },
  {
    declaration: {
      name: 'save_note',
      description: 'Saves a short note for the user. Use it when the user asks you to remember, note or write something down.',
      behavior: Behavior.NON_BLOCKING,
      parameters: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING, description: 'The note text.' },
        },
        required: ['text'],
      },
    },
    async run(args, ctx) {
      const text = asString(args.text).trim();
      if (!text) {
        return { response: { saved: false, error: 'Empty note' }, scheduling: FunctionResponseScheduling.WHEN_IDLE };
      }
      const noteCount = ctx.addNote(text);
      return { response: { saved: true, noteCount }, scheduling: FunctionResponseScheduling.SILENT };
    },
  },
];
