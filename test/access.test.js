'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const access = require('../access');

test('can() matches every declared role and capability', () => {
  for (const role of access.ROLES) {
    for (const cap of Object.values(access.CAPS)) {
      assert.equal(access.can(role, cap), access.ROLE_CAPS[role].includes(cap), `${role}/${cap}`);
    }
  }
  assert.equal(access.can('unknown-role', 'users'), false);
  assert.equal(access.can('mail', 'writeoff'), false);
  assert.equal(access.can('cc', 'writeoff'), true);
  assert.equal(access.can('cc', 'pipeline'), false);
  assert.equal(access.can('admin', 'pipeline'), false);
});
