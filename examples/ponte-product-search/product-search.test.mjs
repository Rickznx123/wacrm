import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductSearchIndex, normalizeText, tokenize } from './product-search.mjs';

const rows = [
  { id: '1', nome: 'Leite Ninho Fase 1 Lata 400g' },
  { id: '2', nome: 'Algy-Flanderil Ibuprofeno 600mg 20 Comprimidos' },
  { id: '3', nome: 'Dipirona Sodica Medley 1g 10 Comprimidos' },
  { id: '4', nome: 'Dipirona Monoidratada Generica 500mg' },
];

function createIndex() {
  return ProductSearchIndex.fromRows(rows, {
    idColumn: 'id',
    nameColumn: 'nome',
  });
}

test('normalizeText removes accents, punctuation and casing differences', () => {
  assert.equal(normalizeText('Cápsula, Açúcar!'), 'capsula acucar');
});

test('tokenize drops stop words and preserves meaningful terms', () => {
  assert.deepEqual(tokenize('Dipirona de medley para dor'), ['dipirona', 'medley', 'dor']);
});

test('search matches word order variations', () => {
  const index = createIndex();
  const [best] = index.search('medley dipirona', { limit: 3 });

  assert.equal(best.id, '3');
});

test('search tolerates accent and punctuation noise', () => {
  const index = createIndex();
  const [best] = index.search('dipirona medley!!!', { limit: 3 });

  assert.equal(best.id, '3');
});

test('search tolerates typo in fase', () => {
  const index = createIndex();
  const [best] = index.search('leite ninho face 1', { limit: 3 });

  assert.equal(best.id, '1');
});

test('search tolerates multi-token noisy typo queries', () => {
  const index = createIndex();
  const [best] = index.search('algy flanderi ibuprofeno', { limit: 3 });

  assert.equal(best.id, '2');
});