import { createReadStream, promises as fs } from 'node:fs';
import { watch } from 'node:fs';

const DEFAULT_STOP_WORDS = new Set([
  'a',
  'as',
  'o',
  'os',
  'um',
  'uma',
  'de',
  'da',
  'das',
  'do',
  'dos',
  'e',
  'em',
  'na',
  'nas',
  'no',
  'nos',
  'para',
  'por',
  'com',
  'sem',
  'ao',
  'aos',
  'ou',
  'tipo',
  'uso',
]);

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value, options = {}) {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const stopWords = options.stopWords ?? DEFAULT_STOP_WORDS;
  const minTokenLength = options.minTokenLength ?? 2;

  return normalized
    .split(' ')
    .filter(Boolean)
    .filter((token) => token.length >= minTokenLength)
    .filter((token) => !stopWords.has(token));
}

function unique(values) {
  return [...new Set(values)];
}

function soundex(value) {
  const normalized = normalizeText(value).replace(/[^a-z]/g, '');
  if (!normalized) return '';

  const first = normalized[0].toUpperCase();
  const map = {
    b: '1',
    f: '1',
    p: '1',
    v: '1',
    c: '2',
    g: '2',
    j: '2',
    k: '2',
    q: '2',
    s: '2',
    x: '2',
    z: '2',
    d: '3',
    t: '3',
    l: '4',
    m: '5',
    n: '5',
    r: '6',
  };

  let out = first;
  let previous = map[normalized[0]] ?? '';

  for (let index = 1; index < normalized.length && out.length < 4; index += 1) {
    const code = map[normalized[index]] ?? '';
    if (!code || code === previous) {
      previous = code;
      continue;
    }

    out += code;
    previous = code;
  }

  return out.padEnd(4, '0');
}

function boundedLevenshtein(left, right, maxDistance) {
  if (left === right) return 0;

  const leftLength = left.length;
  const rightLength = right.length;
  if (Math.abs(leftLength - rightLength) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: rightLength + 1 }, (_, index) => index);

  for (let row = 1; row <= leftLength; row += 1) {
    const current = [row];
    let rowMin = current[0];

    for (let column = 1; column <= rightLength; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitutionCost,
      );

      current[column] = value;
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }

  return previous[rightLength];
}

class BkNode {
  constructor(term) {
    this.term = term;
    this.children = new Map();
  }
}

class BkTree {
  constructor(distanceFn) {
    this.distanceFn = distanceFn;
    this.root = null;
  }

  add(term) {
    if (!term) return;

    if (!this.root) {
      this.root = new BkNode(term);
      return;
    }

    let node = this.root;
    while (node) {
      const distance = this.distanceFn(term, node.term, Number.MAX_SAFE_INTEGER);
      const child = node.children.get(distance);

      if (!child) {
        node.children.set(distance, new BkNode(term));
        return;
      }

      node = child;
    }
  }

  search(term, maxDistance) {
    if (!this.root) return [];

    const results = [];
    const stack = [this.root];

    while (stack.length > 0) {
      const node = stack.pop();
      const distance = this.distanceFn(term, node.term, maxDistance);
      if (distance <= maxDistance) results.push({ term: node.term, distance });

      const from = distance - maxDistance;
      const to = distance + maxDistance;
      for (const [edge, child] of node.children) {
        if (edge >= from && edge <= to) stack.push(child);
      }
    }

    return results;
  }
}

function createTrigrams(value) {
  const normalized = `  ${normalizeText(value)}  `;
  const grams = new Set();
  for (let index = 0; index < normalized.length - 2; index += 1) {
    grams.add(normalized.slice(index, index + 3));
  }
  return grams;
}

function diceCoefficient(left, right) {
  const leftGrams = createTrigrams(left);
  const rightGrams = createTrigrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;

  let shared = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1;
  }

  return (2 * shared) / (leftGrams.size + rightGrams.size);
}

function countOrderedPairs(tokens, normalizedTextValue) {
  if (tokens.length < 2) return 0;

  let score = 0;
  let cursor = 0;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const first = normalizedTextValue.indexOf(tokens[index], cursor);
    const second = normalizedTextValue.indexOf(tokens[index + 1], first + tokens[index].length);
    if (first >= 0 && second > first) {
      score += 1;
      cursor = first;
    }
  }
  return score;
}

async function detectDelimiter(filePath) {
  const handle = await fs.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/, 1)[0] ?? '';

    const commaCount = (sample.match(/,/g) ?? []).length;
    const semicolonCount = (sample.match(/;/g) ?? []).length;
    const tabCount = (sample.match(/\t/g) ?? []).length;

    if (tabCount > commaCount && tabCount > semicolonCount) return '\t';
    return semicolonCount > commaCount ? ';' : ',';
  } finally {
    await handle.close();
  }
}

async function* parseCsvFile(filePath, delimiter) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let field = '';
  let row = [];
  let insideQuotes = false;

  for await (const chunk of stream) {
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];
      const nextChar = chunk[index + 1];

      if (char === '"') {
        if (insideQuotes && nextChar === '"') {
          field += '"';
          index += 1;
        } else {
          insideQuotes = !insideQuotes;
        }
        continue;
      }

      if (!insideQuotes && char === delimiter) {
        row.push(field);
        field = '';
        continue;
      }

      if (!insideQuotes && (char === '\n' || char === '\r')) {
        if (char === '\r' && nextChar === '\n') index += 1;

        row.push(field);
        field = '';

        if (row.length > 1 || row[0] !== '') yield row;
        row = [];
        continue;
      }

      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') yield row;
  }
}

async function loadCsvRows(filePath) {
  const delimiter = await detectDelimiter(filePath);
  const rows = [];
  let headers = null;

  for await (const rawRow of parseCsvFile(filePath, delimiter)) {
    if (!headers) {
      headers = rawRow.map((value) => value.trim());
      continue;
    }

    const record = {};
    for (let index = 0; index < headers.length; index += 1) {
      record[headers[index]] = rawRow[index] ?? '';
    }
    rows.push(record);
  }

  return rows;
}

export class ProductSearchIndex {
  constructor(config) {
    this.config = {
      idColumn: config.idColumn,
      nameColumn: config.nameColumn,
      extraSearchColumns: config.extraSearchColumns ?? [],
      minTokenLength: config.minTokenLength ?? 2,
      stopWords: config.stopWords ?? DEFAULT_STOP_WORDS,
      maxFuzzyResultsPerToken: config.maxFuzzyResultsPerToken ?? 8,
      maxCandidatesToRank: config.maxCandidatesToRank ?? 400,
    };

    this.products = [];
    this.postings = new Map();
    this.tokenDocumentFrequency = new Map();
    this.soundexIndex = new Map();
    this.tokenTree = new BkTree(boundedLevenshtein);
  }

  static fromRows(rows, config) {
    const index = new ProductSearchIndex(config);
    index.addRows(rows);
    return index;
  }

  static async fromCsvFile(filePath, config) {
    const rows = await loadCsvRows(filePath);
    return ProductSearchIndex.fromRows(rows, config);
  }

  addRows(rows) {
    for (const row of rows) this.addRow(row);
    return this;
  }

  addRow(row) {
    const id = String(row[this.config.idColumn] ?? '').trim();
    const name = String(row[this.config.nameColumn] ?? '').trim();
    if (!id || !name) return;

    const combinedText = [
      name,
      ...this.config.extraSearchColumns.map((column) => row[column] ?? ''),
    ].join(' ');

    const normalizedName = normalizeText(name);
    const tokens = unique(tokenize(combinedText, this.config));
    if (tokens.length === 0) return;

    const productIndex = this.products.length;
    this.products.push({
      id,
      row,
      name,
      normalizedName,
      combinedText: normalizeText(combinedText),
      tokens,
    });

    for (const token of tokens) {
      let productIds = this.postings.get(token);
      if (!productIds) {
        productIds = [];
        this.postings.set(token, productIds);
        this.tokenTree.add(token);

        const tokenSoundex = soundex(token);
        if (tokenSoundex) {
          const soundexTokens = this.soundexIndex.get(tokenSoundex) ?? [];
          soundexTokens.push(token);
          this.soundexIndex.set(tokenSoundex, soundexTokens);
        }
      }

      productIds.push(productIndex);
      this.tokenDocumentFrequency.set(token, (this.tokenDocumentFrequency.get(token) ?? 0) + 1);
    }
  }

  resolveSimilarTokens(token) {
    const maxDistance = token.length >= 8 ? 2 : 1;
    const candidates = new Map();

    for (const result of this.tokenTree.search(token, maxDistance)) {
      if (result.term === token) continue;
      candidates.set(result.term, result.distance);
    }

    const phoneticTokens = this.soundexIndex.get(soundex(token)) ?? [];
    for (const candidateToken of phoneticTokens) {
      if (candidateToken === token) continue;
      const distance = boundedLevenshtein(token, candidateToken, maxDistance + 1);
      if (distance <= maxDistance + 1) {
        const previous = candidates.get(candidateToken);
        if (previous == null || distance < previous) candidates.set(candidateToken, distance);
      }
    }

    return [...candidates.entries()]
      .sort((left, right) => {
        if (left[1] !== right[1]) return left[1] - right[1];

        const leftDf = this.tokenDocumentFrequency.get(left[0]) ?? Number.MAX_SAFE_INTEGER;
        const rightDf = this.tokenDocumentFrequency.get(right[0]) ?? Number.MAX_SAFE_INTEGER;
        if (leftDf !== rightDf) return leftDf - rightDf;

        return left[0].localeCompare(right[0]);
      })
      .slice(0, this.config.maxFuzzyResultsPerToken)
      .map(([term, distance]) => ({ term, distance }));
  }

  search(query, options = {}) {
    const limit = options.limit ?? 10;
    const normalizedQuery = normalizeText(query);
    let queryTokens = unique(tokenize(normalizedQuery, this.config));

    if (queryTokens.length === 0 && normalizedQuery) {
      queryTokens = normalizedQuery.split(' ').filter(Boolean);
    }

    if (queryTokens.length === 0) return [];

    const candidates = new Map();

    for (const queryToken of queryTokens) {
      const exactMatches = this.postings.get(queryToken) ?? [];

      for (const productIndex of exactMatches) {
        const state = candidates.get(productIndex) ?? {
          exactHits: 0,
          fuzzyHits: 0,
          matchedTokens: new Set(),
          fuzzyTerms: new Set(),
          preliminaryScore: 0,
        };

        state.exactHits += 1;
        state.matchedTokens.add(queryToken);
        state.preliminaryScore += 100;
        candidates.set(productIndex, state);
      }

      const fuzzyMatches = this.resolveSimilarTokens(queryToken);
      for (const fuzzyMatch of fuzzyMatches) {
        const productIndexes = this.postings.get(fuzzyMatch.term) ?? [];
        for (const productIndex of productIndexes) {
          const state = candidates.get(productIndex) ?? {
            exactHits: 0,
            fuzzyHits: 0,
            matchedTokens: new Set(),
            fuzzyTerms: new Set(),
            preliminaryScore: 0,
          };

          if (!state.fuzzyTerms.has(fuzzyMatch.term)) {
            state.fuzzyHits += 1;
            state.fuzzyTerms.add(fuzzyMatch.term);
            state.preliminaryScore += Math.max(25, 70 - fuzzyMatch.distance * 20);
            candidates.set(productIndex, state);
          }
        }
      }
    }

    if (candidates.size === 0) {
      return this.products
        .map((product) => ({
          product,
          score:
            diceCoefficient(normalizedQuery, product.combinedText) * 100 +
            (product.combinedText.includes(normalizedQuery) ? 25 : 0),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((entry, rank) => ({
          id: entry.product.id,
          name: entry.product.name,
          score: Number(entry.score.toFixed(4)),
          rank: rank + 1,
        }));
    }

    return [...candidates.entries()]
      .sort((left, right) => right[1].preliminaryScore - left[1].preliminaryScore)
      .slice(0, this.config.maxCandidatesToRank)
      .map(([productIndex, state]) => {
        const product = this.products[productIndex];
        const tokenCoverage = state.matchedTokens.size / queryTokens.length;
        const phraseBoost = product.combinedText.includes(normalizedQuery) ? 25 : 0;
        const orderedPairs = countOrderedPairs(queryTokens, product.combinedText);
        const diceScore = diceCoefficient(normalizedQuery, product.combinedText) * 100;
        const compactnessPenalty = Math.max(0, product.tokens.length - queryTokens.length) * 1.5;

        const score =
          state.exactHits * 120 +
          state.fuzzyHits * 50 +
          tokenCoverage * 90 +
          phraseBoost +
          orderedPairs * 12 +
          diceScore -
          compactnessPenalty;

        return {
          id: product.id,
          name: product.name,
          score: Number(score.toFixed(4)),
          rankDebug: {
            exactHits: state.exactHits,
            fuzzyHits: state.fuzzyHits,
            tokenCoverage: Number(tokenCoverage.toFixed(4)),
            diceScore: Number(diceScore.toFixed(4)),
          },
        };
      })
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.name.localeCompare(right.name);
      })
      .slice(0, limit)
      .map((entry, rank) => ({ ...entry, rank: rank + 1 }));
  }
}

export class LiveProductSearchService {
  constructor(options) {
    this.csvPath = options.csvPath;
    this.indexConfig = options.indexConfig;
    this.reloadDebounceMs = options.reloadDebounceMs ?? 750;
    this.logger = options.logger ?? console;
    this.index = null;
    this.watcher = null;
    this.reloadTimer = null;
    this.reloading = null;
    this.lastLoadedAt = null;
  }

  async start() {
    await this.reload();
    this.watch();
    return this;
  }

  watch() {
    if (this.watcher) return;

    this.watcher = watch(this.csvPath, () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.reload().catch((error) => {
          this.logger.error('[product-search] reload failed', error);
        });
      }, this.reloadDebounceMs);
    });
  }

  async reload() {
    if (!this.reloading) {
      this.reloading = ProductSearchIndex.fromCsvFile(this.csvPath, this.indexConfig)
        .then((index) => {
          this.index = index;
          this.lastLoadedAt = new Date();
          return index;
        })
        .finally(() => {
          this.reloading = null;
        });
    }

    return this.reloading;
  }

  search(query, options) {
    if (!this.index) throw new Error('search index is not loaded');
    return this.index.search(query, options);
  }

  getStats() {
    return {
      loaded: Boolean(this.index),
      products: this.index?.products.length ?? 0,
      uniqueTokens: this.index?.postings.size ?? 0,
      lastLoadedAt: this.lastLoadedAt?.toISOString() ?? null,
    };
  }

  async close() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    clearTimeout(this.reloadTimer);
  }
}

export async function loadProductRowsFromCsv(filePath) {
  return loadCsvRows(filePath);
}