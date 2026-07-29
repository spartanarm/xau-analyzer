// ══════════════════════════════════════════════════════════════════
// SERVER — espone in sola lettura l'ultimo risultato prodotto dallo
// scheduler. Il telefono/browser legge da qui, non calcola più nulla:
// riceve il piano già pronto, esattamente come lo scheduler l'ha
// prodotto chiamando il motore invariato.

var http = require('http');
var store = require('./stateStore.js');

var PORT = process.env.PORT || 3000;

var server = http.createServer(function (req, res) {
  if (req.url === '/api/latest') {
    var snapshot = store.load('latest_snapshot', null);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(snapshot || { error: 'Nessuna analisi ancora disponibile — il primo ciclo dello scheduler non è ancora completato.' }));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    var snapshot = store.load('latest_snapshot', null);
    var html = renderSimplePage(snapshot);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end('Non trovato.');
});

// Pagina minimale, leggibile, che mostra il piano corrente SENZA alcun
// calcolo lato browser — solo lettura e visualizzazione di ciò che lo
// scheduler ha già deciso. Una dashboard più curata graficamente è un
// progetto a parte, da fare quando/se vorrai.
function renderSimplePage(snap) {
  if (!snap) {
    return '<html><body style="font-family:monospace;background:#0a0a0a;color:#eee;padding:20px;">' +
      '<h2>XAU/USD Technical Analyzer — H24</h2><p>Nessuna analisi ancora disponibile. Il servizio si è appena avviato, attendere il primo ciclo (max 5 minuti).</p></body></html>';
  }
  var p = snap.plan;
  var updated = new Date(snap.generatedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60"></head>' +
    '<body style="font-family:monospace;background:#0a0a0a;color:#eee;padding:16px;font-size:15px;line-height:1.6;">' +
    '<h2 style="color:#e8b923;">XAU/USD · TECHNICAL ANALYZER</h2>' +
    '<div style="color:#888;">Aggiornato: ' + updated + '</div>' +
    '<div style="font-size:28px;margin:16px 0;">' + (snap.price ? snap.price.toFixed(2) : 'n.d.') + '</div>' +
    '<div style="border:1px solid #333;padding:12px;border-radius:8px;margin-bottom:12px;">' +
    '<b>Market Bias:</b> ' + snap.bias.bias + '<br>' +
    '<b>Trade Action:</b> ' + p.tradeAction + '<br>' +
    '<b>Order Type:</b> ' + (p.orderType || 'NONE') + '<br>' +
    '<b>Execution Mode:</b> ' + (p.executionMode || 'NO TRADE') + '<br>' +
    '<b>Status:</b> ' + p.status +
    (p.quality ? ('<br><b>Setup Quality:</b> ' + (p.quality.grade || '—') + ' · Confidence ' + p.quality.confidence + '/100') : '') +
    (p.entryLo !== null ? ('<br><b>Entry:</b> ' + p.entryLo.toFixed(2) + (p.entryHi !== null ? ('–' + p.entryHi.toFixed(2)) : '')) : '') +
    (p.sl !== null ? ('<br><b>SL:</b> ' + p.sl.toFixed(2)) : '') +
    (p.tp1 !== null ? ('<br><b>TP1:</b> ' + p.tp1.toFixed(2)) : '') +
    '</div>' +
    '<div style="color:#aaa;font-size:13px;">' + (p.reason || '') + '</div>' +
    '<div style="margin-top:20px;color:#555;font-size:11px;">Pagina di sola lettura — nessun calcolo avviene qui, solo visualizzazione di ciò che il servizio ha già deciso. Aggiornamento automatico ogni minuto.</div>' +
    '</body></html>';
}

function start() {
  server.listen(PORT, function () {
    console.log('Server in ascolto sulla porta ' + PORT + ' — pagina su http://localhost:' + PORT + '/');
  });
}

module.exports = { start: start };

if (require.main === module) start();
