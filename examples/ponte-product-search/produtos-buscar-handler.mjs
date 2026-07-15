import { URL } from 'node:url';

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

export function createProdutosBuscarHandler(options) {
  const {
    searchService,
    hydrator,
    topK = 10,
    idField = 'id',
    formatResponse = (products) => ({ total: products.length, produtos: products }),
    logger = console,
  } = options;

  return async function handleProdutosBuscar(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET' || url.pathname !== '/produtos/buscar') {
      return false;
    }

    const nome = (url.searchParams.get('nome') ?? '').trim();
    if (!nome) {
      sendJson(response, 400, { erro: 'parametro nome e obrigatorio' });
      return true;
    }

    try {
      const hits = searchService.search(nome, { limit: topK });
      const rows = await hydrator.hydrateByIds(hits.map((hit) => hit.id));
      const rowsById = new Map(rows.map((row) => [String(row[idField]), row]));
      const orderedProducts = hits.map((hit) => rowsById.get(String(hit.id))).filter(Boolean);

      sendJson(response, 200, formatResponse(orderedProducts, { hits, query: nome }));
      return true;
    } catch (error) {
      logger.error('[produtos/buscar] request failed', error);
      sendJson(response, 500, { erro: 'falha ao buscar produtos' });
      return true;
    }
  };
}