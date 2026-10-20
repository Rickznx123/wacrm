// Re-points the webhook of the CRM's existing Evolution instances (acct-*) to
// this deployment. The CRM only sets the webhook when it *creates* an instance,
// so instances created while the app ran on Vercel still post to the old URL.
//
// Dry run by default (prints instance, status and current webhook URL; never
// prints keys or headers). Add --apply to write. --url overrides the target
// (e.g. the old Vercel URL for a rollback).
//
// Run on the VPS, from /opt/wacrm:
//   docker compose run --rm --no-deps -v "$PWD/deploy:/deploy:ro" \
//     --entrypoint node wacrm /deploy/evolution-set-webhook.mjs [--apply] [--url https://...]

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null

const base = process.env.EVOLUTION_API_BASE_URL?.trim().replace(/\/+$/, '')
const apiKey = process.env.EVOLUTION_API_KEY?.trim()
const secret = process.env.EVOLUTION_WEBHOOK_SECRET?.trim()
const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
const target = urlArg || (site && `${site}/api/whatsapp/evolution/webhook`)

const missing = Object.entries({ EVOLUTION_API_BASE_URL: base, EVOLUTION_API_KEY: apiKey, EVOLUTION_WEBHOOK_SECRET: secret, 'NEXT_PUBLIC_SITE_URL or --url': target })
  .filter(([, v]) => !v)
  .map(([k]) => k)
if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}`)
  process.exit(1)
}

// Same events the CRM registers on create (src/integrations/evolution/client.ts).
const DEFAULT_EVENTS = ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT']

async function evo(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}`)
  return text ? JSON.parse(text) : null
}

const list = await evo('/instance/fetchInstances')
const instances = (Array.isArray(list) ? list : [])
  .map((i) => ({
    name: i.name ?? i.instanceName ?? i.instance?.instanceName,
    status: i.connectionStatus ?? i.instance?.status ?? '?',
  }))
  .filter((i) => typeof i.name === 'string' && i.name.startsWith('acct-'))

console.log(`${apply ? 'APPLY' : 'DRY RUN'} → target: ${target}`)
if (!instances.length) console.log('No acct-* instances found.')

let failed = 0
for (const inst of instances) {
  try {
    const current = await evo(`/webhook/find/${encodeURIComponent(inst.name)}`)
    const events = Array.isArray(current?.events) && current.events.length ? current.events : DEFAULT_EVENTS
    console.log(`- ${inst.name} [${inst.status}] current: ${current?.url ?? '(none)'}`)
    if (!apply) continue
    await evo(`/webhook/set/${encodeURIComponent(inst.name)}`, {
      method: 'POST',
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: target,
          headers: { 'x-evolution-secret': secret },
          byEvents: false,
          base64: false,
          events,
        },
      }),
    })
    console.log(`  updated`)
  } catch (err) {
    failed++
    console.error(`  ${inst.name}: ${err.message}`)
  }
}
process.exit(failed ? 1 : 0)
