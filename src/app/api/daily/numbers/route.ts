import { NextResponse } from 'next/server';

/**
 * Lists the phone numbers purchased on the Daily account.
 *
 * Dial-out uses one of these for caller ID, so an empty list means dial-out
 * will fail no matter how the room is configured. The page checks this up
 * front rather than letting the call fail with a vaguer error.
 */
export async function GET() {
  const apiKey = process.env.DAILY_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'DAILY_API_KEY is not set.' }, { status: 500 });
  }

  const response = await fetch('https://api.daily.co/v1/purchased-phone-numbers', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    return NextResponse.json({ error: await response.text() }, { status: 502 });
  }

  const body = (await response.json()) as { total_count?: number; data?: { number?: string }[] };
  return NextResponse.json({
    count: body.total_count ?? body.data?.length ?? 0,
    numbers: (body.data ?? []).map((n) => n.number).filter(Boolean),
  });
}
