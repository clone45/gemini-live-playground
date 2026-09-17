'use client';

import { useRef } from 'react';
import { useLiveSession, type ConnectionStatus } from '@/hooks/useLiveSession';
import { ControlBar } from './ControlBar';
import { EventLog } from './EventLog';
import { SettingsPanel } from './SettingsPanel';
import { ToolPanel } from './ToolPanel';
import { Transcript } from './Transcript';
import styles from './console.module.css';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Live',
  reconnecting: 'Reconnecting…',
};

const STATUS_CLASS: Record<ConnectionStatus, string> = {
  disconnected: styles.statusOff,
  connecting: styles.statusBusy,
  connected: styles.statusOn,
  reconnecting: styles.statusBusy,
};

export function LiveConsole() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const live = useLiveSession(videoRef);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1>Gemini Live Playground</h1>
          <code className={styles.modelBadge}>{live.model}</code>
        </div>
        <div className={styles.headerRight}>
          {live.lastError && (
            <button type="button" className={styles.errorBanner} onClick={live.dismissError} title="Dismiss">
              {live.lastError}
            </button>
          )}
          <span className={`${styles.statusPill} ${STATUS_CLASS[live.status]}`}>
            <span className={styles.statusDot} />
            {STATUS_LABEL[live.status]}
          </span>
        </div>
      </header>

      <div className={styles.body}>
        <SettingsPanel
          settings={live.settings}
          status={live.status}
          onChange={live.updateSettings}
          onConnect={() => void live.connect()}
          onDisconnect={() => void live.disconnect()}
        />

        <Transcript
          entries={live.transcript}
          interim={live.interimInput}
          speaking={live.speaking}
          connected={live.status === 'connected'}
          onSendText={live.sendText}
          onClear={live.clearTranscript}
        />

        <div className={styles.rightColumn}>
          <ToolPanel
            pending={live.pendingTools}
            notes={live.notes}
            accent={live.accent}
            now={live.now}
            onResetAccent={live.resetAccent}
          />
          <EventLog entries={live.logs} onClear={live.clearLogs} />
        </div>
      </div>

      <ControlBar
        status={live.status}
        micOn={live.micOn}
        muted={live.muted}
        speaking={live.speaking}
        levels={live.levels}
        stats={live.stats}
        videoSource={live.videoSource}
        videoRef={videoRef}
        onToggleMic={live.toggleMic}
        onToggleMuted={live.toggleMuted}
        onSetVideoSource={live.setVideoSource}
      />
    </div>
  );
}
