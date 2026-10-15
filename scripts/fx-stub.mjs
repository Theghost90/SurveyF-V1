// A stand-in for the exchange-rate source, for local demos and the browser tests (no internet needed).
// Serves the same JSON shape as ExchangeRate-API's open endpoint with FIXED rates (1 XAF = 2.4 NGN, 0.2 KES, 0.018 GHS, …).
// Usage:  node scripts/fx-stub.mjs [port]   then start the API with   FX_API_URL=http://127.0.0.1:4299/v6/latest/XAF
// Change a rate while it runs:  curl -X POST 'http://127.0.0.1:4299/set?NGN=3'
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4299);
const rates = { NGN: 2.4, KES: 0.2, GHS: 0.018, USD: 1 / 580, GBP: 1 / 770, ZAR: 0.03, UGX: 6.4 };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/set') {
    for (const [k, v] of url.searchParams) if (k in rates && Number(v) > 0) rates[k] = Number(v);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rates));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: 'success', base_code: 'XAF', time_last_update_unix: Math.floor(Date.now() / 1000), rates }));
}).listen(port, '127.0.0.1', () => console.log(`fx stub on http://127.0.0.1:${port}/v6/latest/XAF`));
