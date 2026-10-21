import type { SupabaseClient } from '@supabase/supabase-js';

import { DAY_MS, type RefillSettings } from './core';
import { fetchPonteSales, PonteError } from './ponte-client';
import { ingestSales, type IngestSummary } from './service';
import { createSupabaseRefillRepo, loadRefillProducts } from './supabase-repo';

/** Re-read this window on every sync; duplicates are dropped by the unique keys. */
const SYNC_OVERLAP_DAYS = 2;
/** First sync looks this far back. */
const FIRST_SYNC_DAYS = 45;

export type SyncOutcome =
  | ({ ok: true; invalidSales: number } & IngestSummary)
  | { ok: false; error: string; code: string };

/**
 * PONTE_URL is one pharmacy's bridge, so it's bound to exactly one account
 * (REFILL_PONTE_ACCOUNT_ID). Any other account never receives its sales.
 */
export function ponteAccountId(): string | null {
  return process.env.REFILL_PONTE_ACCOUNT_ID?.trim() || null;
}

export async function syncAccountFromPonte(
  db: SupabaseClient,
  ctx: { accountId: string; auditUserId: string; settings: RefillSettings; now?: Date; fetchImpl?: typeof fetch },
): Promise<SyncOutcome> {
  if (ponteAccountId() !== ctx.accountId) {
    return { ok: false, code: 'not_bound', error: 'Esta conta não está vinculada à PONTE (REFILL_PONTE_ACCOUNT_ID).' };
  }
  const now = ctx.now ?? new Date();

  const { data: row } = await db
    .from('refill_settings')
    .select('last_synced_at')
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  const last = row?.last_synced_at ? new Date(row.last_synced_at as string) : null;
  const since = last
    ? new Date(last.getTime() - SYNC_OVERLAP_DAYS * DAY_MS)
    : new Date(now.getTime() - FIRST_SYNC_DAYS * DAY_MS);

  let outcome: SyncOutcome;
  try {
    const { sales, invalid } = await fetchPonteSales({
      baseUrl: process.env.PONTE_URL,
      apiKey: process.env.PONTE_API_KEY,
      since,
      fetchImpl: ctx.fetchImpl,
    });
    const products = await loadRefillProducts(db, ctx.accountId);
    const repo = createSupabaseRefillRepo(db, ctx);
    const summary = await ingestSales(repo, ctx.settings, products, sales);
    outcome = { ok: true, invalidSales: invalid, ...summary };
  } catch (err) {
    outcome =
      err instanceof PonteError
        ? { ok: false, code: err.code, error: err.message }
        : { ok: false, code: 'internal', error: err instanceof Error ? err.message : String(err) };
  }

  await db
    .from('refill_settings')
    .update({
      last_sync_summary: { at: now.toISOString(), ...outcome },
      // Only advance the window after a successful sync.
      ...(outcome.ok ? { last_synced_at: now.toISOString() } : {}),
    })
    .eq('account_id', ctx.accountId);

  return outcome;
}
