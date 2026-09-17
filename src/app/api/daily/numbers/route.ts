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

  const body = (await response.json()) as {
    total_count?: number;
    data?: { id?: string; number?: string; name?: string; status?: string; verified?: boolean }[];
  };

  const numbers = (body.data ?? [])
    .filter((n): n is { number: string } & typeof n => Boolean(n.number))
    .map((n) => ({
      id: n.id ?? '',
      number: n.number,
      label: n.name ?? n.number,
      status: n.status ?? 'unknown',
      verified: n.verified ?? false,
    }));

  return NextResponse.json({ count: body.total_count ?? numbers.length, numbers });
}
