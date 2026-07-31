// ══════════════════════════════════════════════════════════════════
// API + DASHBOARD — sola lettura. Nessun calcolo qui dentro: espone
// soltanto ciò che l'orchestratore ha già prodotto e salvato.
//
// Endpoint pensati per essere consumati indistintamente dalla pagina web
// di oggi e da un'app mobile domani: è il motivo per cui i dati passano
// da un'API e non da HTML generato.

var http = require('http');
var config = require('../../core/config/index.js');
var logging = require('../../core/logging/index.js');
var bus = require('../../core/events/index.js');
var store = require('../persistence/stateStore.js');
var scheduler = require('../orchestrator/scheduler.js');

var log = logging.forComponent('api');
var server = null;
var startedAt = Date.now();

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function health() {
  var st = scheduler.getStats();
  var snap = store.load('latest_snapshot', null);
  var ageMs = snap ? (Date.now() - snap.generatedAt) : null;

  // Lo stato riflette DUE cose, non una: la freschezza dei dati E il
  // funzionamento dei cicli. Un errore recente rende lo stato "degraded"
  // anche se l'ultima analisi salvata è ancora fresca — altrimenti la
  // dashboard direbbe "ok" mentre il servizio sta fallendo.
  var errorIsRecent = st.lastError && (Date.now() - st.lastError.at) < 15 * 60 * 1000;
  var dataIsFresh = snap && ageMs < 30 * 60 * 1000;

  var status;
  if (!snap) status = 'starting';
  else if (errorIsRecent) status = 'degraded';
  else if (!dataIsFresh) status = 'stale';
  else status = 'ok';

  return {
    status: status,
    reason: status === 'degraded' ? ('ultimo ciclo fallito: ' + st.lastError.message)
      : status === 'stale' ? 'ultima analisi troppo vecchia'
      : status === 'starting' ? 'in attesa del primo ciclo' : null,
    uptimeMs: Date.now() - startedAt,
    cycles: { run: st.cyclesRun, skipped: st.cyclesSkipped, failed: st.cyclesFailed },
    lastRunAt: st.lastRunAt,
    lastAnalysisAgeMs: ageMs,
    lastError: st.lastError,
    logging: logging.getState()
  };
}

var routes = {
  '/api/health': function () { return health(); },
  '/api/latest': function () { return store.load('latest_snapshot', null) || { error: 'nessuna analisi ancora disponibile' }; },
  '/api/config': function () { return config.describe(); },
  '/api/logs': function () { return logging.recent(100); },
  '/api/events': function () { return bus.getHistory(100); },
  '/api/subscribers': function () { return bus.listSubscribers(); }
};

function renderPage(snap, h) {
  var upMin = Math.floor(h.uptimeMs / 60000);
  if (!snap) {
    return '<html><body style="font-family:monospace;background:#0a0a0a;color:#eee;padding:20px;">' +
      '<h2 style="color:#e8b923;">XAU/USD · TECHNICAL ANALYZER</h2>' +
      '<p>Nessuna analisi ancora disponibile. Servizio avviato da ' + upMin + ' min, attendere il primo ciclo.</p></body></html>';
  }
  var p = snap.plan;
  var updated = new Date(snap.generatedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  var ageMin = Math.floor((Date.now() - snap.generatedAt) / 60000);
  var statusColor = h.status === 'ok' ? '#3ddc84' : (h.status === 'stale' ? '#e8b923' : '#888');
  return '<html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="refresh" content="60"></head>' +
    '<body style="font-family:monospace;background:#0a0a0a;color:#eee;padding:16px;font-size:15px;line-height:1.6;">' +
    '<h2 style="color:#e8b923;margin-bottom:4px;">XAU/USD · TECHNICAL ANALYZER</h2>' +
    '<div style="color:' + statusColor + ';font-size:12px;">● ' + h.status.toUpperCase() +
      ' · uptime ' + upMin + ' min · cicli ' + h.cycles.run + ' (saltati ' + h.cycles.skipped + ', errori ' + h.cycles.failed + ')</div>' +
    '<div style="color:#888;font-size:12px;margin-bottom:12px;">Aggiornato: ' + updated + ' (' + ageMin + ' min fa)</div>' +
    '<div style="font-size:30px;margin:12px 0;">' + (snap.price ? snap.price.toFixed(2) : 'n.d.') + '</div>' +
    '<div style="border:1px solid #333;padding:12px;border-radius:8px;margin-bottom:12px;">' +
    '<b>Market Bias:</b> ' + snap.bias.bias + '<br>' +
    '<b>Trade Action:</b> ' + p.tradeAction + '<br>' +
    '<b>Order Type:</b> ' + (p.orderType || 'NONE') + '<br>' +
    '<b>Execution Mode:</b> ' + (p.executionMode || 'NO TRADE') + '<br>' +
    '<b>Status:</b> ' + p.status +
    (p.quality ? ('<br><b>Setup Quality:</b> ' + (p.quality.grade || '—') + ' · Confidence ' + p.quality.confidence + '/100') : '') +
    (p.entryLo !== null && p.entryLo !== undefined ? ('<br><b>Entry:</b> ' + p.entryLo.toFixed(2) + (p.entryHi ? ('–' + p.entryHi.toFixed(2)) : '')) : '') +
    (p.sl !== null && p.sl !== undefined ? ('<br><b>SL:</b> ' + p.sl.toFixed(2)) : '') +
    (p.tp1 !== null && p.tp1 !== undefined ? ('<br><b>TP1:</b> ' + p.tp1.toFixed(2)) : '') +
    (p.tp2 !== null && p.tp2 !== undefined ? ('<br><b>TP2:</b> ' + p.tp2.toFixed(2)) : '') +
    '</div>' +
    '<div style="color:#aaa;font-size:13px;">' + (p.reason || '') + '</div>' +
    '<div style="margin-top:20px;color:#555;font-size:11px;">Pagina di sola lettura. Dati anche su /api/latest · /api/health · /api/logs · /api/events</div>' +
    '</body></html>';
}

function handler(req, res) {
  var path = (req.url || '/').split('?')[0];
  try {
    if (routes[path]) return json(res, 200, routes[path]());
    if (path === '/' || path === '/index.html') {
      var html = renderPage(store.load('latest_snapshot', null), health());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    return json(res, 404, { error: 'non trovato', available: Object.keys(routes).concat(['/']) });
  } catch (err) {
    log.error('request.failed', 'errore nella gestione della richiesta', { path: path, error: err.message });
    return json(res, 500, { error: 'errore interno' });
  }
}

function start() {
  var port = config.get().server.port;
  server = http.createServer(handler);
  server.listen(port, function () {
    log.info('server.started', 'API e dashboard in ascolto', { port: port });
  });
}

function stop() { if (server) { server.close(); server = null; } }

module.exports = { start: start, stop: stop, health: health };
