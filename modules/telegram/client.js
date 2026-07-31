// ══════════════════════════════════════════════════════════════════
// CLIENT TELEGRAM — parla con l'API di Telegram via https nativo di
// Node, nessuna libreria esterna da installare (stessa scelta già
// fatta per Twelve Data in dataFetcher.js).
//
// Il trasporto HTTP è iniettabile: nei test si passa un trasporto finto
// che registra le chiamate invece di contattare Telegram davvero — non
// abbiamo accesso a internet in questo ambiente di sviluppo, stessa
// limitazione già affrontata per il database.

var https = require('https');

function realTransport(token, method, body) {
  return new Promise(function (resolve, reject) {
    var payload = JSON.stringify(body || {});
    var req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + token + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15000
    }, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Risposta non-JSON da Telegram: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('Timeout chiamata Telegram')); });
    req.write(payload);
    req.end();
  });
}

function makeClient(token, transport) {
  var call = transport || realTransport;

  function sendMessage(chatId, text) {
    return call(token, 'sendMessage', { chat_id: chatId, text: text, parse_mode: 'HTML' })
      .then(function (res) {
        if (!res.ok) throw new Error('Telegram sendMessage ha rifiutato: ' + (res.description || JSON.stringify(res)));
        return res.result;
      });
  }

  function getUpdates(offset, timeoutSec) {
    return call(token, 'getUpdates', { offset: offset, timeout: timeoutSec || 25 })
      .then(function (res) {
        if (!res.ok) throw new Error('Telegram getUpdates ha rifiutato: ' + (res.description || JSON.stringify(res)));
        return res.result;
      });
  }

  return { sendMessage: sendMessage, getUpdates: getUpdates };
}

module.exports = { makeClient: makeClient, realTransport: realTransport };
