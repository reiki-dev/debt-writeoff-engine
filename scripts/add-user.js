#!/usr/bin/env node
/**
 * Add a new user to users.json
 * Usage: node scripts/add-user.js
 *   or:  npm run add-user
 */

const bcrypt   = require('bcryptjs');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const access = require('../access');

const USERS_FILE = path.join(__dirname, '..', 'users.json');
const DEMO_USERS_FILE = path.join(__dirname, '..', 'users.demo.json');

const ROLE_HELP = {
  admin: 'vše — přehled, odpis, kalendář, správa uživatelů',
  cc:    'odpis dluhu a splátkový kalendář (bez přehledu půjček)',
  mail:  'pouze čtení — přehled půjček',
};

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
  if (!fs.existsSync(USERS_FILE) && fs.existsSync(DEMO_USERS_FILE)) {
    fs.copyFileSync(DEMO_USERS_FILE, USERS_FILE);
    console.log(`Demo users created at ${USERS_FILE}`);
  }

  console.log('\n── Správa uživatelů — Portfolio Suite ──\n');

  const username = (await ask('Uživatelské jméno : ')).trim();
  const password = (await ask('Heslo             : ')).trim();

  if (!username || !password) {
    console.error('\n❌  Uživatelské jméno a heslo nesmí být prázdné.\n');
    process.exit(1);
  }

  console.log('\nRole:');
  for (const role of access.ROLES) {
    console.log(`  ${role.padEnd(6)} — ${ROLE_HELP[role] || ''}`);
  }
  const roleInput = (await ask(`\nRole [${access.DEFAULT_ROLE}] : `)).trim().toLowerCase();

  // Ask for the role explicitly; a typo must not silently grant write-off
  // permissions. An empty response selects the least privileged role.
  const role = roleInput === '' ? access.DEFAULT_ROLE : roleInput;
  if (!access.ROLES.includes(role)) {
    console.error(`\n❌  Neznámá role "${role}". Povolené: ${access.ROLES.join(', ')}.\n`);
    process.exit(1);
  }

  const users = fs.existsSync(USERS_FILE)
    ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'))
    : [];

  if (users.find(u => u.username === username)) {
    console.error(`\n❌  Uživatel "${username}" již existuje.\n`);
    process.exit(1);
  }

  if (users.length >= 10) {
    console.warn('\n⚠️  Dosažen limit 10 uživatelů. Pro více zvažte přechod na databázi.\n');
  }

  const hash = await bcrypt.hash(password, 12);
  users.push({
    id:        Date.now().toString(),
    username,
    password:  hash,
    role,
    createdAt: new Date().toISOString(),
  });

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + '\n');
  console.log(`\n✅  Uživatel "${username}" (${role}) byl přidán. (Celkem: ${users.length})\n`);
  rl.close();
}

main().catch(err => {
  console.error('Chyba:', err.message);
  process.exit(1);
});
