const { json, loadAllKits } = require('./_utils');
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  const safe = loadAllKits().map(({ id, name, emoji, price, description, stock, image }) =>
    ({ id, name, emoji: emoji || '⚔️', price, description, stock: stock ?? 0, image })
  );
  return json(200, safe);
};
