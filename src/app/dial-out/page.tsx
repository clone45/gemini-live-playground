import type { Metadata } from 'next';
import { DialOutClient } from '@/components/DialOutClient';

export const metadata: Metadata = {
  title: 'Daily dial-out test',
  description: 'Place a PSTN call through Daily and bridge the caller to Gemini Live.',
};

export default function DialOutPage() {
  return <DialOutClient />;
}
