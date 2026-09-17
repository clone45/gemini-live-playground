import { NextResponse } from 'next/server';

/**
 * Creates a short-lived Daily room with dial-out enabled plus an owner token.
 *
 * Both are required by Daily: PSTN dial-out only works in a room created with
 * `enable_dialout`, and only a participant holding an owner token may start it.
 * DAILY_API_KEY stays on the server; the browser only ever sees the room URL
 * and the meeting token.
 */

const DAILY_API = 'https://api.daily.co/v1';
const ROOM_MINUTES = 30;

export async function POST() {
  const apiKey = process.env.DAILY_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'DAILY_API_KEY is not set. Add it to .env.local and restart the dev server.' },
      { status: 500 },
    );
  }

  const expires = Math.floor(Date.now() / 1000) + ROOM_MINUTES * 60;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const roomResponse = await fetch(`${DAILY_API}/rooms`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      properties: {
        exp: expires,
        enable_dialout: true,
        enable_chat: false,
        enable_screenshare: false,
        start_video_off: true,
        start_audio_off: false,
      },
    }),
  });

  if (!roomResponse.ok) {
    return NextResponse.json(
      { error: `Daily refused to create the room: ${await roomResponse.text()}` },
      { status: 502 },
    );
  }
  const room = (await roomResponse.json()) as { url: string; name: string };

  const tokenResponse = await fetch(`${DAILY_API}/meeting-tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      properties: {
        room_name: room.name,
        exp: expires,
        is_owner: true, // required to start dial-out
        user_name: 'Gemini Live bridge',
      },
    }),
  });

  if (!tokenResponse.ok) {
    return NextResponse.json(
      { error: `Daily refused to mint a token: ${await tokenResponse.text()}` },
      { status: 502 },
    );
  }
  const token = (await tokenResponse.json()) as { token: string };

  return NextResponse.json({ roomUrl: room.url, roomName: room.name, token: token.token, expires });
}
