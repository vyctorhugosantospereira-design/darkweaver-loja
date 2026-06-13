const { json, loadAllKits, criarPixKit, validateNick, safeNick } = require('./_utils');
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método inválido' });
  try {
    const { kitId, nick } = JSON.parse(event.body || '{}');
    const mcNick = safeNick(nick);
    if (!kitId || !mcNick) return json(400, { error: 'kitId e nick são obrigatórios' });
    if (!validateNick(mcNick)) return json(400, { error: 'Nick inválido. Use o nick exato do Minecraft.' });
    const kit = loadAllKits().find(k => k.id === kitId || k.name === kitId);
    if (!kit) return json(404, { error: 'Kit não encontrado' });
    const pix = await criarPixKit(kit, mcNick);
    return json(200, { ...pix, kitId: kit.id, nick: mcNick });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
