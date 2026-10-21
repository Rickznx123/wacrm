import { describe, expect, it, vi } from 'vitest';

import { fetchPonteSales, PonteError } from './ponte-client';

const since = new Date('2026-10-01T00:00:00Z');
const noSleep = async () => {};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const venda = (id: string | number, extra: Record<string, unknown> = {}) => ({
  id,
  data: '2026-10-02T10:00:00-03:00',
  cliente: { nome: 'Maria', telefone: '(55) 99976-5693', aceita_whatsapp: true },
  itens: [{ produto_id: 1001, nome: 'Fralda G', quantidade: 2 }],
  ...extra,
});

const opts = (fetchImpl: typeof fetch) => ({
  baseUrl: 'http://ponte.local/',
  apiKey: 'k',
  since,
  fetchImpl,
  sleep: noSleep,
});

describe('fetchPonteSales', () => {
  it('follows proximo_cursor, sends auth and dedupes overlapping pages', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      return u.searchParams.get('cursor') === 'p2'
        ? json({ vendas: [venda('V2'), venda('V3')], proximo_cursor: null })
        : json({ vendas: [venda('V1'), venda('V2')], proximo_cursor: 'p2' });
    }) as unknown as typeof fetch;

    const { sales, invalid } = await fetchPonteSales(opts(fetchImpl));

    expect(sales.map((s) => s.id)).toEqual(['V1', 'V2', 'V3']);
    expect(invalid).toBe(0);
    const [firstUrl, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(firstUrl)).toBe(
      'http://ponte.local/vendas?desde=2026-10-01T00%3A00%3A00.000Z&limite=200',
    );
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'k' });
    expect(sales[0]).toMatchObject({
      customerPhone: '(55) 99976-5693',
      customerOptIn: true,
      items: [{ productId: '1001', quantity: 2 }],
    });
  });

  it('counts malformed and cancelled sales without failing the sync', async () => {
    const fetchImpl = (async () =>
      json({
        vendas: [
          venda('V1'),
          { id: 'V2' }, // no date / items
          venda('V3', { data: 'not-a-date' }),
          venda('V4', { cancelada: true }),
          venda('', {}),
        ],
      })) as unknown as typeof fetch;

    const { sales, invalid } = await fetchPonteSales(opts(fetchImpl));
    expect(sales.map((s) => s.id)).toEqual(['V1']);
    expect(invalid).toBe(4);
  });

  it('retries network errors and 5xx, then succeeds', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return json({ error: 'busy' }, 503);
      return json({ vendas: [venda('V1')] });
    }) as unknown as typeof fetch;

    const { sales } = await fetchPonteSales(opts(fetchImpl));
    expect(sales).toHaveLength(1);
    expect(n).toBe(3);
  });

  it('gives up with connection_failed after the retries', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(fetchPonteSales(opts(fetchImpl))).rejects.toMatchObject({ code: 'connection_failed' });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'endpoint_unavailable'],
    [400, 'bad_response'],
  ])('maps HTTP %s to %s without retrying', async (status, code) => {
    const fetchImpl = vi.fn(async () => json({}, status)) as unknown as typeof fetch;
    await expect(fetchPonteSales(opts(fetchImpl))).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a body without the vendas list', async () => {
    const fetchImpl = (async () => json({ data: [] })) as unknown as typeof fetch;
    await expect(fetchPonteSales(opts(fetchImpl))).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('requires PONTE_URL and PONTE_API_KEY', async () => {
    await expect(
      fetchPonteSales({ baseUrl: undefined, apiKey: 'k', since }),
    ).rejects.toBeInstanceOf(PonteError);
  });

  it('stops at maxPages even if the bridge keeps returning cursors', async () => {
    let page = 0;
    const fetchImpl = (async () => {
      page++;
      return json({ vendas: [venda(`V${page}`)], proximo_cursor: `c${page}` });
    }) as unknown as typeof fetch;
    const { sales } = await fetchPonteSales({ ...opts(fetchImpl), maxPages: 3 });
    expect(sales).toHaveLength(3);
  });
});
