import type { Metadata } from 'next';
import { MicTestClient } from '@/components/MicTestClient';

export const metadata: Metadata = {
  title: 'Microphone test',
  description: 'Isolated diagnostic for browser microphone capture at 16 kHz.',
};

export default function MicTestPage() {
  return <MicTestClient />;
}
