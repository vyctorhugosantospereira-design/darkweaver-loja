const { json, loadAllKits, getPayment, deliverKit, validateNick, safeNick, deliveredCache } = require('./_utils');
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método inválido' });
  try {
    const { paymentId, kitId, nick } = JSON.parse(event.body || '{}');
    const mcNick = safeNick(nick);
    if (!paymentId || !kitId || !mcNick) return json(400, { error: 'paymentId, kitId e nick são obrigatórios' });
    if (!validateNick(mcNick)) return json(400, { error: 'Nick inválido' });
    if (deliveredCache.has(String(paymentId))) return json(200, { delivered: true, already: true });

    const pay = await getPayment(String(paymentId));
    if (pay.status !== 'approved') return json(402, { error: 'Pagamento ainda não aprovado', status: pay.status });
    const meta = pay.metadata || {};
    const ext = String(pay.external_reference || '');
    const paymentKitId = meta.kit_id || meta.kitId || (ext.includes('|') ? ext.split('|')[1] : null);
    const paymentNick = meta.nick || (ext.includes('|') ? ext.split('|')[2] : null);
    if (paymentKitId && String(paymentKitId) !== String(kitId)) return json(403, { error: 'Kit não bate com o pagamento' });
    if (paymentNick && String(paymentNick).toLowerCase() !== mcNick.toLowerCase()) return json(403, { error: 'Nick não bate com o pagamento' });

    const kit = loadAllKits().find(k => k.id === kitId || k.name === kitId);
    if (!kit) return json(404, { error: 'Kit não encontrado' });
    const results = await deliverKit(kit, mcNick);
    deliveredCache.add(String(paymentId));
    return json(200, { delivered: true, kit: kit.name, nick: mcNick, results });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
