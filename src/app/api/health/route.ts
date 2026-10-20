import { NextResponse } from 'next/server'

// Liveness probe for the Docker healthcheck / uptime monitors. Touches no
// external service, so a Supabase or Evolution outage won't restart the app.
export function GET() {
  return NextResponse.json({ ok: true })
}
