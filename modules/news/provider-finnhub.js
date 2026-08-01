// ══════════════════════════════════════════════════════════════════
// ADAPTER FINNHUB — parla con Finnhub e traduce nel formato interno.
//
// È l'UNICO file che sa come è fatta l'API di Finnhub. Cambiare
// fornitore significa scrivere un altro file come questo, senza toccare
// né il News Engine (le regole) né il Decision Gate (le decisioni).
//
// NOTA ONESTA: non è stato possibile verificare con certezza se il
// calendario economico sia incluso nel piano gratuito di Finnhub. Se
// non lo fosse, l'errore comparirà chiaramente nei log come "accesso
// negato" e basterà scrivere un adapter per un altro fornitore — il
// resto del sistema non se ne accorgerà. È esattamente la ragione per
// cui l'architettura è fatta così.

var https = require('https');

function httpsGetJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('Accesso negato da Finnhub (codice ' + res.statusCode + '): il calendario economico potrebbe non essere incluso nel piano gratuito'));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Risposta non-JSON da Finnhub: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function toIsoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Traduzione nel formato interno. Ogni campo che il News Engine si
// aspetta viene ricavato qui, una volta sola.
function normalize(raw) {
  if (!raw || !Array.isArray(raw.economicCalendar)) return [];
  return raw.economicCalendar.map(function (e) {
    // Finnhub fornisce la data come "2026-08-05 12:30:00" (UTC)
    var ts = e.time ? Date.parse(String(e.time).replace(' ', 'T') + 'Z') : null;
    return {
      id: (e.country || '') + '|' + (e.event || '') + '|' + (e.time || ''),
      timestampUtc: (ts && !isNaN(ts)) ? ts : null,
      currency: e.country || null,
      title: e.event || '',
      impact: e.impact || null,
      actual: e.actual !== undefined ? e.actual : null,
      forecast: e.estimate !== undefined ? e.estimate : null,
      previous: e.prev !== undefined ? e.prev : null,
      source: 'finnhub'
    };
  }).filter(function (e) { return e.timestampUtc !== null; });
}

// Scarica gli eventi da oggi ai prossimi N giorni.
async function fetchEvents(apiKey, now, daysAhead, fetchFn) {
  var from = toIsoDate(now);
  var to = toIsoDate(now + (daysAhead || 7) * 24 * 3600e3);
  var url = 'https://finnhub.io/api/v1/calendar/economic?from=' + from + '&to=' + to + '&token=' + apiKey;
  var raw = await (fetchFn || httpsGetJson)(url);
  return normalize(raw);
}

module.exports = { fetchEvents: fetchEvents, normalize: normalize, name: 'finnhub' };
