'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toMinor, toMinorOrZero, fromMinor, sumMinor, MoneyError } = require('../src/money');

test('парсит строки экспорта', () => {
  assert.equal(toMinor('12345.67'), 1234567);
  assert.equal(toMinor('0.00'), 0);
  assert.equal(toMinor('1725'), 172500);
  assert.equal(toMinor('1725.5'), 172550);
  assert.equal(toMinor('1 725,00'), 172500);      // пробел-разделитель и запятая
  assert.equal(toMinor(25000), 2500000);
});

test('отказывается угадывать', () => {
  assert.throws(() => toMinor(''), MoneyError);
  assert.throws(() => toMinor(null), MoneyError);
  assert.throws(() => toMinor('0000-00-00'), MoneyError);
  assert.throws(() => toMinor('abc'), MoneyError);
  // третий знак после запятой — это не наша точность, молча округлять нельзя
  assert.throws(() => toMinor('10.005'), MoneyError);
  // а незначащие нули в третьем знаке допустимы
  assert.equal(toMinor('10.500'), 1050);
});

test('toMinorOrZero отличает «нет столбца» от «ноль»', () => {
  assert.equal(toMinorOrZero(undefined), 0);
  assert.equal(toMinorOrZero(''), 0);
  assert.equal(toMinorOrZero('0.00'), 0);
  assert.throws(() => toMinorOrZero('нет'), MoneyError);
});

test('round-trip не теряет копейки', () => {
  for (const value of ['0.00', '0.01', '12345.67', '765.43', '18000.00', '99999999.99']) {
    assert.equal(fromMinor(toMinor(value)), value);
  }
});

test('сумма считается целыми, без float-дрейфа', () => {
  // 0.1 + 0.2 в float даёт 0.30000000000000004
  const parts = ['0.10', '0.20'].map((v) => toMinor(v));
  assert.equal(fromMinor(sumMinor(parts)), '0.30');

  // реальный набор корзин
  const buckets = ['100.00', '100.00', '100.00', '100.00', '300.00', '400.00', '250.00', '75.50'];
  assert.equal(fromMinor(sumMinor(buckets.map((v) => toMinor(v)))), '1425.50');
});
