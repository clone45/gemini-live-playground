'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TranscriptEntry } from '@/hooks/useLiveSession';
import styles from './console.module.css';

interface Props {
  entries: TranscriptEntry[];
  interim: string;
  speaking: boolean;
  connected: boolean;
  onSendText: (text: string) => void;
  onClear: () => void;
}

export function Transcript({ entries, interim, speaking, connected, onSendText, onClear }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, interim]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    onSendText(draft);
    setDraft('');
  };

  return (
    <section className={styles.transcript}>
      <div className={styles.panelHeader}>
        <h2>Conversation</h2>
        <div className={styles.panelActions}>
          {speaking && <span className={styles.speaking}>Gemini is speaking</span>}
          <button type="button" className={styles.ghostButton} onClick={onClear} disabled={entries.length === 0}>
            Clear
          </button>
        </div>
      </div>

      <div className={styles.transcriptScroll} ref={scrollRef}>
        {entries.length === 0 && !interim && (
          <p className={styles.empty}>
            {connected
              ? 'Say something, or type below. Transcripts of both sides appear here.'
              : 'Connect to start a live session. Your microphone starts streaming automatically.'}
          </p>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className={`${styles.bubble} ${entry.role === 'user' ? styles.bubbleUser : styles.bubbleModel}`}>
            <span className={styles.bubbleRole}>{entry.role === 'user' ? 'You' : 'Gemini'}</span>
            <p>
              {entry.text}
              {entry.interrupted && <em className={styles.interrupted}> (interrupted)</em>}
            </p>
          </div>
        ))}
        {interim && (
          <div className={`${styles.bubble} ${styles.bubbleUser} ${styles.bubbleInterim}`}>
            <span className={styles.bubbleRole}>You</span>
            <p>{interim}</p>
          </div>
        )}
      </div>

      <form className={styles.composer} onSubmit={submit}>
        <input
          type="text"
          name="message"
          value={draft}
          placeholder={connected ? 'Type a message (sent as realtime text input)' : 'Connect first'}
          disabled={!connected}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className={styles.primaryButton} disabled={!connected || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
