import {
  GoogleGenAI,
  type FunctionCall,
  type FunctionResponse,
  type LiveConnectConfig,
  type LiveServerMessage,
  type Session,
  type UsageMetadata,
} from '@google/genai';

export const AUDIO_INPUT_MIME = 'audio/pcm;rate=16000';
export const VIDEO_INPUT_MIME = 'image/jpeg';

/**
 * Typed events unpacked from `LiveServerMessage`. Everything is optional so a
 * consumer can subscribe to just what it cares about.
 */
export interface LiveSessionHandlers {
  onOpen?: () => void;
  onSetupComplete?: () => void;
  /** Base64 16-bit PCM at 24 kHz. */
  onAudio?: (base64Pcm: string, mimeType: string) => void;
  /** Text parts in the model turn (only when TEXT modality is used). */
  onText?: (text: string) => void;
  onInputTranscription?: (text: string, finished: boolean) => void;
  onInterimInputTranscription?: (text: string) => void;
  onOutputTranscription?: (text: string, finished: boolean) => void;
  onInterrupted?: () => void;
  onGenerationComplete?: () => void;
  onTurnComplete?: (reason?: string) => void;
  onToolCall?: (calls: FunctionCall[]) => void;
  onToolCallCancellation?: (ids: string[]) => void;
  onUsage?: (usage: UsageMetadata) => void;
  onGoAway?: (timeLeft?: string) => void;
  onSessionResumptionUpdate?: (handle: string | undefined, resumable: boolean) => void;
  /** Every raw message, for the event log. */
  onMessage?: (message: LiveServerMessage) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
}

/**
 * Thin wrapper around `ai.live.connect` that owns the `Session`, unpacks the
 * server messages into typed callbacks, and hides the input MIME details.
 */
export class LiveSession {
  private readonly ai: GoogleGenAI;
  private session: Session | null = null;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  get connected(): boolean {
    return this.session !== null;
  }

  async connect(model: string, config: LiveConnectConfig, handlers: LiveSessionHandlers): Promise<void> {
    if (this.session) throw new Error('Already connected');

    this.session = await this.ai.live.connect({
      model,
      config,
      callbacks: {
        onopen: () => handlers.onOpen?.(),
        onmessage: (message) => this.dispatch(message, handlers),
        onerror: (ev) => handlers.onError?.(new Error(ev.message || 'WebSocket error')),
        onclose: (ev) => {
          this.session = null;
          handlers.onClose?.(ev.code, ev.reason);
        },
      },
    });
  }

  private dispatch(message: LiveServerMessage, h: LiveSessionHandlers): void {
    h.onMessage?.(message);

    if (message.setupComplete) h.onSetupComplete?.();

    const content = message.serverContent;
    if (content) {
      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (part.inlineData?.data) {
            h.onAudio?.(part.inlineData.data, part.inlineData.mimeType ?? '');
          }
          if (part.text && !part.thought) h.onText?.(part.text);
        }
      }
      if (content.interimInputTranscription?.text) {
        h.onInterimInputTranscription?.(content.interimInputTranscription.text);
      }
      if (content.inputTranscription?.text) {
        h.onInputTranscription?.(content.inputTranscription.text, content.inputTranscription.finished ?? false);
      }
      if (content.outputTranscription?.text) {
        h.onOutputTranscription?.(content.outputTranscription.text, content.outputTranscription.finished ?? false);
      }
      if (content.interrupted) h.onInterrupted?.();
      if (content.generationComplete) h.onGenerationComplete?.();
      if (content.turnComplete) h.onTurnComplete?.(content.turnCompleteReason);
    }

    if (message.toolCall?.functionCalls?.length) h.onToolCall?.(message.toolCall.functionCalls);
    if (message.toolCallCancellation?.ids?.length) h.onToolCallCancellation?.(message.toolCallCancellation.ids);
    if (message.usageMetadata) h.onUsage?.(message.usageMetadata);
    if (message.goAway) h.onGoAway?.(message.goAway.timeLeft);
    if (message.sessionResumptionUpdate) {
      const u = message.sessionResumptionUpdate;
      h.onSessionResumptionUpdate?.(u.newHandle, u.resumable ?? false);
    }
  }

  sendAudio(base64Pcm: string): void {
    this.session?.sendRealtimeInput({ audio: { data: base64Pcm, mimeType: AUDIO_INPUT_MIME } });
  }

  sendAudioStreamEnd(): void {
    this.session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  sendVideoFrame(base64Jpeg: string): void {
    this.session?.sendRealtimeInput({ video: { data: base64Jpeg, mimeType: VIDEO_INPUT_MIME } });
  }

  sendText(text: string): void {
    this.session?.sendRealtimeInput({ text });
  }

  sendToolResponse(functionResponses: FunctionResponse[]): void {
    this.session?.sendToolResponse({ functionResponses });
  }

  close(): void {
    const session = this.session;
    this.session = null;
    session?.close();
  }
}
