'use strict';

// ----------------------------------------------------------------------------
// Мост между настройками portfolio-сайта и модулем отписа.
//
// Зачем отдельный файл, а не пара строк в server.js: модуль читает окружение
// в момент require (см. writeoff/src/config.js), поэтому переменные должны быть
// выведены ДО того, как он подключится. Отдельный модуль делает этот порядок
// невозможным нарушить — как бы ни переставляли require в server.js.
//
// Новых секретов не вводим. Ключ и домен берутся из того, что у сайта уже есть:
//   API_KEY      -> CRM_API_KEY
//   API_BASE_URL -> CRM_BASE_URL, но только origin: у сайта в этой
//                   переменной лежит полный путь до export/export, а модуль
//                   добавляет пути сам (/api/v1.0/export/export и
//                   /api/v1.0/special/writeoff). Если передать полный URL,
//                   получится .../export/export/api/v1.0/special/writeoff.
//
// Второй копии ключа в .env быть не должно: одна переменная — одно место,
// где её нужно менять при ротации.
// ----------------------------------------------------------------------------

const path = require('node:path');

// Загружаем .env сами. server.js делает это первой строкой, но мост может
// понадобиться и служебному скрипту — а без .env он бы вывел настройки
// из пустого окружения и молча пошёл на дефолтный домен без ключа.
// Повторный вызов безопасен: dotenv не перезаписывает уже заданные переменные.
// server.js loads dotenv only when it is launched as the application entry point.

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

if (!process.env.CRM_API_KEY && process.env.API_KEY) {
  process.env.CRM_API_KEY = process.env.API_KEY;
}

if (!process.env.CRM_BASE_URL) {
  const derived = originOf(process.env.API_BASE_URL || '');
  if (derived) {
    // Схему поднимаем до https и НИКОГДА не наследуем http.
    //
    // Дашборд исторически читает экспорты по http, и для чтения это работает.
    // Метод записи по plaintext CRM не отдаёт: POST /api/v1.0/special/writeoff
    // по http отвечает 500 MethodAccessDenied, причём с именем метода
    // getWriteoff вместо postWriteoff — то есть запрос даже не доходит до
    // нужного обработчика. Те же проводки по https проходят (writeoffId
    // Подтверждено двумя тестовыми проводками на staging.
    //
    // Отдельно: API-ключ не должен ходить в открытом виде на запросе,
    // который двигает деньги.
    const secure = derived.replace(/^http:\/\//i, 'https://');
    if (secure !== derived) {
      console.warn(`[writeoff] API_BASE_URL задан по http — для отписа используется ${secure}`);
    }
    process.env.CRM_BASE_URL = secure;
  }
  // если не вывелось — у модуля свой дефолт на тот же домен по https
} else if (/^http:\/\//i.test(process.env.CRM_BASE_URL)) {
  console.warn('[writeoff] CRM_BASE_URL задан по http — метод записи по plaintext CRM,'
    + ' скорее всего, отклонит (MethodAccessDenied)');
}

// Аудит-лог. В контейнере это /app/audit и он ОБЯЗАН быть томом:
// в нём живёт идемпотентность и записи о незакрытых попытках, и без тома
// они исчезают при первой пересборке образа. См. docker-compose.yml.
if (!process.env.CRM_AUDIT_DIR) {
  process.env.CRM_AUDIT_DIR = path.join(__dirname, 'audit');
}

const writeoff = require('./writeoff');
const mockCrm = require('./mock-crm');

if (mockCrm.isMockMode()) {
  console.log('[writeoff] Mock mode enabled: using synthetic fixtures for debt write-off.');
  const { ORDER, SOURCE_COLUMN, PAYLOAD_FIELD } = writeoff.buckets;
  const { toMinor, fromMinor } = writeoff.money;
  const balances = new Map();

  async function mockFetch(url, init = {}) {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/special/writeoff')) {
      const payload = init.body ? JSON.parse(init.body) : Object.fromEntries(new URL(url).searchParams);
      const id = `${payload.customerId}:${payload.creditId}`;
      const rows = mockCrm.getMockCreditRows({ customerId: payload.customerId, creditId: payload.creditId });
      const base = balances.get(id) || rows[0];
      const updated = { ...base };
      for (const bucket of ORDER) {
        const field = PAYLOAD_FIELD[bucket];
        if (payload[field] === undefined) continue;
        const column = SOURCE_COLUMN[bucket];
        updated[column] = fromMinor(toMinor(updated[column] || 0) - toMinor(payload[field]));
      }
      const newDebt = toMinor(updated.debt) - ORDER.reduce((sum, bucket) => {
        const field = PAYLOAD_FIELD[bucket];
        return sum + (payload[field] === undefined ? 0 : toMinor(payload[field]));
      }, 0);
      updated.debt = fromMinor(newDebt);
      balances.set(id, updated);
      return new Response(JSON.stringify({ status: 200, data: { status: 'success', writeoffId: `MOCK-${Date.now()}` } }));
    }
    const params = new URL(url).searchParams;
    const filters = JSON.parse(params.get('filter') || '[]');
    const customerId = filters.find((f) => f.name === 'customers.customer_id')?.value || '1001';
    const creditId = filters.find((f) => f.name === 'credits.id')?.value;
    const rows = mockCrm.getMockCreditRows({ customerId, creditId }).map((row) => {
      return balances.has(`${customerId}:${row.id}`) ? { ...balances.get(`${customerId}:${row.id}`) } : row;
    });
    return new Response(JSON.stringify({ status: 200, data: { names: {}, data: rows } }));
  }

  module.exports = {
    ...writeoff,
    fetchCreditRows: async ({ customerId, creditId }) => ({
      rows: mockCrm.getMockCreditRows({ customerId, creditId }).map((row) => {
        return balances.has(`${customerId}:${row.id}`) ? { ...balances.get(`${customerId}:${row.id}`) } : row;
      }),
    }),
    buildPlan: (options) => writeoff.buildPlan({ ...options, fetchImpl: mockFetch }),
    applyPlan: (plan, options) => writeoff.applyPlan(plan, { ...options, fetchImpl: mockFetch }),
  };
} else {
  module.exports = writeoff;
}

