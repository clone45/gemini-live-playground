'use client';

import type { Note, PendingToolCall } from '@/hooks/useLiveSession';
import { DEMO_TOOLS } from '@/lib/tools';
import styles from './console.module.css';

interface Props {
  pending: PendingToolCall[];
  notes: Note[];
  accent: string;
  now: number;
  onResetAccent: () => void;
}

export function ToolPanel({ pending, notes, accent, now, onResetAccent }: Props) {
  return (
    <section className={styles.toolPanel}>
      <div className={styles.panelHeader}>
        <h2>Tools</h2>
        <span className={styles.hint}>{DEMO_TOOLS.map((t) => t.declaration.name).join(' · ')}</span>
      </div>

      <div className={styles.toolRow}>
        <span className={styles.toolLabel}>Accent</span>
        <span className={styles.swatch} style={{ background: accent }} />
        <code>{accent}</code>
        <button type="button" className={styles.ghostButton} onClick={onResetAccent}>
          Reset
        </button>
      </div>

      <div className={styles.toolBlock}>
        <span className={styles.toolLabel}>Running calls</span>
        {pending.length === 0 ? (
          <p className={styles.empty}>None. Try “start a 20 second timer” or “make the accent orange”.</p>
        ) : (
          <ul className={styles.toolList}>
            {pending.map((call) => (
              <li key={call.id}>
                <code>{call.name}</code>
                <span className={styles.toolArgs}>{JSON.stringify(call.args)}</span>
                <span className={styles.toolElapsed}>{Math.max(0, Math.round((now - call.startedAt) / 1000))}s</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.toolBlock}>
        <span className={styles.toolLabel}>Notes</span>
        {notes.length === 0 ? (
          <p className={styles.empty}>Ask Gemini to “make a note that…”.</p>
        ) : (
          <ul className={styles.noteList}>
            {notes.map((note) => (
              <li key={note.id}>{note.text}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
