'use client';

import dynamic from 'next/dynamic';

/** Client-only, for the same reason as the console: it is all live device state. */
const MicTest = dynamic(() => import('./MicTest').then((m) => m.MicTest), {
  ssr: false,
  loading: () => <p style={{ padding: 32, color: '#8a93a0' }}>Loading the microphone test…</p>,
});

export function MicTestClient() {
  return <MicTest />;
}
