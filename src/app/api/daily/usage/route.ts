import { NextResponse } from 'next/server';

/**
 * Actual durations for one finished call, from Daily's meeting records.
 *
 * Daily exposes no per-call cost and its `/v1/usage` totals cannot be scoped to
 * a time window, so this returns measured durations that the page prices with
 * published rates. Records appear a few seconds after a call ends, hence the
 * short retry.
 */

interface DailyParticipant {
  user_name?: string;
  duration?: number;
}

interface DailyMeeting {
  id: string;
  room: string;
  start_time: number;
  duration: number;
  ongoing: boolean;
  participants?: DailyParticipant[];
}

// Daily publishes the meeting record a little after the room closes; a live
// test found 6 seconds too short.
const RETRIES = 8;
const RETRY_DELAY_MS = 2500;

export async function GET(request: Request) {
  const apiKey = process.env.DAILY_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'DAILY_API_KEY is not set.' }, { status: 500 });
  }

  const room = new URL(request.url).searchParams.get('room');
  if (!room) {
    return NextResponse.json({ error: 'Pass ?room=<roomName>' }, { status: 400 });
  }

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const response = await fetch(`https://api.daily.co/v1/meetings?room=${encodeURIComponent(room)}&limit=5`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
    });

    if (!response.ok) {
      return NextResponse.json({ error: await response.text() }, { status: 502 });
    }

    const body = (await response.json()) as { data?: DailyMeeting[] };
    const session = (body.data ?? []).find((m) => !m.ongoing);

    if (session) {
      const participants = (session.participants ?? []).map((p) => ({
        name: p.user_name ?? 'unknown',
        seconds: p.duration ?? 0,
      }));

      // The dial-out leg joins under the display name the page assigns it.
      const phone = participants.filter((p) => p.name.toLowerCase() === 'phone');
      const pstnSeconds = phone.reduce((sum, p) => sum + p.seconds, 0);
      const participantSeconds = participants.reduce((sum, p) => sum + p.seconds, 0);

      return NextResponse.json({
        found: true,
        meetingId: session.id,
        durationSeconds: session.duration,
        pstnSeconds,
        participantSeconds,
        participants,
      });
    }

    if (attempt < RETRIES - 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }

  return NextResponse.json({ found: false });
}
