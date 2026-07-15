import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductSearchIndex } from './product-search.mjs';
import { createProdutosBuscarHandler } from './produtos-buscar-handler.mjs';

function createMockResponse() {
  return {
    statusCode: 0,
    headers: new Map(),
    body: '',
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    end(payload) {
      this.body = payload;
    },
  };
}

test('handler preserves top-k ordering and response format', async () => {
  const index = ProductSearchIndex.fromRows(
    [
      { id: '10', nome: 'Dipirona Sodica Medley 1g' },
      { id: '11', nome: 'Dipirona Generica 500mg' },
    ],
    { idColumn: 'id', nameColumn: 'nome' },
  );

  const response = createMockResponse();
  const handler = createProdutosBuscarHandler({
    searchService: { search: index.search.bind(index) },
    hydrator: {
      async hydrateByIds(ids) {
        return ids.map((id) => ({ id, nome: id === '10' ? 'Dipirona Sodica Medley 1g' : 'Dipirona Generica 500mg' }));
      },
    },
  });

  const handled = await handler(
    { method: 'GET', url: '/produtos/buscar?nome=medley%20dipirona' },
    response,
  );

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);

  const payload = JSON.parse(response.body);
  assert.equal(payload.total, 2);
  assert.equal(payload.produtos[0].id, '10');
});