import { createServer } from 'node:http';

import { LiveProductSearchService } from './product-search.mjs';
import { createProdutosBuscarHandler } from './produtos-buscar-handler.mjs';
import { createSqlServerPool, SqlServerProductHydrator } from './sql-server-hydrator.mjs';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing env var ${name}`);
  return value;
}

const csvPath = requireEnv('PRODUCT_CSV_PATH');
const idColumn = process.env.PRODUCT_ID_COLUMN?.trim() || 'ID_PRODUTO';
const nameColumn = process.env.PRODUCT_NAME_COLUMN?.trim() || 'NOME';
const extraSearchColumns = (process.env.PRODUCT_EXTRA_SEARCH_COLUMNS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const searchService = await new LiveProductSearchService({
  csvPath,
  indexConfig: {
    idColumn,
    nameColumn,
    extraSearchColumns,
  },
}).start();

const sqlPool = createSqlServerPool({
  server: requireEnv('SQLSERVER_HOST'),
  port: Number(process.env.SQLSERVER_PORT ?? 1433),
  user: requireEnv('SQLSERVER_USER'),
  password: requireEnv('SQLSERVER_PASSWORD'),
  database: requireEnv('SQLSERVER_DATABASE'),
  options: {
    encrypt: process.env.SQLSERVER_ENCRYPT === 'true',
    trustServerCertificate: process.env.SQLSERVER_TRUST_CERT !== 'false',
  },
  pool: {
    max: Number(process.env.SQLSERVER_POOL_MAX ?? 10),
    min: 0,
    idleTimeoutMillis: 30_000,
  },
});

const hydrator = new SqlServerProductHydrator({
  poolPromise: sqlPool,
  table: process.env.SQLSERVER_PRODUCTS_TABLE?.trim() || 'dbo.PRODUTOS',
  idColumn,
  selectColumns: (process.env.SQLSERVER_SELECT_COLUMNS ?? '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  whereClause: process.env.SQLSERVER_PRODUCTS_WHERE?.trim() || '',
});

const handleProdutosBuscar = createProdutosBuscarHandler({
  searchService,
  hydrator,
  topK: Number(process.env.PRODUCT_SEARCH_TOP_K ?? 10),
  idField: idColumn,
  formatResponse(products) {
    return {
      total: products.length,
      produtos: products,
    };
  },
});

const port = Number(process.env.PORT ?? 3001);

const server = createServer(async (request, response) => {
  if (request.url === '/healthz') {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: true, index: searchService.getStats() }));
    return;
  }

  const handled = await handleProdutosBuscar(request, response);
  if (handled) return;

  response.statusCode = 404;
  response.end('not found');
});

server.listen(port, () => {
  console.log(`[ponte-product-search] listening on :${port}`);
  console.log('[ponte-product-search] index stats', searchService.getStats());
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await searchService.close();
    const pool = await sqlPool;
    await pool.close();
    process.exit(0);
  });
}