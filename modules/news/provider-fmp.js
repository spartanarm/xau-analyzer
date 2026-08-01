// ══════════════════════════════════════════════════════════════════
// ADAPTER FMP (Financial Modeling Prep) — calendario economico.
//
// Endpoint verificato dalla documentazione ufficiale:
//   https://financialmodelingprep.com/stable/economic-calendar
//
// SCRITTO IN MODO DIFENSIVO, di proposito: non è stato possibile
// verificare i nomi esatti dei campi dalla documentazione (l'esempio
// JSON è caricato dinamicamente e non leggibile). Invece di assumere
// un solo nome per campo e rompersi al primo scostamento, questo
// adapter accetta più nomi plausibili per ciascun dato. Se FMP
// dovesse chiamare "date" ciò che qui cerchiamo anche come "time",
// funziona lo stesso.
//
// Se nessun campo riconoscibile viene trovato, l'evento viene SCARTATO
// invece di essere inventato con valori a caso — meglio un evento in
// meno che un orario sbagliato che blocca (o non blocca) un trade.

var https = require('https');

function httpsGetJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('Accesso negato da FMP (codice ' + res.statusCode + '): chiave non valida o piano insufficiente per il calendario economico'));
        }
        if (res.statusCode === 429) {
          return reject(new Error('Limite di richieste FMP superato (codice 429)'));
        }
        try {
          var parsed = JSON.parse(body);
          if (parsed && parsed['Error Message']) return reject(new Error('FMP: ' + parsed['Error Message']));
          resolve(parsed);
        } catch (e) { reject(new Error('Risposta non-JSON da FMP: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function toIsoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Legge il primo campo presente tra più nomi possibili.
function pick(obj, names) {
  for (var i = 0; i < names.length; i++) {
    if (obj[names[i]] !== undefined && obj[names[i]] !== null) return obj[names[i]];
  }
  return null;
}

// FMP fornisce la data come "2026-08-05 12:30:00" (UTC).
function parseTs(raw) {
  if (!raw) return null;
  var s = String(raw).trim();
  // se manca già l'indicazione di fuso, assumiamo UTC come da documentazione
  var iso = s.indexOf('T') !== -1 ? s : s.replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  var ts = Date.parse(iso);
  return isNaN(ts) ? null : ts;
}

function normalize(raw) {
  var list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.economicCalendar) ? raw.economicCalendar : []);
  return list.map(function (e) {
    var ts = parseTs(pick(e, ['date', 'time', 'datetime']));
    var title = pick(e, ['event', 'name', 'title']);
    return {
      id: [pick(e, ['country', 'currency']) || '', title || '', ts || ''].join('|'),
      timestampUtc: ts,
      currency: pick(e, ['currency', 'country']),
      title: title || '',
      impact: pick(e, ['impact', 'importance']),
      actual: pick(e, ['actual']),
      forecast: pick(e, ['estimate', 'forecast', 'consensus']),
      previous: pick(e, ['previous', 'prev']),
      source: 'fmp'
    };
    // eventi senza orario o senza titolo vengono scartati sotto:
    // un evento di cui non sappiamo QUANDO accade è inutilizzabile
    // per una finestra di blocco.
  }).filter(function (e) { return e.timestampUtc !== null && e.title; });
}

async function fetchEvents(apiKey, now, daysAhead, fetchFn) {
  var from = toIsoDate(now);
  var to = toIsoDate(now + (daysAhead || 7) * 24 * 3600e3);
  var url = 'https://financialmodelingprep.com/stable/economic-calendar?from=' + from + '&to=' + to + '&apikey=' + apiKey;
  var raw = await (fetchFn || httpsGetJson)(url);
  return normalize(raw);
}

module.exports = { fetchEvents: fetchEvents, normalize: normalize, name: 'fmp' };
