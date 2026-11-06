'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize, pick, hasColumn, ExportError } = require('../src/exportReader');
const { assocEnvelope, positionalEnvelope } = require('./fixtures');

test('assoc and positional formats produce identical rows', () => {
  const overrides = [{ l_amount: '21450.75' }];
  const fromAssoc = normalize(assocEnvelope(overrides).data);
  const fromPositional = normalize(positionalEnvelope(overrides).data);

  assert.equal(fromAssoc.length, 1);
  assert.equal(fromPositional.length, 1);
  assert.equal(pick(fromAssoc[0], 'l_amount'), '21450.75');
  assert.equal(pick(fromPositional[0], 'l_amount'), '21450.75');
  assert.equal(pick(fromAssoc[0], 'debt'), pick(fromPositional[0], 'debt'));
});

test('positional format fails when row length differs from names', () => {
  const payload = positionalEnvelope([{}]).data;
  payload.data[0].pop();                        // one column is missing

  assert.throws(() => normalize(payload), (err) => {
    assert.ok(err instanceof ExportError);
    assert.match(err.message, /values but .* names/);
    return true;
  });
});

test('an empty response is an empty array, not an error', () => {
  const payload = assocEnvelope([]).data;
  assert.deepEqual(normalize(payload), []);
});

test('a response without names is rejected', () => {
  assert.throws(() => normalize({ data: [] }), ExportError);
  assert.throws(() => normalize({ names: {} }), ExportError);
});

test('column resolves with an index suffix', () => {
  const row = { debt_21: '100.00', l_tax8_44: '2000.00' };
  assert.equal(pick(row, 'debt'), '100.00');
  assert.equal(pick(row, 'l_tax8'), '2000.00');
  assert.equal(hasColumn(row, 'debt'), true);
  assert.equal(hasColumn(row, 'l_tax9'), false);
  assert.equal(pick(row, 'l_tax9'), undefined);
});

test('tax1 is not confused with tax10..tax12', () => {
  const row = { tax1_33: '1.00', tax10_42: '10.00', tax11_43: '11.00', tax12_44: '12.00' };
  assert.equal(pick(row, 'tax1'), '1.00');
  assert.equal(pick(row, 'tax10'), '10.00');
  assert.equal(pick(row, 'tax11'), '11.00');
  assert.equal(pick(row, 'tax12'), '12.00');
});

test('l_tax1 does not match the value of l_tax12', () => {
  const row = { l_tax1_35: '1.00', l_tax12_46: '12.00' };
  assert.equal(pick(row, 'l_tax1'), '1.00');
  assert.equal(pick(row, 'l_tax12'), '12.00');
});

test('an ambiguous column is an error, not the first match', () => {
  const row = { debt_21: '100.00', debt_99: '200.00' };
  assert.throws(() => pick(row, 'debt'), (err) => {
    assert.ok(err instanceof ExportError);
    assert.match(err.message, /ambiguously/);
    return true;
  });
});
