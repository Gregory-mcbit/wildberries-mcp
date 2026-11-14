// Local mock of the Wildberries Seller API used by the integration tests.
// No real network access needed.

import http from 'node:http';

export function startMock() {
  const state = {
    rateLimitedCalls: 0,
    penaltyCalls: 0,
    requests: [],
    bigPayload: { items: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `товар-${i}`, price: i * 100 })) },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      state.requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization,
        body,
      });

      const json = (status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET' && url.pathname === '/ping') return json(200, { ok: true, ts: Date.now() });
      if (req.method === 'GET' && url.pathname === '/api/v1/warehouses') {
        return json(200, [{ id: 507, name: 'Коледино', address: 'Москва' }]);
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/acceptance/options') {
        return json(200, { ok: true, received: body ? JSON.parse(body) : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/account/balance') {
        return json(403, {
          title: 'Forbidden',
          detail: 'scope is not allowed for this resource',
          requestId: 'test-request-id',
          status: 403,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/documents/download') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
        return res.end('id;amount\n1;100\n2;200\n');
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/rate-limited') {
        state.rateLimitedCalls++;
        if (state.rateLimitedCalls === 1) {
          return json(
            429,
            { title: 'Too many requests', detail: 'retry later' },
            { 'x-ratelimit-retry': '0', 'x-ratelimit-reset': '1', 'x-ratelimit-limit': '5' },
          );
        }
        return json(200, { ok: true, afterRetry: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/penalty') {
        state.penaltyCalls++;
        if (state.penaltyCalls === 1) {
          return json(
            409,
            { title: 'Conflict', detail: 'penalty for burst' },
            { 'x-ratelimit-retry-after': '0', 'x-ratelimit-reset': '0' },
          );
        }
        return json(200, { ok: true, afterPenalty: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/big') {
        return json(200, state.bigPayload);
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/slow') {
        return setTimeout(() => json(200, { ok: true }), 50);
      }
      if (url.pathname === '/api/v1/echo') {
        return json(200, { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      }
      return json(404, { title: 'not found', detail: `no mock route for ${req.method} ${url.pathname}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
