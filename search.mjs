// Shared text utilities for the WB API catalog search.
//
// WB method summaries use their own vocabulary ("сборочные задания", "кампании",
// "продвижение"), while users ask in plain Russian ("заказы", "реклама").
// To make wb_search useful we:
//   * stem Russian words (drop common endings) so "заказы" matches "заказ",
//   * expand known synonyms into the vocabulary WB actually uses,
//   * extract compact keyword lists for the catalog index.

const STOPWORDS = new Set([
  'для', 'или', 'все', 'всех', 'как', 'при', 'что', 'это', 'его', 'если', 'также', 'только',
  'может', 'нужно', 'быть', 'есть', 'нет', 'без', 'через', 'после', 'перед', 'между', 'более',
  'менее', 'этот', 'эта', 'эти', 'того', 'чем', 'где', 'когда', 'который', 'которая', 'которые',
  'данные', 'метод', 'методы', 'запрос', 'запроса', 'ответ', 'ответа', 'получить', 'список',
  'так', 'если', 'уже', 'либо', 'иначе', 'также', 'пример', 'примеры', 'описание', 'значение',
  'значения', 'параметр', 'параметры', 'поле', 'поля', 'объект', 'массив', 'строк', 'строка',
  'число', 'числа', 'тип', 'типа', 'формат', 'обязательный', 'необязательный', 'максимум',
  'минимум', 'wildberries', 'wb', 'api', 'http', 'https', 'htm', 'html', 'json', 'который',
  'котором', 'которой', 'будет', 'будут', 'можно', 'нужен', 'нужна', 'нужны', 'этом', 'этого',
]);

const ENDINGS = [
  'иями', 'ями', 'ами', 'ов', 'ев', 'ах', 'ях', 'ам', 'ям', 'ой', 'ей', 'ых', 'их', 'ые', 'ие',
  'ая', 'яя', 'ое', 'ее', 'ый', 'ий', 'ия', 'ии', 'у', 'ю', 'ы', 'и', 'а', 'я', 'е', 'о', 'ь',
];

export function stem(word) {
  let w = String(word).toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
  if (w.length <= 4) return w;
  for (const ending of ENDINGS) {
    if (w.endsWith(ending) && w.length - ending.length >= 4) {
      w = w.slice(0, -ending.length);
      break;
    }
  }
  return w;
}

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((token) => token.length >= 2);
}

export function meaningfulTokens(text) {
  const out = [];
  for (const raw of tokenize(text)) {
    if (STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    out.push(s);
  }
  return out;
}

// Query-level synonym expansion: maps what a human says to what WB specs say.
const SYNONYMS = [
  [/^(реклам|продвижен|кампани|advert|promotion)/, ['реклам', 'продвижен', 'кампани', 'advert', 'promotion', 'медиа']],
  [/^(финанс|finance)/, ['финанс', 'баланс', 'документ', 'finance', 'balance', 'начислен', 'удержан']],
  [/^(отзыв|feedback|вопрос)/, ['отзыв', 'feedback', 'вопрос', 'оценк', 'комментар']],
  [/^(заказ|order|сборочн|assembly)/, ['заказ', 'сборочн', 'orders', 'assembly', 'fbs', 'dbs', 'dbw', 'поставк']],
  [/^(поставк|supplies|fbw)/, ['поставк', 'supplies', 'приёмк', 'приемк', 'fbw', 'склад']],
  [/^(карточк|товар|item|card|номенклат)/, ['карточк', 'товар', 'items', 'cards', 'номенклат', 'контент', 'характеристик']],
  [/^(остатк|склад|stock|inventory)/, ['остатк', 'склад', 'stocks', 'inventory', 'warehouse', 'запас']],
  [/^(цен|price|стоим|discount|скидк)/, ['цен', 'price', 'discount', 'скидк', 'стоим']],
  [/^(отч[её]т|report|статистик)/, ['отчёт', 'отчет', 'report', 'статистик', 'аналитик']],
  [/^(аналитик|analytics)/, ['аналитик', 'analytics', 'воронк', 'статистик', 'отчёт', 'отчет']],
  [/^(возврат|return)/, ['возврат', 'return', 'возмещен']],
  [/^(чат|chat|сообщен)/, ['чат', 'chat', 'сообщен', 'диалог']],
  [/^(документ|document)/, ['документ', 'document', 'акт', 'упд', 'счёт', 'счет']],
  [/^(пользов|user)/, ['пользов', 'user', 'сотрудник', 'доступ']],
  [/^(банк|balance)/, ['баланс', 'balance', 'счёт', 'счет', 'выплат']],
  [/^(тариф|rate|комисси)/, ['тариф', 'rate', 'комисси', 'стоимост', 'возврат']],
];

// Returns a Set of stemmed tokens: the original ones plus synonyms.
export function expandQueryTokens(query) {
  const base = meaningfulTokens(query);
  const out = new Set(base);
  for (const token of base) {
    for (const [pattern, extras] of SYNONYMS) {
      if (pattern.test(token)) {
        for (const extra of extras) out.add(extra);
        break;
      }
    }
  }
  return { base, expanded: out };
}

// Compact keyword list stored in catalog/index.json for every operation.
export function extractKeywords({ summary, description, tags, tagKey, path, id, params }) {
  const chunks = [summary, description, (tags ?? []).join(' '), tagKey, path, id];
  for (const p of params ?? []) chunks.push(`${p.name} ${p.description ?? ''}`);
  const seen = new Set();
  const keywords = [];
  for (const token of meaningfulTokens(chunks.filter(Boolean).join(' '))) {
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= 48) break;
  }
  return keywords;
}
