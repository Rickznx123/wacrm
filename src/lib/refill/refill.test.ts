import { describe, expect, it } from 'vitest';

import {
  DAY_MS,
  decideReminder,
  expectedEndAt,
  isOptOutMessage,
  normalizeBrMobile,
  reminderAt,
  renderReminderMessage,
  type ContactPreferences,
  type RefillProduct,
  type RefillSettings,
} from './core';
import type { PonteSale } from './ponte-client';
import {
  dispatchDueReminders,
  ingestSales,
  type DueReminder,
  type NewPurchase,
  type RefillRepo,
} from './service';

// ---------- fixtures ----------

const SETTINGS: RefillSettings = {
  enabled: true,
  sending_enabled: true,
  default_lead_days: 3,
  message_template: 'Oi {primeiro_nome}, seu {produto} acaba em {data_prevista}. {inexistente}',
  sensitive_message_template: 'Oi {primeiro_nome}, um item da sua compra acaba em {data_prevista}.',
};

const FRALDA: RefillProduct = {
  id: 'p-fralda',
  external_product_id: '1001',
  name: 'Fralda G',
  days_per_unit: 30,
  quantity_based: true,
  lead_days: null,
  sensitive: false,
  active: true,
};
const REMEDIO: RefillProduct = {
  id: 'p-remedio',
  external_product_id: '2002',
  name: 'Losartana 50mg',
  days_per_unit: 30,
  quantity_based: true,
  lead_days: 5,
  sensitive: true,
  active: true,
};

const D = (iso: string) => new Date(iso);

function sale(id: string, date: string, phone: string | null, items: [string, number][], extra: Partial<PonteSale> = {}): PonteSale {
  return {
    id,
    date: D(date),
    customerName: 'Maria Souza',
    customerPhone: phone,
    customerOptIn: null,
    items: items.map(([productId, quantity]) => ({ productId, name: null, quantity })),
    ...extra,
  };
}

/** In-memory repo enforcing the same unique keys as migration 045. */
class MemoryRepo implements RefillRepo {
  contacts = new Map<string, { id: string; name: string | null; phone: string }>();
  prefs = new Map<string, ContactPreferences>();
  purchases: (NewPurchase & { id: string })[] = [];
  reminders: {
    id: string;
    purchaseId: string;
    contactId: string;
    productId: string;
    scheduledFor: Date;
    status: string;
    cancelReason?: string;
    message?: string;
  }[] = [];
  products = new Map<string, RefillProduct>([[FRALDA.id, FRALDA], [REMEDIO.id, REMEDIO]]);

  async findOrCreateContact(phone: string, name: string | null) {
    const existing = [...this.contacts.values()].find((c) => c.phone === phone);
    if (existing) return { id: existing.id };
    const c = { id: `c-${this.contacts.size + 1}`, name, phone };
    this.contacts.set(c.id, c);
    return { id: c.id };
  }
  async recordSystemOptIn(contactId: string) {
    const p = this.prefs.get(contactId);
    if (p?.opted_in || p?.opted_out_at) return;
    this.prefs.set(contactId, { opted_in: true, opted_out_at: null, allow_health_details: false });
  }
  async insertPurchase(p: NewPurchase) {
    if (this.purchases.some((x) => x.externalSaleId === p.externalSaleId && x.externalItemKey === p.externalItemKey)) {
      return null;
    }
    const row = { ...p, id: `pu-${this.purchases.length + 1}` };
    this.purchases.push(row);
    return { id: row.id };
  }
  async latestPurchaseAt(contactId: string, productId: string) {
    const dates = this.purchases
      .filter((p) => p.contactId === contactId && p.productId === productId)
      .map((p) => p.purchasedAt.getTime());
    return dates.length ? new Date(Math.max(...dates)) : null;
  }
  async insertReminder(r: { purchaseId: string; contactId: string; productId: string; scheduledFor: Date; cancelReason?: string }) {
    if (this.reminders.some((x) => x.purchaseId === r.purchaseId)) return false;
    this.reminders.push({
      id: `r-${this.reminders.length + 1}`,
      ...r,
      status: r.cancelReason ? 'cancelled' : 'pending',
    });
    return true;
  }
  async cancelOlderPendingReminders(contactId: string, productId: string, before: Date) {
    let n = 0;
    for (const r of this.reminders) {
      const p = this.purchases.find((x) => x.id === r.purchaseId)!;
      if (r.contactId === contactId && r.productId === productId && r.status === 'pending' && p.purchasedAt < before) {
        r.status = 'cancelled';
        r.cancelReason = 'recomprado';
        n++;
      }
    }
    return n;
  }
  async listDueReminders(now: Date, limit: number): Promise<DueReminder[]> {
    return this.reminders
      .filter((r) => r.status === 'pending' && r.scheduledFor <= now)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        accountId: 'acc-1',
        scheduledFor: r.scheduledFor,
        expectedEnd: this.purchases.find((p) => p.id === r.purchaseId)!.expectedEndAt,
        contact: this.contacts.get(r.contactId)!,
        product: this.products.get(r.productId)!,
        prefs: this.prefs.get(r.contactId) ?? null,
        settings: this.settings,
      }));
  }
  async claimReminder(id: string) {
    const r = this.reminders.find((x) => x.id === id)!;
    if (r.status !== 'pending') return false;
    r.status = 'sending';
    return true;
  }
  async markSent(id: string, info: { message: string }) {
    const r = this.reminders.find((x) => x.id === id)!;
    r.status = 'sent';
    r.message = info.message;
  }
  async markFailed(id: string) {
    this.reminders.find((x) => x.id === id)!.status = 'failed';
  }
  async cancelReminder(id: string, reason: string) {
    const r = this.reminders.find((x) => x.id === id)!;
    if (r.status !== 'pending') return;
    r.status = 'cancelled';
    r.cancelReason = reason;
  }
  settings: RefillSettings = SETTINGS;
}

const optIn = (repo: MemoryRepo, contactId: string, extra: Partial<ContactPreferences> = {}) =>
  repo.prefs.set(contactId, { opted_in: true, opted_out_at: null, allow_health_details: false, ...extra });

// ---------- core ----------

describe('normalizeBrMobile', () => {
  it.each([
    ['(55) 99976-5693', '5555999765693'],
    ['055 99976 5693', '5555999765693'],
    ['+55 11 98765-4321', '5511987654321'],
    ['5511987654321', '5511987654321'],
    ['11 8765-4321', '551187654321'], // legacy 8-digit mobile
  ])('accepts %s', (raw, expected) => {
    expect(normalizeBrMobile(raw)).toBe(expected);
  });

  it.each([
    ['11 3333-4444'], // landline
    ['12345'],
    [''],
    [null],
    ['+1 415 555 0123'],
    ['5511887654321'], // 13 digits without the mobile 9
    ['00 98765-4321'], // invalid DDD
  ])('rejects %s', (raw) => {
    expect(normalizeBrMobile(raw)).toBeNull();
  });
});

describe('schedule', () => {
  const bought = D('2026-10-01T12:00:00Z');

  it('multiplies duration by quantity (2 x 30 = 60 days)', () => {
    expect(expectedEndAt(bought, FRALDA, 2)).toEqual(new Date(bought.getTime() + 60 * DAY_MS));
  });

  it('ignores quantity when consumption is not quantity based', () => {
    expect(expectedEndAt(bought, { ...FRALDA, quantity_based: false }, 3)).toEqual(
      new Date(bought.getTime() + 30 * DAY_MS),
    );
  });

  it('schedules lead days before the end, never before the purchase', () => {
    const end = expectedEndAt(bought, FRALDA, 1);
    expect(reminderAt(bought, end, 3)).toEqual(new Date(end.getTime() - 3 * DAY_MS));
    expect(reminderAt(bought, new Date(bought.getTime() + DAY_MS), 10)).toEqual(bought);
  });
});

describe('renderReminderMessage', () => {
  const end = D('2026-11-03T12:00:00Z');

  it('fills variables and drops unknown placeholders', () => {
    expect(renderReminderMessage(SETTINGS, FRALDA, null, 'Maria Souza', end)).toBe(
      'Oi Maria, seu Fralda G acaba em 03/11.',
    );
  });

  it('never names a sensitive product without health-detail consent', () => {
    const msg = renderReminderMessage(SETTINGS, REMEDIO, { allow_health_details: false }, 'Maria', end);
    expect(msg).not.toContain('Losartana');
    expect(msg).toBe('Oi Maria, um item da sua compra acaba em 03/11.');
  });

  it('names a sensitive product once the customer allowed it', () => {
    const msg = renderReminderMessage(SETTINGS, REMEDIO, { allow_health_details: true }, 'Maria', end);
    expect(msg).toContain('Losartana 50mg');
  });

  it('falls back to "cliente" without a name', () => {
    expect(renderReminderMessage(SETTINGS, FRALDA, null, null, end)).toContain('Oi cliente');
  });
});

describe('decideReminder', () => {
  const base = {
    settings: SETTINGS,
    sendingAllowedByEnv: true,
    product: FRALDA,
    prefs: { opted_in: true, opted_out_at: null, allow_health_details: false } as ContactPreferences,
    expectedEnd: D('2026-11-03T00:00:00Z'),
    now: D('2026-10-31T00:00:00Z'),
  };

  it('sends when everything is authorized', () => {
    expect(decideReminder(base)).toEqual({ action: 'send' });
  });
  it('waits while the module is off', () => {
    expect(decideReminder({ ...base, settings: { ...SETTINGS, enabled: false } }).action).toBe('wait');
  });
  it('waits (dry run) when the account switch or the server flag is off', () => {
    expect(decideReminder({ ...base, settings: { ...SETTINGS, sending_enabled: false } })).toEqual({
      action: 'wait',
      reason: 'sending_disabled',
    });
    expect(decideReminder({ ...base, sendingAllowedByEnv: false }).action).toBe('wait');
  });
  it('cancels without consent, after opt-out, for inactive products and when expired', () => {
    expect(decideReminder({ ...base, prefs: null })).toEqual({ action: 'cancel', reason: 'sem_autorizacao' });
    expect(decideReminder({ ...base, prefs: { ...base.prefs, opted_out_at: '2026-10-01' } })).toEqual({
      action: 'cancel',
      reason: 'descadastrado',
    });
    expect(decideReminder({ ...base, product: { ...FRALDA, active: false } }).action).toBe('cancel');
    expect(decideReminder({ ...base, now: D('2026-11-20T00:00:00Z') })).toEqual({
      action: 'cancel',
      reason: 'expirado',
    });
  });
});

describe('isOptOutMessage', () => {
  it.each(['SAIR', 'sair', ' Parar! ', 'Pare', 'stop', 'Cancelar lembretes'])('opts out on %s', (t) => {
    expect(isOptOutMessage(t)).toBe(true);
  });
  it.each(['não quero parar o remédio', 'sair amanhã', '', null])('ignores %s', (t) => {
    expect(isOptOutMessage(t)).toBe(false);
  });
});

// ---------- ingest (simulated PONTE sales) ----------

describe('ingestSales', () => {
  const products = [FRALDA, REMEDIO];

  it('creates one purchase + reminder per refill product and skips the rest', async () => {
    const repo = new MemoryRepo();
    const summary = await ingestSales(repo, SETTINGS, products, [
      sale('V1', '2026-10-01T10:00:00-03:00', '(55) 99976-5693', [['1001', 2], ['9999', 1]]),
      sale('V2', '2026-10-01T11:00:00-03:00', '11 3333-4444', [['1001', 1]]), // landline
      sale('V3', '2026-10-01T12:00:00-03:00', '(55) 99976-5693', [['9999', 1]]), // no refill product
      sale('V4', '2026-10-01T13:00:00-03:00', null, [['2002', 1]]), // anonymous counter sale
    ]);

    expect(summary).toMatchObject({
      sales: 4,
      purchasesCreated: 1,
      invalidPhone: 2,
      withoutRefillProduct: 1,
      duplicates: 0,
    });
    expect(repo.purchases[0]).toMatchObject({ quantity: 2, externalSaleId: 'V1', externalItemKey: '1001' });
    // 2 x 30 days, reminded 3 days (default lead) before the end
    const bought = D('2026-10-01T10:00:00-03:00').getTime();
    expect(repo.purchases[0].expectedEndAt.getTime()).toBe(bought + 60 * DAY_MS);
    expect(repo.reminders[0].scheduledFor.getTime()).toBe(bought + 57 * DAY_MS);
  });

  it('is idempotent when the same sales are synced again', async () => {
    const repo = new MemoryRepo();
    const sales = [sale('V1', '2026-10-01T10:00:00Z', '55999765693', [['1001', 1]])];
    await ingestSales(repo, SETTINGS, products, sales);
    const again = await ingestSales(repo, SETTINGS, products, sales);

    expect(again).toMatchObject({ purchasesCreated: 0, duplicates: 1 });
    expect(repo.purchases).toHaveLength(1);
    expect(repo.reminders).toHaveLength(1);
  });

  it('sums repeated lines of the same product in one sale', async () => {
    const repo = new MemoryRepo();
    await ingestSales(repo, SETTINGS, products, [
      sale('V1', '2026-10-01T10:00:00Z', '55999765693', [['1001', 1], ['1001', 2]]),
    ]);
    expect(repo.purchases).toHaveLength(1);
    expect(repo.purchases[0].quantity).toBe(3);
  });

  it('uses the product lead days over the default', async () => {
    const repo = new MemoryRepo();
    await ingestSales(repo, SETTINGS, products, [sale('V1', '2026-10-01T00:00:00Z', '55999765693', [['2002', 1]])]);
    expect(repo.reminders[0].scheduledFor).toEqual(D('2026-10-26T00:00:00Z')); // 30 - 5
  });

  it('a new purchase cancels the pending reminder of the previous one', async () => {
    const repo = new MemoryRepo();
    await ingestSales(repo, SETTINGS, products, [sale('V1', '2026-10-01T00:00:00Z', '55999765693', [['1001', 1]])]);
    await ingestSales(repo, SETTINGS, products, [sale('V2', '2026-10-20T00:00:00Z', '55999765693', [['1001', 1]])]);

    expect(repo.reminders.map((r) => [r.status, r.cancelReason])).toEqual([
      ['cancelled', 'recomprado'],
      ['pending', undefined],
    ]);
  });

  it('an older sale synced late is stored as history, not reminded', async () => {
    const repo = new MemoryRepo();
    await ingestSales(repo, SETTINGS, products, [sale('V2', '2026-10-20T00:00:00Z', '55999765693', [['1001', 1]])]);
    await ingestSales(repo, SETTINGS, products, [sale('V1', '2026-10-01T00:00:00Z', '55999765693', [['1001', 1]])]);

    expect(repo.reminders.map((r) => r.status)).toEqual(['pending', 'cancelled']);
  });

  it('records the pharmacy opt-in but never overrides an opt-out', async () => {
    const repo = new MemoryRepo();
    await ingestSales(repo, SETTINGS, products, [
      sale('V1', '2026-10-01T00:00:00Z', '55999765693', [['1001', 1]], { customerOptIn: true }),
    ]);
    expect(repo.prefs.get('c-1')?.opted_in).toBe(true);

    repo.prefs.set('c-1', { opted_in: false, opted_out_at: '2026-10-02', allow_health_details: false });
    await ingestSales(repo, SETTINGS, products, [
      sale('V2', '2026-10-05T00:00:00Z', '55999765693', [['1001', 1]], { customerOptIn: true }),
    ]);
    expect(repo.prefs.get('c-1')?.opted_in).toBe(false);
  });

  it('ignores inactive products', async () => {
    const repo = new MemoryRepo();
    const summary = await ingestSales(repo, SETTINGS, [{ ...FRALDA, active: false }], [
      sale('V1', '2026-10-01T00:00:00Z', '55999765693', [['1001', 1]]),
    ]);
    expect(summary.withoutRefillProduct).toBe(1);
  });
});

// ---------- dispatch ----------

describe('dispatchDueReminders', () => {
  async function seeded(settings: RefillSettings = SETTINGS) {
    const repo = new MemoryRepo();
    repo.settings = settings;
    await ingestSales(repo, settings, [FRALDA, REMEDIO], [
      sale('V1', '2026-10-01T00:00:00Z', '55999765693', [['1001', 1]]),
    ]);
    return repo;
  }
  const dueNow = { now: D('2026-10-29T00:00:00Z'), sendingAllowedByEnv: true };

  it('sends once and never again on cron reprocessing', async () => {
    const repo = await seeded();
    optIn(repo, 'c-1');
    const sent: string[] = [];
    const send = async (r: DueReminder, msg: string) => {
      sent.push(`${r.contact.phone}: ${msg}`);
      return { conversationId: 'conv-1', messageId: 'msg-1' };
    };

    const first = await dispatchDueReminders(repo, send, dueNow);
    const second = await dispatchDueReminders(repo, send, dueNow);

    expect(first.sent).toBe(1);
    expect(second).toMatchObject({ due: 0, sent: 0 });
    // 2026-10-31T00:00Z is still 30/10 in São Paulo
    expect(sent).toEqual(['5555999765693: Oi Maria, seu Fralda G acaba em 30/10.']);
    expect(repo.reminders[0].status).toBe('sent');
  });

  it('does not send while sending is disabled (default) — reminder stays pending', async () => {
    const repo = await seeded({ ...SETTINGS, sending_enabled: false });
    optIn(repo, 'c-1');
    let calls = 0;
    const summary = await dispatchDueReminders(repo, async () => {
      calls++;
      return { conversationId: 'x', messageId: 'y' };
    }, dueNow);

    expect(calls).toBe(0);
    expect(summary.waiting).toBe(1);
    expect(repo.reminders[0].status).toBe('pending');
  });

  it('does not send without the server flag even if the account enabled it', async () => {
    const repo = await seeded();
    optIn(repo, 'c-1');
    let calls = 0;
    await dispatchDueReminders(repo, async () => {
      calls++;
      return { conversationId: 'x', messageId: 'y' };
    }, { ...dueNow, sendingAllowedByEnv: false });
    expect(calls).toBe(0);
  });

  it('cancels instead of sending to customers without consent', async () => {
    const repo = await seeded();
    const summary = await dispatchDueReminders(repo, async () => {
      throw new Error('must not send');
    }, dueNow);
    expect(summary.cancelled).toBe(1);
    expect(repo.reminders[0]).toMatchObject({ status: 'cancelled', cancelReason: 'sem_autorizacao' });
  });

  it('does not send reminders that are not due yet', async () => {
    const repo = await seeded();
    optIn(repo, 'c-1');
    const summary = await dispatchDueReminders(repo, async () => ({ conversationId: 'x', messageId: 'y' }), {
      ...dueNow,
      now: D('2026-10-20T00:00:00Z'),
    });
    expect(summary.due).toBe(0);
  });

  it('marks a failed send as failed and does not retry it', async () => {
    const repo = await seeded();
    optIn(repo, 'c-1');
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error('Evolution API error: timeout');
    };
    const first = await dispatchDueReminders(repo, failing, dueNow);
    await dispatchDueReminders(repo, failing, dueNow);

    expect(first.failed).toBe(1);
    expect(calls).toBe(1);
    expect(repo.reminders[0].status).toBe('failed');
  });

  it('skips a reminder another run already claimed', async () => {
    const repo = await seeded();
    optIn(repo, 'c-1');
    const due = await repo.listDueReminders(dueNow.now, 50);
    repo.listDueReminders = async () => due; // stale list, as in two overlapping crons
    await repo.claimReminder(due[0].id);

    const summary = await dispatchDueReminders(repo, async () => {
      throw new Error('must not send');
    }, dueNow);
    expect(summary.alreadyClaimed).toBe(1);
  });
});
