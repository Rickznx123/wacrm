# In-memory product search for PONTE

This is a drop-in Node.js implementation for the `/produtos/buscar` strategy you described when the SQL Server side is too limited for robust search.

## What it does

- Loads the product CSV once at startup.
- Builds an in-memory search index optimized for exact token matches first.
- Normalizes accents, casing, punctuation, and word order.
- Tolerates typos with a BK-tree plus phonetic fallback.
- Ranks candidates by exact-token hits, fuzzy-token hits, token coverage, phrase match, and trigram similarity.
- Returns only the top 10 hits from memory.
- Uses SQL Server only to hydrate the chosen product ids with fresh price, stock, promotion, and other live fields.
- Watches the CSV file and hot-reloads the index automatically without restarting the process.

## Why this approach

For roughly 161k products, a hybrid inverted index in JavaScript is usually faster and more predictable than pushing fuzzy logic into SQL Server 2016. It avoids `STRING_SPLIT`, XML tricks, full-text feature drift, and collation edge cases on the database side.

The implementation intentionally does not use Fuse.js for the primary search path because Fuse tends toward broader scans and higher per-query CPU at this data size. This version keeps the hot path on exact-token postings and only uses fuzzy expansion on the query tokens themselves.

## Files

- `product-search.mjs`: normalization, CSV loading, indexing, ranking, and live reload.
- `sql-server-hydrator.mjs`: SQL Server fetch by id after the in-memory match.
- `produtos-buscar-handler.mjs`: framework-agnostic HTTP handler for `GET /produtos/buscar?nome=...`.
- `server.mjs`: minimal standalone server wiring.

## Expected CSV columns

At minimum, configure these env vars:

- `PRODUCT_CSV_PATH`: absolute path to the CSV.
- `PRODUCT_ID_COLUMN`: product id column used both by CSV and SQL Server.
- `PRODUCT_NAME_COLUMN`: product name column used for search.
- `PRODUCT_EXTRA_SEARCH_COLUMNS`: optional comma-separated fields to index too, such as brand or active ingredient.

## SQL Server env vars

- `SQLSERVER_HOST`
- `SQLSERVER_PORT`
- `SQLSERVER_USER`
- `SQLSERVER_PASSWORD`
- `SQLSERVER_DATABASE`
- `SQLSERVER_PRODUCTS_TABLE`
- `SQLSERVER_SELECT_COLUMNS`
- `SQLSERVER_PRODUCTS_WHERE`

## Run

Install `mssql`, set the env vars, then start:

```bash
npm install
npm start
```

Health endpoint:

```text
GET /healthz
```

Search endpoint:

```text
GET /produtos/buscar?nome=leite+ninho+face+1
```