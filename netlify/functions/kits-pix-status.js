const { json, consultarStatus } = require('./_utils');
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  const id = (event.path || '').split('/').pop();
  if (!id) return json(400, { error: 'ID obrigatório' });
  try { return json(200, await consultarStatus(id)); }
  catch (e) { return json(500, { error: e.message }); }
};
