/**
 * DarkWeaver VIP Store — Backend
 * 
 * Roda na mesma máquina que o bot Discord.
 * Lê mc_vip_shop.json do bot e processa pagamentos PIX via Mercado Pago.
 * 
 * Instalar: npm install express cors node-rcon
 * Rodar:    node server.js
 * Porta:    3001
 */

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const { execSync } = require('child_process');

// ─── AUTO-INSTALL ──────────────────────────────────────────────────────────
['express','cors'].forEach(pkg => {
  try { require(pkg); } catch(e) {
    console.log('[INSTALL] Instalando ' + pkg + '...');
    execSync('npm install ' + pkg, { stdio: 'inherit', cwd: __dirname });
  }
});

// ─── CONFIG — EDITE AQUI ───────────────────────────────────────────────────
const CONFIG = {
  PORT: 3001,

  // Seu token do Mercado Pago (mesmo que está no bot)
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN || 'SEU_TOKEN_MERCADO_PAGO_AQUI',

  // Caminho para os arquivos JSON do bot
  // Ajuste para o caminho real onde o bot está instalado
  BOT_DIR: process.env.BOT_DIR || __dirname, // no Netlify usa a raiz do projeto

  // IP do servidor Minecraft (para mostrar no painel)
  SERVER_IP:   'zoe.lura.pro',
  SERVER_PORT: 25580, // porta de query (não a de jogo)
  GAME_PORT:   35580,

  // RCON para aplicar VIP automaticamente
  RCON_HOST:     'zoe.lura.pro',
  RCON_PORT:     35612,
  RCON_PASSWORD: process.env.RCON_PASSWORD || 'SUA_SENHA_RCON_AQUI',

  // Integração com o bot Discord (bot precisa estar online e com porta 3000 liberada)
  BOT_WEBHOOK_URL: process.env.BOT_WEBHOOK_URL || '',
  BOT_WEBHOOK_SECRET: process.env.BOT_WEBHOOK_SECRET || 'darkweaver-site-secret',
};

// ─── ARQUIVOS DO BOT ───────────────────────────────────────────────────────
const VIP_SHOP_FILE   = path.join(CONFIG.BOT_DIR, 'mc_vip_shop.json');
const VIP_FILE        = path.join(CONFIG.BOT_DIR, 'mc_vips.json');
const VIP_ORDERS_FILE = path.join(CONFIG.BOT_DIR, 'mc_vip_orders.json');
const VIP_PENDING_FILE = path.join(CONFIG.BOT_DIR, 'mc_vip_pending.json');

const MC_KITS_FILE        = path.join(CONFIG.BOT_DIR, 'mc_kits.json');
const KIT_ORDERS_FILE     = path.join(CONFIG.BOT_DIR, 'mc_kit_orders_site.json');
const KIT_PENDING_FILE    = path.join(CONFIG.BOT_DIR, 'mc_kit_pending_site.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch(e) { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ─── MERCADO PAGO ─────────────────────────────────────────────────────────
function mpRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.mercadopago.com',
      path:     endpoint,
      method,
      headers: {
        'Authorization': 'Bearer ' + CONFIG.MP_ACCESS_TOKEN,
        'Content-Type':  'application/json',
        'X-Idempotency-Key': Date.now() + '-' + Math.random(),
      },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Resposta inválida do MP: ' + raw.slice(0,100))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function criarPix(vip, nick, discord) {
  const externalRef = `site_vip_${vip.id}_${nick}_${Date.now()}`;
  const body = {
    transaction_amount: Number(Number(vip.price).toFixed(2)),
    description: `VIP ${vip.name} — DarkWeaver | Nick: ${nick}`,
    payment_method_id: 'pix',
    payer: {
      email: 'comprador@darkweaver.gg',
      first_name: nick,
      last_name: 'DarkWeaver',
      identification: { type: 'CPF', number: '00000000000' },
    },
    external_reference: externalRef,
    metadata: { nick, discord: discord || '', vipId: vip.id, vipName: vip.name, source: 'site' },
  };
  const res = await mpRequest('POST', '/v1/payments', body);
  if (!res.id) throw new Error(res.message || 'Falha ao criar pagamento');
  return {
    paymentId:    String(res.id),
    externalRef,
    pixCopyCola:  res.point_of_interaction?.transaction_data?.qr_code        || '',
    qrCodeBase64: res.point_of_interaction?.transaction_data?.qr_code_base64
      ? 'data:image/png;base64,' + res.point_of_interaction.transaction_data.qr_code_base64
      : '',
    status:       res.status,
  };
}

async function consultarStatus(paymentId) {
  const res = await mpRequest('GET', `/v1/payments/${paymentId}`, null);
  return { status: res.status, detail: res.status_detail };
}

// ─── RCON ─────────────────────────────────────────────────────────────────
async function rconExec(cmd) {
  return new Promise((resolve) => {
    try {
      const net = require('net');
      const sock = net.createConnection(CONFIG.RCON_PORT, CONFIG.RCON_HOST);
      let buf = Buffer.alloc(0);
      let authed = false;

      const send = (type, id, body) => {
        const len = Buffer.byteLength(body, 'utf8');
        const pkt = Buffer.alloc(14 + len);
        pkt.writeInt32LE(10 + len, 0);
        pkt.writeInt32LE(id, 4);
        pkt.writeInt32LE(type, 8);
        pkt.write(body, 12, 'utf8');
        pkt.writeUInt8(0, 12 + len);
        pkt.writeUInt8(0, 13 + len);
        sock.write(pkt);
      };

      sock.setTimeout(5000);
      sock.on('connect', () => send(3, 1, CONFIG.RCON_PASSWORD));
      sock.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (!authed && buf.length >= 14) {
          authed = true;
          buf = Buffer.alloc(0);
          send(2, 2, cmd);
        } else if (authed && buf.length >= 14) {
          const bodyLen = buf.readInt32LE(0) - 10;
          if (bodyLen > 0) resolve(buf.slice(12, 12 + bodyLen).toString('utf8'));
          else resolve('');
          sock.destroy();
        }
      });
      sock.on('error', () => resolve(null));
      sock.on('timeout', () => { sock.destroy(); resolve(null); });
    } catch(e) { resolve(null); }
  });
}

async function aplicarVip(nick, vip) {
  await rconExec(`lp user ${nick} parent add ${vip.lpGroup}`);
  console.log(`[VIP] ✅ Aplicado: ${nick} → ${vip.lpGroup}`);
}

async function removerVip(nick, vip) {
  await rconExec(`lp user ${nick} parent remove ${vip.lpGroup}`);
  console.log(`[VIP] ⏳ Removido após expirar: ${nick} → ${vip.lpGroup}`);
}

function addPendingVip(order, vip) {
  const pending = loadJSON(VIP_PENDING_FILE, {});
  const key = String(order.nick).toLowerCase();
  if (!pending[key]) pending[key] = [];
  const exists = pending[key].some(x => String(x.paymentId) === String(order.paymentId));
  if (!exists) {
    pending[key].push({
      paymentId: String(order.paymentId),
      vipId: order.vipId || vip.id,
      vipName: vip.name,
      nick: order.nick,
      discord: order.discord || null,
      price: order.price || vip.price || 0,
      lpGroup: vip.lpGroup,
      dias: vip.dias || 30,
      createdAt: Date.now(),
      status: 'pending_offline'
    });
    saveJSON(VIP_PENDING_FILE, pending);
  }
}

async function deliverVipWhenOnline(order, vip) {
  const online = await isPlayerOnline(order.nick);
  if (!online) {
    addPendingVip(order, vip);
    console.log(`[VIP] ⏳ ${order.nick} offline — VIP salvo como pendente: ${vip.name}`);
    return { delivered: false, pending: true, reason: 'player_offline' };
  }

  await aplicarVip(order.nick, vip);
  return { delivered: true, pending: false };
}

async function processPendingVips() {
  const pending = loadJSON(VIP_PENDING_FILE, {});
  const shop = loadJSON(VIP_SHOP_FILE, []);
  let changed = false;

  for (const [key, list] of Object.entries(pending)) {
    const remaining = [];
    for (const item of list) {
      const online = await isPlayerOnline(item.nick);
      if (!online) {
        remaining.push(item);
        continue;
      }

      const vip = shop.find(v => v.id === item.vipId) || {
        id: item.vipId,
        name: item.vipName,
        lpGroup: item.lpGroup,
        dias: item.dias || 30,
        price: item.price || 0
      };

      try {
        await aplicarVip(item.nick, vip);

        const expiresAt = Date.now() + (vip.dias || 30) * 24 * 60 * 60 * 1000;
        const vips = loadJSON(VIP_FILE, {});
        const orders = loadJSON(VIP_ORDERS_FILE, {});

        vips[item.paymentId] = {
          paymentId: item.paymentId,
          nick: item.nick,
          discord: item.discord || null,
          vipId: vip.id,
          vipName: vip.name,
          lpGroup: vip.lpGroup,
          dias: vip.dias || 30,
          expiresAt,
          createdAt: item.createdAt || Date.now(),
          activatedAt: Date.now(),
          source: 'site'
        };

        if (orders[item.paymentId]) {
          orders[item.paymentId].delivered = true;
          orders[item.paymentId].deliveredAt = Date.now();
          orders[item.paymentId].deliveryStatus = 'delivered_after_login';
          orders[item.paymentId].expiresAt = expiresAt;
        }

        saveJSON(VIP_FILE, vips);
        saveJSON(VIP_ORDERS_FILE, orders);

        changed = true;
        console.log(`[VIP] ✅ Pendente entregue automaticamente: ${item.nick} → ${vip.name}`);
      } catch(e) {
        console.error('[VIP] Erro ao entregar pendente:', e.message);
        remaining.push(item);
      }
    }

    if (remaining.length) pending[key] = remaining;
    else delete pending[key];
  }

  if (changed) saveJSON(VIP_PENDING_FILE, pending);
}

async function processExpiredVips() {
  const vips = loadJSON(VIP_FILE, {});
  const shop = loadJSON(VIP_SHOP_FILE, []);
  let changed = false;

  for (const [paymentId, entry] of Object.entries(vips)) {
    if (entry.removed) continue;
    if (!entry.expiresAt || Date.now() < entry.expiresAt) continue;

    const vip = shop.find(v => v.id === entry.vipId) || {
      id: entry.vipId,
      name: entry.vipName,
      lpGroup: entry.lpGroup
    };

    try {
      await removerVip(entry.nick, vip);
      entry.removed = true;
      entry.removedAt = Date.now();
      vips[paymentId] = entry;
      changed = true;

      const orders = loadJSON(VIP_ORDERS_FILE, {});
      if (orders[paymentId]) {
        orders[paymentId].removed = true;
        orders[paymentId].removedAt = Date.now();
        saveJSON(VIP_ORDERS_FILE, orders);
      }
    } catch(e) {
      console.error('[VIP] Erro ao remover VIP expirado:', e.message);
    }
  }

  if (changed) saveJSON(VIP_FILE, vips);
}

// ─── KITS ────────────────────────────────────────────────────────────────
function loadAllKits() {
  const raw = loadJSON(MC_KITS_FILE, []);
  // Suporta formato antigo (array) e novo ({channelId: [...kits]})
  if (Array.isArray(raw)) return raw;
  // Novo formato: objeto com channelId como chave
  const kits = [];
  for (const arr of Object.values(raw)) {
    if (Array.isArray(arr)) kits.push(...arr);
  }
  return kits;
}

async function entregarKit(nick, kit) {
  if (!kit.commands || !kit.commands.length) {
    console.warn(`[KIT] Kit ${kit.name} sem comandos configurados!`);
    return;
  }
  for (const cmd of kit.commands) {
    const cmdFinal = cmd.replace(/\{player\}/g, nick);
    const resp = await rconExec(cmdFinal);
    console.log(`[KIT] RCON: ${cmdFinal} → ${resp ?? 'sem resposta'}`);
  }
  console.log(`[KIT] ✅ Kit entregue: ${nick} → ${kit.name}`);
}

async function getOnlinePlayers() {
  const raw = await rconExec('list');
  if (!raw) return [];
  const clean = String(raw).replace(/\u00a7[0-9a-fklmnorA-FKLMNOR]/g, '').replace(/\r/g, '').trim();
  const colonIdx = clean.lastIndexOf(':');
  if (colonIdx === -1) return [];
  const afterColon = clean.slice(colonIdx + 1).replace(/\n/g, ',').trim();
  if (!afterColon) return [];
  return afterColon.split(',').map(p => p.trim()).filter(Boolean);
}

async function isPlayerOnline(nick) {
  const players = await getOnlinePlayers();
  return players.some(p => p.toLowerCase() === String(nick).toLowerCase());
}

function addPendingKit(order, kit) {
  const pending = loadJSON(KIT_PENDING_FILE, {});
  const key = String(order.nick).toLowerCase();
  if (!pending[key]) pending[key] = [];
  const exists = pending[key].some(x => String(x.paymentId) === String(order.paymentId));
  if (!exists) {
    pending[key].push({
      paymentId: String(order.paymentId),
      kitId: order.kitId,
      kitName: kit.name,
      nick: order.nick,
      price: order.price || kit.price || 0,
      commands: kit.commands || [],
      createdAt: Date.now(),
      status: 'pending_offline'
    });
    saveJSON(KIT_PENDING_FILE, pending);
  }
}

async function deliverKitWhenOnline(order, kit) {
  const online = await isPlayerOnline(order.nick);
  if (!online) {
    addPendingKit(order, kit);
    console.log(`[KIT] ⏳ ${order.nick} offline — compra salva como pendente: ${kit.name}`);
    return { delivered: false, pending: true, reason: 'player_offline' };
  }
  await entregarKit(order.nick, kit);
  return { delivered: true, pending: false };
}

async function processPendingKits() {
  const pending = loadJSON(KIT_PENDING_FILE, {});
  const kits = loadAllKits();
  let changed = false;
  for (const [key, list] of Object.entries(pending)) {
    const remaining = [];
    for (const item of list) {
      const online = await isPlayerOnline(item.nick);
      if (!online) {
        remaining.push(item);
        continue;
      }
      const kit = kits.find(k => k.id === item.kitId) || { name: item.kitName, commands: item.commands || [] };
      try {
        await entregarKit(item.nick, kit);
        const orders = loadJSON(KIT_ORDERS_FILE, {});
        if (orders[item.paymentId]) {
          orders[item.paymentId].delivered = true;
          orders[item.paymentId].deliveredAt = Date.now();
          orders[item.paymentId].deliveryStatus = 'delivered_after_login';
          saveJSON(KIT_ORDERS_FILE, orders);
        }
        changed = true;
        console.log(`[KIT] ✅ Pendente entregue automaticamente: ${item.nick} → ${kit.name}`);
      } catch(e) {
        console.error('[KIT] Erro ao entregar pendente:', e.message);
        remaining.push(item);
      }
    }
    if (remaining.length) pending[key] = remaining;
    else delete pending[key];
  }
  if (changed) saveJSON(KIT_PENDING_FILE, pending);
}


// ─── AVISAR BOT DISCORD ───────────────────────────────────────────────────
function notifyBot(payload) {
  return new Promise((resolve) => {
    if (!CONFIG.BOT_WEBHOOK_URL) return resolve(false);

    try {
      const url = new URL(CONFIG.BOT_WEBHOOK_URL);
      const data = JSON.stringify(payload);
      const lib = url.protocol === 'https:' ? require('https') : require('http');

      const opts = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'x-site-secret': CONFIG.BOT_WEBHOOK_SECRET,
        },
        timeout: 10000,
      };

      const req = lib.request(opts, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          console.log('[SITE→BOT] status=' + res.statusCode + ' resposta=' + raw.slice(0,120));
          resolve(ok);
        });
      });
      req.on('error', e => { console.error('[SITE→BOT] Erro:', e.message); resolve(false); });
      req.on('timeout', () => { req.destroy(); console.error('[SITE→BOT] Timeout'); resolve(false); });
      req.write(data);
      req.end();
    } catch(e) {
      console.error('[SITE→BOT] URL inválida:', e.message);
      resolve(false);
    }
  });
}

// ─── PROCESSAR VIP COMPRADO ───────────────────────────────────────────────
async function processarVipComprado(paymentId, metadata, vip) {
  const { nick, discord, vipId } = metadata;
  const orders = loadJSON(VIP_ORDERS_FILE, {});
  const order = orders[paymentId] || metadata;

  if (order?.delivered) {
    return { delivered: true, pending: false, already: true };
  }

  order.paymentId = paymentId;
  order.vipId = vip.id || vipId || order.vipId;
  order.nick = nick || order.nick;
  order.discord = discord || order.discord || null;
  order.price = vip.price || order.price || 0;
  order.status = 'approved';

  const delivery = await deliverVipWhenOnline(order, vip);

  if (delivery.delivered) {
    const expiresAt = Date.now() + (vip.dias || 30) * 24 * 60 * 60 * 1000;

    const vips = loadJSON(VIP_FILE, {});
    vips[paymentId] = {
      paymentId,
      nick: order.nick,
      discord: order.discord || null,
      vipId: vip.id || order.vipId,
      vipName: vip.name,
      lpGroup: vip.lpGroup,
      dias: vip.dias || 30,
      expiresAt,
      createdAt: order.createdAt || Date.now(),
      activatedAt: Date.now(),
      source: 'site'
    };
    saveJSON(VIP_FILE, vips);

    order.delivered = true;
    order.deliveredAt = Date.now();
    order.deliveryStatus = 'delivered_online';
    order.expiresAt = expiresAt;
  } else {
    order.delivered = false;
    order.deliveryStatus = 'pending_player_offline';
  }

  orders[paymentId] = order;
  saveJSON(VIP_ORDERS_FILE, orders);

  return delivery;
}

// ─── EXPRESS ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve o index.html

// GET /api/vips — lista VIPs do arquivo do bot
app.get('/api/vips', (req, res) => {
  const shop = loadJSON(VIP_SHOP_FILE, []);
  // Remove campos internos desnecessários para o frontend
  const safe = shop.map(({ id, name, price, dias, description }) =>
    ({ id, name, price, dias, description })
  );
  res.json(safe);
});

// POST /api/pix — cria pagamento PIX
app.post('/api/pix', async (req, res) => {
  const { vipId, nick, discord } = req.body || {};
  if (!vipId || !nick) return res.status(400).json({ error: 'vipId e nick são obrigatórios' });
  if (nick.length < 3 || nick.length > 16 || !/^[a-zA-Z0-9_]+$/.test(nick))
    return res.status(400).json({ error: 'Nick inválido' });

  const shop = loadJSON(VIP_SHOP_FILE, []);
  const vip  = shop.find(v => v.id === vipId);
  if (!vip) return res.status(404).json({ error: 'VIP não encontrado' });

  try {
    const pix = await criarPix(vip, nick, discord);

    // Salva ordem pendente
    const orders = loadJSON(VIP_ORDERS_FILE, {});
    orders[pix.paymentId] = {
      paymentId: pix.paymentId,
      vipId, nick, discord: discord || null,
      price: vip.price, status: 'pending',
      createdAt: Date.now(), source: 'site',
    };
    saveJSON(VIP_ORDERS_FILE, orders);

    console.log(`[SITE] PIX gerado: ${nick} → ${vip.name} | R$ ${vip.price} | ID: ${pix.paymentId}`);
    res.json(pix);
  } catch(e) {
    console.error('[SITE] Erro PIX:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/pix/status/:id — verifica status do pagamento
app.get('/api/pix/status/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const data = await consultarStatus(id);
    const orders = loadJSON(VIP_ORDERS_FILE, {});
    const order  = orders[id];
    let delivery = null;

    if (data.status === 'approved' && order && !order.delivered) {
      const shop = loadJSON(VIP_SHOP_FILE, []);
      const vip  = shop.find(v => v.id === order.vipId);
      if (vip) {
        delivery = await processarVipComprado(id, order, vip);
      }
    }

    await processPendingVips().catch(e => console.error('[VIP] Erro ao processar pendentes:', e.message));
    await processExpiredVips().catch(e => console.error('[VIP] Erro ao remover expirados:', e.message));

    res.json({ ...data, delivery });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/online — jogadores online no servidor
app.get('/api/online', async (req, res) => {
  // Tenta fazer ping simples na porta de query
  const net = require('net');
  const sock = net.createConnection(CONFIG.GAME_PORT, CONFIG.SERVER_IP);
  let online = '?';
  sock.setTimeout(2000);
  sock.on('connect', () => { online = '🟢'; sock.destroy(); });
  sock.on('error', () => {});
  sock.on('close', () => res.json({ online }));
  sock.on('timeout', () => { sock.destroy(); res.json({ online: '?' }); });
});

// GET /api/kits — lista kits do mc_kits.json do bot
app.get('/api/kits', (req, res) => {
  const kits = loadAllKits();
  // Envia só campos seguros para o frontend
  const safe = kits.map(({ id, name, emoji, price, description, stock }) =>
    ({ id, name, emoji: emoji || '⚔️', price, description, stock: stock ?? 0 })
  );
  res.json(safe);
});

// POST /api/kits/pix — cria pagamento PIX para kit
app.post('/api/kits/pix', async (req, res) => {
  const { kitId, nick } = req.body || {};
  if (!kitId || !nick) return res.status(400).json({ error: 'kitId e nick são obrigatórios' });
  if (nick.length < 3 || nick.length > 16 || !/^[a-zA-Z0-9_]+$/.test(nick))
    return res.status(400).json({ error: 'Nick inválido' });

  const kits = loadAllKits();
  const kit  = kits.find(k => k.id === kitId);
  if (!kit) return res.status(404).json({ error: 'Kit não encontrado' });

  try {
    // Reutiliza a mesma função criarPix (só muda a descrição)
    const fakeVip = { id: kit.id, name: kit.name, price: kit.price };
    const pix = await criarPix(fakeVip, nick, null);

    const orders = loadJSON(KIT_ORDERS_FILE, {});
    orders[pix.paymentId] = {
      paymentId: pix.paymentId,
      kitId, nick, price: kit.price,
      status: 'pending', delivered: false,
      createdAt: Date.now(), source: 'site',
    };
    saveJSON(KIT_ORDERS_FILE, orders);

    console.log(`[SITE] PIX kit gerado: ${nick} → ${kit.name} | R$ ${kit.price} | ID: ${pix.paymentId}`);
    res.json(pix);
  } catch(e) {
    console.error('[SITE] Erro PIX kit:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/kits/pix/status/:id — verifica e entrega kit somente se o jogador estiver online
app.get('/api/kits/pix/status/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const data   = await consultarStatus(id);
    const orders = loadJSON(KIT_ORDERS_FILE, {});
    const order  = orders[id];
    let delivery = null;

    if (data.status === 'approved' && order && !order.delivered) {
      const kits = loadAllKits();
      const kit  = kits.find(k => k.id === order.kitId);
      if (kit) {
        delivery = await deliverKitWhenOnline(order, kit);
        if (delivery.delivered) {
          order.delivered = true;
          order.deliveredAt = Date.now();
          order.deliveryStatus = 'delivered_online';
        } else {
          order.deliveryStatus = 'pending_player_offline';
        }
        order.status = 'approved';
        orders[id] = order;
        saveJSON(KIT_ORDERS_FILE, orders);
      }
    }

    await processPendingKits().catch(e => console.error('[KIT] Erro ao processar pendentes:', e.message));
    res.json({ ...data, delivery });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WEBHOOK MERCADO PAGO (opcional — mais rápido que polling) ────────────
app.post('/webhook/mp', async (req, res) => {
  res.sendStatus(200);
  const { type, data } = req.body || {};
  if (type !== 'payment') return;
  try {
    const paymentId = String(data?.id);
    const status    = await consultarStatus(paymentId);
    if (status.status !== 'approved') return;

    // Verifica VIP
    const vipOrders = loadJSON(VIP_ORDERS_FILE, {});
    const vipOrder  = vipOrders[paymentId];
    if (vipOrder && !vipOrder.delivered) {
      const shop = loadJSON(VIP_SHOP_FILE, []);
      const vip  = shop.find(v => v.id === vipOrder.vipId);
      if (vip) await processarVipComprado(paymentId, vipOrder, vip);
      return;
    }

    // Verifica Kit
    const kitOrders = loadJSON(KIT_ORDERS_FILE, {});
    const kitOrder  = kitOrders[paymentId];
    if (kitOrder && !kitOrder.delivered) {
      const kits = loadAllKits();
      const kit  = kits.find(k => k.id === kitOrder.kitId);
      if (kit) {
        const result = await deliverKitWhenOnline(kitOrder, kit);
        if (result.delivered) {
          kitOrder.delivered = true;
          kitOrder.deliveredAt = Date.now();
          kitOrder.deliveryStatus = 'delivered_online';
        } else {
          kitOrder.deliveryStatus = 'pending_player_offline';
        }
        kitOrders[paymentId] = kitOrder;
        saveJSON(KIT_ORDERS_FILE, kitOrders);
      }
    }
  } catch(e) {
    console.error('[WEBHOOK] Erro:', e.message);
  }
});


// POST /api/kits/process-pending — força verificar pendentes manualmente
app.post('/api/kits/process-pending', async (req, res) => {
  try {
    await processPendingKits();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────
if (require.main === module) {
  
// ─── PROCESSADORES AUTOMÁTICOS ────────────────────────────────────────────
setInterval(() => {
  processPendingKits().catch(e => console.error('[KIT] Erro ao processar pendentes:', e.message));
  processPendingVips().catch(e => console.error('[VIP] Erro ao processar pendentes:', e.message));
  processExpiredVips().catch(e => console.error('[VIP] Erro ao remover expirados:', e.message));
}, 30000);

app.listen(CONFIG.PORT, () => {
  console.log('');
  console.log('  ██████╗  █████╗ ██████╗ ██╗  ██╗██╗    ██╗███████╗ █████╗ ██╗   ██╗███████╗██████╗');
  console.log('  ██╔══██╗██╔══██╗██╔══██╗██║ ██╔╝██║    ██║██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗');
  console.log('  ██║  ██║███████║██████╔╝█████╔╝ ██║ █╗ ██║█████╗  ███████║██║   ██║█████╗  ██████╔╝');
  console.log('  ██║  ██║██╔══██║██╔══██╗██╔═██╗ ██║███╗██║██╔══╝  ██╔══██║╚██╗ ██╔╝██╔══╝  ██╔══██╗');
  console.log('  ██████╔╝██║  ██║██║  ██║██║  ██╗╚███╔███╔╝███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║');
  console.log('  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝');
  console.log('');
  console.log(`  ✅ Servidor rodando em http://localhost:${CONFIG.PORT}`);
  console.log(`  📦 VIPs carregados de: ${VIP_SHOP_FILE}`);
  console.log(`  💰 Mercado Pago: ${CONFIG.MP_ACCESS_TOKEN !== 'SEU_TOKEN_MERCADO_PAGO_AQUI' ? '✅ configurado' : '⚠️ CONFIGURE O TOKEN!'}`);
  console.log(`  🎮 RCON: ${CONFIG.RCON_PASSWORD !== 'SUA_SENHA_RCON_AQUI' ? '✅ configurado' : '⚠️ CONFIGURE A SENHA!'}`);
  console.log('  ⏳ Entrega online: se jogador estiver offline, fica pendente e entrega ao entrar.');
  setInterval(() => processPendingKits().catch(e => console.error('[KIT] Erro no verificador de pendentes:', e.message)), 30000);
  processPendingKits().catch(() => {});
  console.log('');
  });
}

module.exports = app;
