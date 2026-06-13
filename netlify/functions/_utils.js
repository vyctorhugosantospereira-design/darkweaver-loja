const fs = require('fs');
const path = require('path');
const https = require('https');
const { Rcon } = require('rcon-client');

const ROOT = process.cwd();
const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN || '';

const MINECRAFT = {
  host: process.env.MC_RCON_HOST || 'zoe.lura.pro',
  port: Number(process.env.MC_RCON_PORT || 35612),
  password: process.env.MC_RCON_PASSWORD || '',
};

const MC_KITS_FILE = path.join(ROOT, 'mc_kits.json');
const KIT_ORDERS_FILE = path.join('/tmp', 'mc_kit_orders_site.json');
const deliveredCache = new Set();

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: JSON.stringify(data),
  };
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (_) {}
}
function loadAllKits() {
  const raw = loadJSON(MC_KITS_FILE, []);
  if (Array.isArray(raw)) return raw;
  const kits = [];
  for (const arr of Object.values(raw)) if (Array.isArray(arr)) kits.push(...arr);
  return kits;
}
function safeNick(nick) {
  return String(nick || '').trim().replace(/^\.+/, '').slice(0, 32);
}
function validateNick(nick) {
  // Java: letras/números/_ até 16. Bedrock via Geyser pode ter ponto inicial; aceitamos . no início.
  return /^\.?[a-zA-Z0-9_]{3,16}$/.test(nick);
}

function mpRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    if (!MP_ACCESS_TOKEN) return reject(new Error('Configure MERCADOPAGO_ACCESS_TOKEN nas variáveis ambientais do Netlify'));
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.mercadopago.com',
      path: endpoint,
      method,
      headers: {
        Authorization: 'Bearer ' + MP_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': Date.now() + '-' + Math.random().toString(36).slice(2),
      },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { return reject(new Error('Resposta inválida do Mercado Pago')); }
        if (res.statusCode >= 400) return reject(new Error(parsed.message || parsed.error || 'Erro Mercado Pago ' + res.statusCode));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout Mercado Pago')));
    if (data) req.write(data);
    req.end();
  });
}
async function criarPixKit(kit, nick) {
  const body = {
    transaction_amount: Number(Number(kit.price).toFixed(2)),
    description: `${kit.name} — DarkWeaver | Nick: ${nick}`.slice(0, 255),
    payment_method_id: 'pix',
    payer: { email: 'comprador@darkweaver.gg', first_name: nick, last_name: 'DarkWeaver' },
    external_reference: `darkweaver_site|${kit.id}|${nick}|${Date.now()}`,
    metadata: { nick, kitId: kit.id, kitName: kit.name, source: 'darkweaver_site' },
  };
  const res = await mpRequest('POST', '/v1/payments', body);
  const pix = res.point_of_interaction?.transaction_data || {};
  if (!res.id || !pix.qr_code) throw new Error('PIX não foi gerado pelo Mercado Pago');
  return {
    paymentId: String(res.id),
    pixCopyCola: pix.qr_code,
    qrCodeBase64: pix.qr_code_base64 ? 'data:image/png;base64,' + pix.qr_code_base64 : '',
    status: res.status,
  };
}
async function getPayment(paymentId) {
  return await mpRequest('GET', `/v1/payments/${encodeURIComponent(paymentId)}`, null);
}
async function consultarStatus(paymentId) {
  const res = await getPayment(paymentId);
  return { status: res.status, detail: res.status_detail, approved: res.status === 'approved' };
}
async function rconExec(command) {
  if (!MINECRAFT.password) throw new Error('Configure MC_RCON_PASSWORD nas variáveis ambientais do Netlify');
  const rcon = new Rcon({ host: MINECRAFT.host, port: MINECRAFT.port, password: MINECRAFT.password, timeout: 8000 });
  try {
    await rcon.connect();
    const response = await rcon.send(command);
    await rcon.end().catch(() => {});
    return response;
  } catch (e) {
    await rcon.end().catch(() => {});
    throw e;
  }
}
async function onlineCount() {
  const res = await rconExec('list');
  const m = String(res).match(/There are (\d+) of a max/i) || String(res).match(/Há (\d+) de/i);
  if (m) return Number(m[1]);
  const idx = String(res).lastIndexOf(':');
  if (idx === -1) return 0;
  const list = String(res).slice(idx + 1).split(',').map(s => s.trim()).filter(Boolean);
  return list.length;
}
async function deliverKit(kit, nick) {
  const results = [];
  const player = safeNick(nick);
  for (const raw of (kit.commands || [])) {
    const cmd = String(raw).replaceAll('{player}', player);
    if (!cmd.trim()) continue;
    const res = await rconExec(cmd);
    results.push({ cmd, response: res || 'ok' });
  }
  return results;
}

module.exports = { json, loadJSON, saveJSON, loadAllKits, criarPixKit, consultarStatus, KIT_ORDERS_FILE, getPayment, deliverKit, onlineCount, validateNick, safeNick, deliveredCache };
