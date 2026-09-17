'use client';

import { useEffect, useRef, useState } from 'react';
import type { LogEntry, LogKind } from '@/hooks/useLiveSession';
import styles from './console.module.css';

interface Props {
  entries: LogEntry[];
  onClear: () => void;
}

const KINDS: ReadonlyArray<{ kind: LogKind; label: string }> = [
  { kind: 'info', label: 'info' },
  { kind: 'send', label: 'send' },
  { kind: 'recv', label: 'recv' },
  { kind: 'tool', label: 'tool' },
  { kind: 'error', label: 'error' },
];

const KIND_CLASS: Record<LogKind, string> = {
  info: styles.logInfo,
  send: styles.logSend,
  recv: styles.logRecv,
  tool: styles.logTool,
  error: styles.logError,
};

function formatTime(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function EventLog({ entries, onClear }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Set<LogKind>>(() => new Set());
  const [pinned, setPinned] = useState(true);

  const visible = entries.filter((e) => !hidden.has(e.kind));

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [visible.length, pinned]);

  const toggleKind = (kind: LogKind) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  return (
    <section className={styles.eventLog}>
      <div className={styles.panelHeader}>
        <h2>Events</h2>
        <div className={styles.panelActions}>
          {KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              className={`${styles.chip} ${KIND_CLASS[kind]} ${hidden.has(kind) ? styles.chipOff : ''}`}
              onClick={() => toggleKind(kind)}
              title={hidden.has(kind) ? `Show ${label}` : `Hide ${label}`}
            >
              {label}
            </button>
          ))}
          <button type="button" className={styles.ghostButton} onClick={onClear} disabled={entries.length === 0}>
            Clear
          </button>
        </div>
      </div>
      <div className={styles.logScroll} ref={scrollRef} onScroll={onScroll}>
        {visible.length === 0 && <p className={styles.empty}>Nothing yet.</p>}
        {visible.map((entry) =>
          entry.detail ? (
            <details key={entry.id} className={`${styles.logEntry} ${KIND_CLASS[entry.kind]}`}>
              <summary>
                <span className={styles.logTime}>{formatTime(entry.at)}</span>
                <span className={styles.logKind}>{entry.kind}</span>
                <span className={styles.logSummary}>{entry.summary}</span>
              </summary>
              <pre>{entry.detail}</pre>
            </details>
          ) : (
            <div key={entry.id} className={`${styles.logEntry} ${styles.logEntryPlain} ${KIND_CLASS[entry.kind]}`}>
              <span className={styles.logTime}>{formatTime(entry.at)}</span>
              <span className={styles.logKind}>{entry.kind}</span>
              <span className={styles.logSummary}>{entry.summary}</span>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
