// ============================================================
// Client for PONTE `GET /vendas` (Inova Farma bridge on the pharmacy PC).
//
// The endpoint does NOT exist yet — this is the contract the bridge must
// implement (see docs in deploy/RECOMPRA-PONTE.md):
//
//   GET {PONTE_URL}/vendas?desde=<ISO-8601>&limite=<n>[&cursor=<opaque>]
//   header: x-api-key: {PONTE_API_KEY}            (same as /produtos/buscar)
//   200 → { "vendas": Venda[], "proximo_cursor": string | null }
//
//   Venda = {
//     id: string | number,                // unique sale id in Inova Farma
//     data: string,                       // ISO-8601 sale timestamp
//     cancelada?: boolean,
//     cliente?: { nome?: string, telefone?: string, aceita_whatsapp?: boolean } | null,
//     itens: { produto_id: string | number, nome?: string, quantidade: number }[]
//   }
// ============================================================

export interface PonteSaleItem {
  productId: string;
  name: string | null;
  quantity: number;
}

export interface PonteSale {
  id: string;
  date: Date;
  customerName: string | null;
  customerPhone: string | null;
  /** `aceita_whatsapp` from the pharmacy system; null when not provided. */
  customerOptIn: boolean | null;
  items: PonteSaleItem[];
}

export type PonteErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'endpoint_unavailable'
  | 'connection_failed'
  | 'bad_response';

export class PonteError extends Error {
  constructor(readonly code: PonteErrorCode, message: string) {
    super(message);
    this.name = 'PonteError';
  }
}

export interface FetchSalesOptions {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  since: Date;
  pageSize?: number;
  maxPages?: number;
  retries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchSalesResult {
  sales: PonteSale[];
  /** Sales dropped because the payload was malformed (logged, never fatal). */
  invalid: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Map one raw sale; returns null when it can't be trusted. */
export function parsePonteSale(raw: unknown): PonteSale | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === 'string' || typeof v.id === 'number' ? String(v.id).trim() : '';
  const date = typeof v.data === 'string' ? new Date(v.data) : null;
  if (!id || !date || Number.isNaN(date.getTime()) || v.cancelada === true) return null;
  if (!Array.isArray(v.itens)) return null;

  const items: PonteSaleItem[] = [];
  for (const it of v.itens) {
    if (!it || typeof it !== 'object') continue;
    const i = it as Record<string, unknown>;
    const productId =
      typeof i.produto_id === 'string' || typeof i.produto_id === 'number'
        ? String(i.produto_id).trim()
        : '';
    const quantity = Number(i.quantidade);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) continue;
    items.push({
      productId,
      name: typeof i.nome === 'string' ? i.nome : null,
      quantity,
    });
  }

  const c = v.cliente && typeof v.cliente === 'object' ? (v.cliente as Record<string, unknown>) : {};
  return {
    id,
    date,
    customerName: typeof c.nome === 'string' && c.nome.trim() ? c.nome.trim() : null,
    customerPhone:
      typeof c.telefone === 'string' || typeof c.telefone === 'number' ? String(c.telefone) : null,
    customerOptIn: typeof c.aceita_whatsapp === 'boolean' ? c.aceita_whatsapp : null,
    items,
  };
}

async function fetchPage(
  url: string,
  opts: Required<Pick<FetchSalesOptions, 'retries' | 'timeoutMs' | 'fetchImpl' | 'sleep'>> & {
    apiKey: string;
  },
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await opts.sleep(500 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await opts.fetchImpl(url, {
        headers: { 'x-api-key': opts.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      lastError = err;
      continue; // network error / timeout → retry
    }
    if (res.status === 401 || res.status === 403) {
      throw new PonteError('unauthorized', `PONTE recusou a chave de API (${res.status})`);
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      throw new PonteError('endpoint_unavailable', 'A PONTE ainda não tem o endpoint /vendas');
    }
    if (res.status >= 500 || res.status === 429) {
      lastError = new Error(`PONTE respondeu ${res.status}`);
      continue;
    }
    if (!res.ok) throw new PonteError('bad_response', `PONTE respondeu ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new PonteError('bad_response', 'PONTE devolveu um JSON inválido');
    }
  }
  const reason = lastError instanceof Error ? lastError.message : 'sem resposta';
  throw new PonteError('connection_failed', `Falha ao conectar na PONTE: ${reason}`);
}

/** Fetch every sale since `since`, following `proximo_cursor`. */
export async function fetchPonteSales(options: FetchSalesOptions): Promise<FetchSalesResult> {
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/, '');
  const apiKey = options.apiKey?.trim();
  if (!baseUrl || !apiKey) {
    throw new PonteError('not_configured', 'PONTE_URL / PONTE_API_KEY não configurados');
  }
  const pageSize = options.pageSize ?? 200;
  const maxPages = options.maxPages ?? 50;
  const pageOpts = {
    apiKey,
    retries: options.retries ?? 2,
    timeoutMs: options.timeoutMs ?? 15_000,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? defaultSleep,
  };

  const sales: PonteSale[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ desde: options.since.toISOString(), limite: String(pageSize) });
    if (cursor) params.set('cursor', cursor);
    const body = await fetchPage(`${baseUrl}/vendas?${params}`, pageOpts);

    const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    if (!obj || !Array.isArray(obj.vendas)) {
      throw new PonteError('bad_response', 'Resposta da PONTE sem a lista "vendas"');
    }
    for (const raw of obj.vendas) {
      const sale = parsePonteSale(raw);
      if (!sale) {
        invalid++;
        continue;
      }
      if (seen.has(sale.id)) continue; // overlapping pages
      seen.add(sale.id);
      sales.push(sale);
    }

    const next = typeof obj.proximo_cursor === 'string' && obj.proximo_cursor ? obj.proximo_cursor : null;
    if (!next || next === cursor) break;
    cursor = next;
  }

  return { sales, invalid };
}
