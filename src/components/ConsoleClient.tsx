'use client';

import dynamic from 'next/dynamic';
import styles from './console.module.css';

/**
 * The console is entirely live client state: microphone, Web Audio graph,
 * WebSocket session. Server rendering it gains nothing and only creates a
 * surface for hydration mismatches, so it is loaded client-side only.
 */
const LiveConsole = dynamic(() => import('./LiveConsole').then((m) => m.LiveConsole), {
  ssr: false,
  loading: () => (
    <div className={styles.booting}>
      <span className={styles.bootingDot} />
      Starting the Live console…
    </div>
  ),
});

export function ConsoleClient() {
  return <LiveConsole />;
}
