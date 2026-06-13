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
};

// ─── ARQUIVOS DO BOT ───────────────────────────────────────────────────────
const VIP_SHOP_FILE   = path.join(CONFIG.BOT_DIR, 'mc_vip_shop.json');
const VIP_FILE        = path.join(CONFIG.BOT_DIR, 'mc_vips.json');
const VIP_ORDERS_FILE = path.join(CONFIG.BOT_DIR, 'mc_vip_orders.json');
const VIP_PENDING_FILE = path.join(CONFIG.BOT_DIR, 'mc_vip_pending.json');

const MC_KITS_FILE        = path.join(CONFIG.BOT_DIR, 'mc_kits.json');
const KIT_ORDERS_FILE     = path.join(CONFIG.BOT_DIR, 'mc_kit_orders_site.json');

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
  // LuckPerms
  await rconExec(`lp user ${nick} parent add ${vip.lpGroup}`);
  await rconExec(`lp user ${nick} parent addtemp ${vip.lpGroup} ${vip.dias || 30}d`);
  console.log(`[VIP] Aplicado: ${nick} → ${vip.lpGroup}`);
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

// ─── PROCESSAR VIP COMPRADO ───────────────────────────────────────────────
async function processarVipComprado(paymentId, metadata, vip) {
  const { nick, discord, vipId } = metadata;
  const vips   = loadJSON(VIP_FILE,   {});
  const orders = loadJSON(VIP_ORDERS_FILE, {});

  if (orders[paymentId]?.delivered) return; // já processado

  // Salva ordem
  const expiresAt = Date.now() + (vip.dias || 30) * 24 * 60 * 60 * 1000;
  const vipEntry  = {
    paymentId, nick, discord, vipId, vipName: vip.name,
    lpGroup: vip.lpGroup, dias: vip.dias || 30,
    expiresAt, createdAt: Date.now(), source: 'site',
  };
  vips[paymentId] = vipEntry;
  orders[paymentId] = { ...vipEntry, delivered: true, deliveredAt: Date.now() };
  saveJSON(VIP_FILE,        vips);
  saveJSON(VIP_ORDERS_FILE, orders);

  // Aplica via RCON
  await aplicarVip(nick, vip);
  console.log(`[SITE] ✅ VIP entregue: ${nick} → ${vip.name}`);
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

    if (data.status === 'approved') {
      // Verifica se já foi processado
      const orders = loadJSON(VIP_ORDERS_FILE, {});
      const order  = orders[id];
      if (order && !order.delivered) {
        const shop = loadJSON(VIP_SHOP_FILE, []);
        const vip  = shop.find(v => v.id === order.vipId);
        if (vip) {
          order.delivered = true;
          orders[id] = order;
          saveJSON(VIP_ORDERS_FILE, orders);
          processarVipComprado(id, order, vip).catch(e =>
            console.error('[SITE] Erro ao aplicar VIP:', e.message)
          );
        }
      }
    }

    res.json(data);
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

// GET /api/kits/pix/status/:id — verifica e entrega kit
app.get('/api/kits/pix/status/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const data   = await consultarStatus(id);
    const orders = loadJSON(KIT_ORDERS_FILE, {});
    const order  = orders[id];

    if (data.status === 'approved' && order && !order.delivered) {
      const kits = loadAllKits();
      const kit  = kits.find(k => k.id === order.kitId);
      if (kit) {
        order.delivered   = true;
        order.deliveredAt = Date.now();
        orders[id] = order;
        saveJSON(KIT_ORDERS_FILE, orders);

        entregarKit(order.nick, kit).catch(e =>
          console.error('[SITE] Erro ao entregar kit:', e.message)
        );
      }
    }

    res.json(data);
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
        kitOrder.delivered   = true;
        kitOrder.deliveredAt = Date.now();
        kitOrders[paymentId] = kitOrder;
        saveJSON(KIT_ORDERS_FILE, kitOrders);
        await entregarKit(kitOrder.nick, kit);
      }
    }
  } catch(e) {
    console.error('[WEBHOOK] Erro:', e.message);
  }
});

// ─── START ────────────────────────────────────────────────────────────────
if (require.main === module) {
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
  console.log('');
  });
}

module.exports = app;
