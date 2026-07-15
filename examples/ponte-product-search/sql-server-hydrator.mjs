function escapeIdentifier(identifier) {
  return `[${String(identifier).replace(/]/g, ']]')}]`;
}

function escapeIdentifierPath(identifierPath) {
  return String(identifierPath)
    .split('.')
    .map((part) => escapeIdentifier(part))
    .join('.');
}

export class SqlServerProductHydrator {
  constructor(options) {
    this.poolPromise = options.poolPromise;
    this.table = options.table;
    this.idColumn = options.idColumn;
    this.selectColumns = options.selectColumns ?? ['*'];
    this.whereClause = options.whereClause ?? '';
  }

  async hydrateByIds(ids) {
    const uniqueIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return [];

    const sql = await import('mssql');
    const pool = await this.poolPromise;
    const request = pool.request();

    const parameterNames = uniqueIds.map((id, index) => {
      const name = `id${index}`;
      request.input(name, sql.NVarChar, id);
      return `@${name}`;
    });

    const selectClause =
      this.selectColumns.length === 1 && this.selectColumns[0] === '*'
        ? '*'
        : this.selectColumns.map((column) => escapeIdentifierPath(column)).join(', ');

    const sqlText = [
      `SELECT ${selectClause}`,
      `FROM ${escapeIdentifierPath(this.table)}`,
      `WHERE ${escapeIdentifier(this.idColumn)} IN (${parameterNames.join(', ')})`,
      this.whereClause ? `  AND (${this.whereClause})` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await request.query(sqlText);
    return result.recordset ?? [];
  }
}

export async function createSqlServerPool(config) {
  const sql = await import('mssql');
  const pool = new sql.ConnectionPool(config);
  return pool.connect();
}