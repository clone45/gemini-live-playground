'use client';

import type { RefObject } from 'react';
import type { ConnectionStatus, Levels, Stats } from '@/hooks/useLiveSession';
import type { VideoSource } from '@/lib/video-capture';
import styles from './console.module.css';

interface Props {
  status: ConnectionStatus;
  micOn: boolean;
  muted: boolean;
  speaking: boolean;
  levels: Levels;
  stats: Stats;
  videoSource: VideoSource | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  onToggleMic: () => void;
  onToggleMuted: () => void;
  onSetVideoSource: (source: VideoSource | null) => void;
}

function Meter({ level, active }: { level: number; active: boolean }) {
  const pct = Math.min(100, Math.round(level * 300));
  return (
    <span className={styles.meter} aria-hidden>
      <span className={`${styles.meterFill} ${active ? styles.meterActive : ''}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ControlBar({
  status,
  micOn,
  muted,
  speaking,
  levels,
  stats,
  videoSource,
  videoRef,
  onToggleMic,
  onToggleMuted,
  onSetVideoSource,
}: Props) {
  const connected = status === 'connected';
  const usage = stats.usage;

  return (
    <footer className={styles.controlBar}>
      <div className={styles.controlGroup}>
        <button
          type="button"
          className={`${styles.controlButton} ${micOn ? styles.controlOn : ''}`}
          onClick={onToggleMic}
          disabled={!connected}
          title={micOn ? 'Stop microphone' : 'Start microphone'}
        >
          {micOn ? 'Mic on' : 'Mic off'}
        </button>
        <Meter level={levels.mic} active={micOn} />
      </div>

      <div className={styles.controlGroup}>
        <button
          type="button"
          className={`${styles.controlButton} ${muted ? styles.controlOn : ''}`}
          onClick={onToggleMuted}
          title={muted ? 'Unmute Gemini' : 'Mute Gemini'}
        >
          {muted ? 'Muted' : 'Speaker'}
        </button>
        <Meter level={levels.output} active={speaking && !muted} />
      </div>

      <div className={styles.controlGroup}>
        <button
          type="button"
          className={`${styles.controlButton} ${videoSource === 'camera' ? styles.controlOn : ''}`}
          onClick={() => onSetVideoSource(videoSource === 'camera' ? null : 'camera')}
          disabled={!connected}
        >
          Camera
        </button>
        <button
          type="button"
          className={`${styles.controlButton} ${videoSource === 'screen' ? styles.controlOn : ''}`}
          onClick={() => onSetVideoSource(videoSource === 'screen' ? null : 'screen')}
          disabled={!connected}
        >
          Screen
        </button>
        <video ref={videoRef} className={styles.preview} hidden={videoSource === null} playsInline muted />
      </div>

      <div className={styles.statsGroup}>
        <span title="16 kHz PCM chunks sent (128 ms each)">mic {stats.audioChunksSent} chunks</span>
        <span title="24 kHz PCM received">audio {formatBytes(stats.audioBytesReceived)}</span>
        <span>frames {stats.videoFramesSent}</span>
        {usage && (
          <span title={usage.responseTokensDetails?.map((d) => `${d.modality}: ${d.tokenCount}`).join(', ')}>
            tokens {usage.totalTokenCount ?? 0}
          </span>
        )}
      </div>
    </footer>
  );
}
