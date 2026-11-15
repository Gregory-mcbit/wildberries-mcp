// Wildberries API token helpers, shared by the MCP server, the installer and
// doctor. No network: everything is decoded locally from the JWT.

import { loadTokenFromFile } from './tokenstore.mjs';

export function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const TOKEN_CATEGORIES = [
  [1, 'Контент'],
  [2, 'Аналитика'],
  [3, 'Цены и скидки'],
  [4, 'Маркетплейс'],
  [5, 'Статистика'],
  [6, 'Продвижение'],
  [7, 'Вопросы и отзывы'],
  [9, 'Чат с покупателями'],
  [10, 'Поставки'],
  [11, 'Возвраты покупателями'],
  [12, 'Документы'],
  [13, 'Финансы'],
  [16, 'Пользователи'],
];

const TOKEN_TYPES = { 1: 'базовый', 2: 'тестовый', 3: 'персональный', 4: 'сервисный' };

export function describeToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return { valid: false, reason: 'не JWT или повреждён' };
  const s = Number(payload.s ?? 0);
  const categories = TOKEN_CATEGORIES.filter(([bit]) => (s & (1 << bit)) !== 0).map(([, name]) => name);
  const readOnly = (s & (1 << 30)) !== 0;
  const exp = Number(payload.exp ?? 0);
  const expDate = exp ? new Date(exp * 1000) : null;
  return {
    valid: !exp || expDate > new Date(),
    type: TOKEN_TYPES[Number(payload.acc)] ?? `acc=${payload.acc}`,
    sellerId: payload.sid,
    readOnly,
    categories,
    expiresAt: expDate ? expDate.toISOString() : undefined,
    expiresInDays: expDate ? Math.floor((expDate - Date.now()) / 86_400_000) : undefined,
    testToken: Number(payload.acc) === 2,
  };
}

// Reads accounts from env. WB_TOKEN_FILE points to an encrypted token written by
// install.mjs (AES-256-GCM), so the token never has to live in client configs.
export function loadTokenAccounts(env = process.env) {
  const accounts = new Map();
  const errors = [];
  const single = env.WB_API_TOKEN;
  if (single && single.trim() && !single.includes('<')) accounts.set('default', single.trim());
  if (env.WB_TOKEN_FILE) {
    try {
      accounts.set('default', loadTokenFromFile(env.WB_TOKEN_FILE, { keyFile: env.WB_TOKEN_KEY }));
    } catch (err) {
      errors.push(`WB_TOKEN_FILE (${env.WB_TOKEN_FILE}): ${err.message}`);
    }
  }
  if (env.WB_TOKEN_KEY && !env.WB_TOKEN_FILE) {
    errors.push('WB_TOKEN_KEY задан без WB_TOKEN_FILE — игнорирую');
  }
  if (env.WB_TOKEN_FILES) {
    try {
      const map = JSON.parse(env.WB_TOKEN_FILES);
      for (const [name, spec] of Object.entries(map)) {
        const file = typeof spec === 'string' ? spec : spec?.file;
        if (!file) {
          errors.push(`WB_TOKEN_FILES: у аккаунта "${name}" нет file`);
          continue;
        }
        const keyFile = typeof spec === 'string' ? `${file}.key` : (spec.key ?? `${file}.key`);
        try {
          accounts.set(name, loadTokenFromFile(file, { keyFile }));
        } catch (err) {
          errors.push(`WB_TOKEN_FILES (${name}): ${err.message}`);
        }
      }
    } catch {
      errors.push('WB_TOKEN_FILES не является валидным JSON — игнорирую');
    }
  }
  const raw = env.WB_ACCOUNTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.name && item.token) accounts.set(String(item.name), String(item.token));
        }
      } else if (parsed && typeof parsed === 'object') {
        for (const [name, token] of Object.entries(parsed)) {
          if (typeof token === 'string') accounts.set(name, token);
        }
      }
    } catch {
      errors.push('WB_ACCOUNTS не является валидным JSON — игнорирую');
    }
  }
  return { accounts, errors };
}

export function loadAccounts(env = process.env) {
  return loadTokenAccounts(env).accounts;
}
