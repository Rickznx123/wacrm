// ============================================================
// Recompra automática — orchestration over a storage port.
// `RefillRepo` is implemented for Supabase in supabase-repo.ts and
// in memory in refill.test.ts (simulated sales, idempotency checks).
// ============================================================

import {
  decideReminder,
  expectedEndAt,
  normalizeBrMobile,
  reminderAt,
  renderReminderMessage,
  type ContactPreferences,
  type RefillProduct,
  type RefillSettings,
} from './core';
import type { PonteSale } from './ponte-client';

export interface NewPurchase {
  contactId: string;
  productId: string;
  source: 'ponte' | 'manual';
  externalSaleId: string;
  externalItemKey: string;
  quantity: number;
  purchasedAt: Date;
  expectedEndAt: Date;
}

export interface DueReminder {
  id: string;
  accountId: string;
  scheduledFor: Date;
  expectedEnd: Date;
  contact: { id: string; name: string | null; phone: string };
  product: RefillProduct;
  prefs: ContactPreferences | null;
  settings: RefillSettings;
}

export interface RefillRepo {
  findOrCreateContact(phone: string, name: string | null): Promise<{ id: string } | null>;
  /** Opt-in from the pharmacy system; never overrides a previous opt-out. */
  recordSystemOptIn(contactId: string): Promise<void>;
  /** Returns null when this (sale, item) was already stored. */
  insertPurchase(p: NewPurchase): Promise<{ id: string } | null>;
  latestPurchaseAt(contactId: string, productId: string): Promise<Date | null>;
  insertReminder(r: {
    purchaseId: string;
    contactId: string;
    productId: string;
    scheduledFor: Date;
    cancelReason?: string;
  }): Promise<boolean>;
  /** Cancel pending reminders of older purchases of the same product. */
  cancelOlderPendingReminders(contactId: string, productId: string, before: Date): Promise<number>;

  listDueReminders(now: Date, limit: number): Promise<DueReminder[]>;
  /** Atomic pending → sending; false when another run already took it. */
  claimReminder(id: string): Promise<boolean>;
  markSent(id: string, info: { message: string; conversationId: string; messageId: string }): Promise<void>;
  markFailed(id: string, error: string, message: string): Promise<void>;
  cancelReminder(id: string, reason: string): Promise<void>;
}

// ---------- ingest ----------

export interface PurchaseInput {
  contactId: string;
  product: RefillProduct;
  source: 'ponte' | 'manual';
  externalSaleId: string;
  externalItemKey: string;
  quantity: number;
  purchasedAt: Date;
}

export type RecordPurchaseResult = 'created' | 'duplicate';

/** Store one purchase and schedule its reminder. Idempotent per (sale, item). */
export async function recordPurchase(
  repo: RefillRepo,
  settings: Pick<RefillSettings, 'default_lead_days'>,
  input: PurchaseInput,
): Promise<RecordPurchaseResult> {
  const end = expectedEndAt(input.purchasedAt, input.product, input.quantity);
  const latest = await repo.latestPurchaseAt(input.contactId, input.product.id);

  const purchase = await repo.insertPurchase({
    contactId: input.contactId,
    productId: input.product.id,
    source: input.source,
    externalSaleId: input.externalSaleId,
    externalItemKey: input.externalItemKey,
    quantity: input.quantity,
    purchasedAt: input.purchasedAt,
    expectedEndAt: end,
  });
  if (!purchase) return 'duplicate';

  // A newer purchase of the same product already exists (sales synced out
  // of order): this one is history, it must not trigger a message.
  const superseded = latest !== null && latest.getTime() > input.purchasedAt.getTime();
  if (!superseded) {
    await repo.cancelOlderPendingReminders(input.contactId, input.product.id, input.purchasedAt);
  }

  const lead = input.product.lead_days ?? settings.default_lead_days;
  await repo.insertReminder({
    purchaseId: purchase.id,
    contactId: input.contactId,
    productId: input.product.id,
    scheduledFor: reminderAt(input.purchasedAt, end, lead),
    cancelReason: superseded ? 'recomprado' : undefined,
  });
  return 'created';
}

export interface IngestSummary {
  sales: number;
  purchasesCreated: number;
  duplicates: number;
  invalidPhone: number;
  withoutRefillProduct: number;
  contactErrors: number;
}

export async function ingestSales(
  repo: RefillRepo,
  settings: Pick<RefillSettings, 'default_lead_days'>,
  products: RefillProduct[],
  sales: PonteSale[],
): Promise<IngestSummary> {
  const byExternalId = new Map(
    products.filter((p) => p.active).map((p) => [p.external_product_id, p]),
  );
  const summary: IngestSummary = {
    sales: sales.length,
    purchasesCreated: 0,
    duplicates: 0,
    invalidPhone: 0,
    withoutRefillProduct: 0,
    contactErrors: 0,
  };

  for (const sale of sales) {
    // Same product twice in one sale counts as one purchase of the summed quantity.
    const quantities = new Map<string, number>();
    for (const item of sale.items) {
      if (!byExternalId.has(item.productId)) continue;
      quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
    }
    if (quantities.size === 0) {
      summary.withoutRefillProduct++;
      continue;
    }

    const phone = normalizeBrMobile(sale.customerPhone);
    if (!phone) {
      summary.invalidPhone++;
      continue;
    }

    const contact = await repo.findOrCreateContact(phone, sale.customerName);
    if (!contact) {
      summary.contactErrors++;
      continue;
    }
    if (sale.customerOptIn === true) await repo.recordSystemOptIn(contact.id);

    for (const [productId, quantity] of quantities) {
      const result = await recordPurchase(repo, settings, {
        contactId: contact.id,
        product: byExternalId.get(productId)!,
        source: 'ponte',
        externalSaleId: sale.id,
        externalItemKey: productId,
        quantity,
        purchasedAt: sale.date,
      });
      if (result === 'created') summary.purchasesCreated++;
      else summary.duplicates++;
    }
  }

  return summary;
}

// ---------- dispatch ----------

export type SendReminder = (
  reminder: DueReminder,
  message: string,
) => Promise<{ conversationId: string; messageId: string }>;

export interface DispatchSummary {
  due: number;
  sent: number;
  failed: number;
  cancelled: number;
  waiting: number;
  alreadyClaimed: number;
}

export async function dispatchDueReminders(
  repo: RefillRepo,
  send: SendReminder,
  opts: { now: Date; sendingAllowedByEnv: boolean; limit?: number },
): Promise<DispatchSummary> {
  const due = await repo.listDueReminders(opts.now, opts.limit ?? 50);
  const summary: DispatchSummary = {
    due: due.length,
    sent: 0,
    failed: 0,
    cancelled: 0,
    waiting: 0,
    alreadyClaimed: 0,
  };

  for (const reminder of due) {
    const decision = decideReminder({
      settings: reminder.settings,
      sendingAllowedByEnv: opts.sendingAllowedByEnv,
      product: reminder.product,
      prefs: reminder.prefs,
      expectedEnd: reminder.expectedEnd,
      now: opts.now,
    });

    if (decision.action === 'wait') {
      summary.waiting++;
      continue;
    }
    if (decision.action === 'cancel') {
      await repo.cancelReminder(reminder.id, decision.reason);
      summary.cancelled++;
      continue;
    }

    if (!(await repo.claimReminder(reminder.id))) {
      summary.alreadyClaimed++;
      continue;
    }
    const message = renderReminderMessage(
      reminder.settings,
      reminder.product,
      reminder.prefs,
      reminder.contact.name,
      reminder.expectedEnd,
    );
    try {
      const result = await send(reminder, message);
      await repo.markSent(reminder.id, { message, ...result });
      summary.sent++;
    } catch (err) {
      // Not retried automatically: a timeout may still have delivered it.
      await repo.markFailed(reminder.id, err instanceof Error ? err.message : String(err), message);
      summary.failed++;
    }
  }

  return summary;
}
