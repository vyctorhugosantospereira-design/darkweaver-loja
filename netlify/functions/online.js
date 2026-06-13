const { json, onlineCount } = require('./_utils');
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  try { return json(200, { online: await onlineCount() }); }
  catch (e) { return json(200, { online: '?', error: e.message }); }
};
