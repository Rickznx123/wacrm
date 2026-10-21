// ============================================================
// Recompra automática — pure logic (no I/O), unit-tested in
// refill.test.ts. Tables: supabase/migrations/045_refill_reminders.sql.
// ============================================================

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Reminders this long past the predicted end are cancelled, not sent late. */
export const EXPIRE_AFTER_END_DAYS = 7;

export interface RefillSettings {
  enabled: boolean;
  sending_enabled: boolean;
  default_lead_days: number;
  message_template: string;
  sensitive_message_template: string;
}

/** Same values as the column defaults in migration 045. */
export const REFILL_SETTINGS_DEFAULTS: RefillSettings = {
  enabled: false,
  sending_enabled: false,
  default_lead_days: 3,
  message_template:
    'Olá, {primeiro_nome}! Pela nossa previsão, seu {produto} deve acabar por volta de {data_prevista}. Quer que a gente separe para você? Responda SAIR para não receber mais lembretes.',
  sensitive_message_template:
    'Olá, {primeiro_nome}! Pela nossa previsão, um item da sua última compra deve acabar por volta de {data_prevista}. Quer que a gente separe para você? Responda SAIR para não receber mais lembretes.',
};

export interface RefillProduct {
  id: string;
  external_product_id: string;
  name: string;
  days_per_unit: number;
  quantity_based: boolean;
  lead_days: number | null;
  sensitive: boolean;
  active: boolean;
}

export interface ContactPreferences {
  opted_in: boolean;
  opted_out_at: string | null;
  allow_health_details: boolean;
}

// ---------- phone ----------

/**
 * Normalize a Brazilian phone from the pharmacy system to WhatsApp
 * digits (55 + DDD + number). Returns null when it can't be a mobile:
 * landlines can't receive WhatsApp reminders, and guessing is worse
 * than skipping.
 */
export function normalizeBrMobile(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let digits = String(raw).replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (!digits.startsWith('55')) return null;

  const local = digits.slice(4);
  const ddd = Number(digits.slice(2, 4));
  if (ddd < 11 || ddd > 99 || digits[2] === '0') return null;

  // 9-digit mobile (current format) or 8-digit legacy mobile (6-9 prefix).
  if (digits.length === 13) return local.startsWith('9') ? digits : null;
  if (digits.length === 12) return /^[6-9]/.test(local) ? digits : null;
  return null;
}

// ---------- schedule ----------

export function expectedEndAt(
  purchasedAt: Date,
  product: Pick<RefillProduct, 'days_per_unit' | 'quantity_based'>,
  quantity: number,
): Date {
  const units = product.quantity_based ? Math.max(quantity, 1) : 1;
  const days = Math.round(product.days_per_unit * units);
  return new Date(purchasedAt.getTime() + days * DAY_MS);
}

export function reminderAt(
  purchasedAt: Date,
  endAt: Date,
  leadDays: number,
): Date {
  const at = endAt.getTime() - leadDays * DAY_MS;
  return new Date(Math.max(at, purchasedAt.getTime()));
}

// ---------- message ----------

const BR_DATE = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
});

/**
 * Fill the establishment's template. Only known variables are replaced;
 * any other `{...}` is removed so a typo never leaks raw braces.
 * Sensitive products use the generic template unless the customer
 * allowed health details (the product name never appears otherwise).
 */
export function renderReminderMessage(
  settings: Pick<RefillSettings, 'message_template' | 'sensitive_message_template'>,
  product: Pick<RefillProduct, 'name' | 'sensitive'>,
  prefs: Pick<ContactPreferences, 'allow_health_details'> | null,
  contactName: string | null,
  endAt: Date,
): string {
  const useGeneric = product.sensitive && !prefs?.allow_health_details;
  const template = useGeneric ? settings.sensitive_message_template : settings.message_template;
  const name = (contactName ?? '').trim();
  const vars: Record<string, string> = {
    nome: name || 'cliente',
    primeiro_nome: name.split(/\s+/)[0] || 'cliente',
    produto: useGeneric ? 'item da sua última compra' : product.name,
    data_prevista: BR_DATE.format(endAt),
  };
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------- dispatch decision ----------

export type ReminderDecision =
  | { action: 'send' }
  | { action: 'wait'; reason: 'module_disabled' | 'sending_disabled' }
  | { action: 'cancel'; reason: 'sem_autorizacao' | 'descadastrado' | 'produto_desativado' | 'expirado' };

/**
 * What to do with a due reminder. Consent and expiry are checked even
 * while sending is off, so enabling sends later never flushes a backlog.
 */
export function decideReminder(input: {
  settings: Pick<RefillSettings, 'enabled' | 'sending_enabled'>;
  sendingAllowedByEnv: boolean;
  product: Pick<RefillProduct, 'active'>;
  prefs: ContactPreferences | null;
  expectedEnd: Date;
  now: Date;
}): ReminderDecision {
  const { settings, product, prefs, expectedEnd, now } = input;
  if (!settings.enabled) return { action: 'wait', reason: 'module_disabled' };
  if (!product.active) return { action: 'cancel', reason: 'produto_desativado' };
  if (prefs?.opted_out_at) return { action: 'cancel', reason: 'descadastrado' };
  if (!prefs?.opted_in) return { action: 'cancel', reason: 'sem_autorizacao' };
  if (now.getTime() > expectedEnd.getTime() + EXPIRE_AFTER_END_DAYS * DAY_MS) {
    return { action: 'cancel', reason: 'expirado' };
  }
  if (!settings.sending_enabled || !input.sendingAllowedByEnv) {
    return { action: 'wait', reason: 'sending_disabled' };
  }
  return { action: 'send' };
}

/** Real sends need BOTH the per-account switch and this server env flag. */
export function sendingAllowedByEnv(): boolean {
  return process.env.REFILL_SENDING_ENABLED === 'true';
}

// ---------- opt-out ----------

const OPT_OUT_WORDS = new Set(['sair', 'parar', 'pare', 'stop', 'descadastrar', 'cancelar lembretes']);

/** Whole-message match only, so "não quero parar o remédio" never opts out. */
export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
  return OPT_OUT_WORDS.has(normalized);
}
