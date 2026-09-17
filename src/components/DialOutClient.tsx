'use client';

import dynamic from 'next/dynamic';

/** Client-only: Daily's SDK and Web Audio are browser-only. */
const DialOut = dynamic(() => import('./DialOut').then((m) => m.DialOut), {
  ssr: false,
  loading: () => <p style={{ padding: 32, color: '#8a93a0' }}>Loading the dial-out test…</p>,
});

export function DialOutClient() {
  return <DialOut />;
}
