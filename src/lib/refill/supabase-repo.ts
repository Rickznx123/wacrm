import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import {
  isOptOutMessage,
  REFILL_SETTINGS_DEFAULTS,
  type ContactPreferences,
  type RefillProduct,
  type RefillSettings,
} from './core';
import type { DueReminder, RefillRepo, SendReminder } from './service';

export async function loadRefillSettings(db: SupabaseClient, accountId: string): Promise<RefillSettings> {
  const { data, error } = await db
    .from('refill_settings')
    .select('enabled, sending_enabled, default_lead_days, message_template, sensitive_message_template')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`refill_settings: ${error.message}`);
  return data ? (data as RefillSettings) : REFILL_SETTINGS_DEFAULTS;
}

export async function loadRefillProducts(db: SupabaseClient, accountId: string): Promise<RefillProduct[]> {
  const { data, error } = await db
    .from('refill_products')
    .select('id, external_product_id, name, days_per_unit, quantity_based, lead_days, sensitive, active')
    .eq('account_id', accountId);
  if (error) throw new Error(`refill_products: ${error.message}`);
  return (data ?? []) as RefillProduct[];
}

/**
 * Every query is filtered by `accountId`, so tenancy holds with either the
 * RLS user client (dashboard) or the service-role client (cron).
 */
export function createSupabaseRefillRepo(
  db: SupabaseClient,
  ctx: { accountId: string; auditUserId: string; settings: RefillSettings },
): RefillRepo {
  const { accountId, auditUserId, settings } = ctx;
  const nowIso = () => new Date().toISOString();

  return {
    async findOrCreateContact(phone, name) {
      const existing = await findExistingContact(db, accountId, phone);
      if (existing) return { id: existing.id };
      const { data, error } = await db
        .from('contacts')
        .insert({ account_id: accountId, user_id: auditUserId, phone, name: name || phone })
        .select('id')
        .single();
      if (data) return { id: data.id as string };
      if (isUniqueViolation(error)) {
        const raced = await findExistingContact(db, accountId, phone);
        if (raced) return { id: raced.id };
      }
      console.error('[refill] contact create error:', error);
      return null;
    },

    async recordSystemOptIn(contactId) {
      const { data } = await db
        .from('refill_contact_preferences')
        .select('opted_in, opted_out_at')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .maybeSingle();
      if (data?.opted_in || data?.opted_out_at) return;
      await db.from('refill_contact_preferences').upsert(
        {
          account_id: accountId,
          contact_id: contactId,
          opted_in: true,
          opted_in_at: nowIso(),
          opted_in_source: 'ponte',
        },
        { onConflict: 'account_id,contact_id' },
      );
    },

    async insertPurchase(p) {
      const { data, error } = await db
        .from('refill_purchases')
        .insert({
          account_id: accountId,
          contact_id: p.contactId,
          product_id: p.productId,
          source: p.source,
          external_sale_id: p.externalSaleId,
          external_item_key: p.externalItemKey,
          quantity: p.quantity,
          purchased_at: p.purchasedAt.toISOString(),
          expected_end_at: p.expectedEndAt.toISOString(),
          created_by: p.source === 'manual' ? auditUserId : null,
        })
        .select('id')
        .single();
      if (data) return { id: data.id as string };
      if (isUniqueViolation(error)) return null;
      throw new Error(`refill_purchases insert: ${error?.message}`);
    },

    async latestPurchaseAt(contactId, productId) {
      const { data } = await db
        .from('refill_purchases')
        .select('purchased_at')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('product_id', productId)
        .order('purchased_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ? new Date(data.purchased_at as string) : null;
    },

    async insertReminder(r) {
      const { error } = await db.from('refill_reminders').insert({
        account_id: accountId,
        purchase_id: r.purchaseId,
        contact_id: r.contactId,
        product_id: r.productId,
        scheduled_for: r.scheduledFor.toISOString(),
        status: r.cancelReason ? 'cancelled' : 'pending',
        cancel_reason: r.cancelReason ?? null,
      });
      if (!error) return true;
      if (isUniqueViolation(error)) return false;
      throw new Error(`refill_reminders insert: ${error.message}`);
    },

    async cancelOlderPendingReminders(contactId, productId, before) {
      const { data: older } = await db
        .from('refill_purchases')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('product_id', productId)
        .lt('purchased_at', before.toISOString());
      const ids = (older ?? []).map((row) => row.id as string);
      if (ids.length === 0) return 0;
      const { data } = await db
        .from('refill_reminders')
        .update({ status: 'cancelled', cancel_reason: 'recomprado' })
        .eq('account_id', accountId)
        .eq('status', 'pending')
        .in('purchase_id', ids)
        .select('id');
      return data?.length ?? 0;
    },

    async listDueReminders(now, limit) {
      const { data, error } = await db
        .from('refill_reminders')
        .select(
          'id, account_id, scheduled_for, contact:contacts(id, name, phone), ' +
            'product:refill_products(id, external_product_id, name, days_per_unit, quantity_based, lead_days, sensitive, active), ' +
            'purchase:refill_purchases(expected_end_at)',
        )
        .eq('account_id', accountId)
        .eq('status', 'pending')
        .lte('scheduled_for', now.toISOString())
        .order('scheduled_for', { ascending: true })
        .limit(limit);
      if (error) throw new Error(`refill_reminders due: ${error.message}`);
      const rows = (data ?? []) as unknown as Array<{
        id: string;
        account_id: string;
        scheduled_for: string;
        contact: { id: string; name: string | null; phone: string } | null;
        product: RefillProduct | null;
        purchase: { expected_end_at: string } | null;
      }>;

      const contactIds = rows.map((r) => r.contact?.id).filter((id): id is string => !!id);
      const prefsByContact = new Map<string, ContactPreferences>();
      if (contactIds.length > 0) {
        const { data: prefs } = await db
          .from('refill_contact_preferences')
          .select('contact_id, opted_in, opted_out_at, allow_health_details')
          .eq('account_id', accountId)
          .in('contact_id', contactIds);
        for (const p of prefs ?? []) prefsByContact.set(p.contact_id as string, p as ContactPreferences);
      }

      return rows
        .filter((r) => r.contact && r.product && r.purchase)
        .map<DueReminder>((r) => ({
          id: r.id,
          accountId: r.account_id,
          scheduledFor: new Date(r.scheduled_for),
          expectedEnd: new Date(r.purchase!.expected_end_at),
          contact: r.contact!,
          product: r.product!,
          prefs: prefsByContact.get(r.contact!.id) ?? null,
          settings,
        }));
    },

    async claimReminder(id) {
      const { data } = await db
        .from('refill_reminders')
        .update({ status: 'sending' })
        .eq('id', id)
        .eq('account_id', accountId)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();
      return !!data;
    },

    async markSent(id, info) {
      await db
        .from('refill_reminders')
        .update({
          status: 'sent',
          sent_at: nowIso(),
          rendered_message: info.message,
          conversation_id: info.conversationId,
          message_id: info.messageId,
          last_error: null,
        })
        .eq('id', id)
        .eq('account_id', accountId);
    },

    async markFailed(id, error, message) {
      await db
        .from('refill_reminders')
        .update({ status: 'failed', last_error: error.slice(0, 500), rendered_message: message })
        .eq('id', id)
        .eq('account_id', accountId);
    },

    async cancelReminder(id, reason) {
      await db
        .from('refill_reminders')
        .update({ status: 'cancelled', cancel_reason: reason })
        .eq('id', id)
        .eq('account_id', accountId)
        .eq('status', 'pending');
    },
  };
}

/** Send through the existing core (Evolution when connected, else Meta). */
export function createReminderSender(
  db: SupabaseClient,
  ctx: { accountId: string; auditUserId: string },
): SendReminder {
  return async (reminder, message) => {
    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', reminder.contact.id)
      .maybeSingle();

    let conversationId = conv?.id as string | undefined;
    if (!conversationId) {
      const { data: created, error } = await db
        .from('conversations')
        .insert({
          account_id: ctx.accountId,
          user_id: ctx.auditUserId,
          contact_id: reminder.contact.id,
          status: 'pending',
        })
        .select('id')
        .single();
      if (!created) throw new Error(`conversation create failed: ${error?.message}`);
      conversationId = created.id as string;
    }

    const result = await sendMessageToConversation(db, ctx.accountId, {
      conversationId,
      messageType: 'text',
      contentText: message,
    });
    return { conversationId, messageId: result.messageId };
  };
}

/** Inbound hook for both webhooks; never throws into the message pipeline. */
export async function handleInboundRefillOptOut(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  text: string | null | undefined,
): Promise<void> {
  if (!isOptOutMessage(text)) return;
  try {
    await applyRefillOptOut(db, accountId, contactId);
  } catch (err) {
    console.warn('[refill] opt-out failed:', err instanceof Error ? err.message : err);
  }
}

/** Customer replied SAIR/PARAR: opt out and cancel everything pending. */
export async function applyRefillOptOut(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<void> {
  await db.from('refill_contact_preferences').upsert(
    {
      account_id: accountId,
      contact_id: contactId,
      opted_in: false,
      opted_out_at: new Date().toISOString(),
    },
    { onConflict: 'account_id,contact_id' },
  );
  await db
    .from('refill_reminders')
    .update({ status: 'cancelled', cancel_reason: 'descadastrado' })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'pending');
}
