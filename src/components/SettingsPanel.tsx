'use client';

import { EndSensitivity, MediaResolution, StartSensitivity } from '@google/genai';
import type { ConnectionStatus, SessionSettings } from '@/hooks/useLiveSession';
import { VOICES } from '@/lib/voices';
import styles from './console.module.css';

interface Props {
  settings: SessionSettings;
  status: ConnectionStatus;
  onChange: (patch: Partial<SessionSettings>) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function SettingsPanel({ settings, status, onChange, onConnect, onDisconnect }: Props) {
  const locked = status !== 'disconnected';
  const busy = status === 'connecting' || status === 'reconnecting';

  return (
    <aside className={styles.settings}>
      <div className={styles.panelHeader}>
        <h2>Session</h2>
        {locked && <span className={styles.hint}>Locked while connected</span>}
      </div>

      <fieldset disabled={locked} className={styles.fieldset}>
        <label className={styles.field}>
          <span>Voice</span>
          <select name="voice" value={settings.voiceName} onChange={(e) => onChange({ voiceName: e.target.value })}>
            {VOICES.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} · {v.character}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span>System instruction</span>
          <textarea
            name="systemInstruction"
            rows={6}
            value={settings.systemInstruction}
            onChange={(e) => onChange({ systemInstruction: e.target.value })}
            spellCheck={false}
          />
        </label>

        <div className={styles.toggles}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={settings.inputTranscription}
              onChange={(e) => onChange({ inputTranscription: e.target.checked })}
            />
            <span>Transcribe my speech</span>
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={settings.outputTranscription}
              onChange={(e) => onChange({ outputTranscription: e.target.checked })}
            />
            <span>Transcribe model speech</span>
          </label>
          <label className={styles.toggle}>
            <input type="checkbox" checked={settings.toolsEnabled} onChange={(e) => onChange({ toolsEnabled: e.target.checked })} />
            <span>Enable demo tools</span>
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={settings.contextCompression}
              onChange={(e) => onChange({ contextCompression: e.target.checked })}
            />
            <span>Context window compression</span>
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={settings.sessionResumption}
              onChange={(e) => onChange({ sessionResumption: e.target.checked })}
            />
            <span>Session resumption (auto-reconnect)</span>
          </label>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span>Start of speech</span>
            <select
              name="startSensitivity"
              value={settings.startSensitivity}
              onChange={(e) => onChange({ startSensitivity: e.target.value as StartSensitivity })}
            >
              <option value={StartSensitivity.START_SENSITIVITY_UNSPECIFIED}>Default</option>
              <option value={StartSensitivity.START_SENSITIVITY_HIGH}>High</option>
              <option value={StartSensitivity.START_SENSITIVITY_LOW}>Low</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>End of speech</span>
            <select
              name="endSensitivity"
              value={settings.endSensitivity}
              onChange={(e) => onChange({ endSensitivity: e.target.value as EndSensitivity })}
            >
              <option value={EndSensitivity.END_SENSITIVITY_UNSPECIFIED}>Default</option>
              <option value={EndSensitivity.END_SENSITIVITY_HIGH}>High</option>
              <option value={EndSensitivity.END_SENSITIVITY_LOW}>Low</option>
            </select>
          </label>
        </div>

        <label className={styles.field}>
          <span>Video resolution sent to model</span>
          <select
            name="mediaResolution"
            value={settings.mediaResolution}
            onChange={(e) => onChange({ mediaResolution: e.target.value as MediaResolution })}
          >
            <option value={MediaResolution.MEDIA_RESOLUTION_UNSPECIFIED}>Default</option>
            <option value={MediaResolution.MEDIA_RESOLUTION_LOW}>Low (fewer tokens)</option>
            <option value={MediaResolution.MEDIA_RESOLUTION_MEDIUM}>Medium</option>
            <option value={MediaResolution.MEDIA_RESOLUTION_HIGH}>High</option>
          </select>
        </label>
      </fieldset>

      <div className={styles.connectRow}>
        {locked ? (
          <button type="button" className={styles.dangerButton} onClick={onDisconnect} disabled={busy && status === 'connecting'}>
            Disconnect
          </button>
        ) : (
          <button type="button" className={styles.primaryButton} onClick={onConnect}>
            Connect
          </button>
        )}
      </div>
    </aside>
  );
}
