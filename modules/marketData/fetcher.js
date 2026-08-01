// ══════════════════════════════════════════════════════════════════
// DATA FETCHER — scarica le candele più recenti da Twelve Data e le
// aggiunge alla cache persistente. Riusa la stessa identica logica di
// rate-gate già scritta e testata in download_history.js (max 7
// richieste/minuto, stesso margine di sicurezza sotto il limite reale
// di 8 imposto da Twelve Data).
//
// Ogni ciclo scarica solo le candele PIÙ RECENTI (outputsize piccolo:
// bastano poche candele per essere sicuri di non perdere quella appena
// chiusa), le unisce a quelle già in cache (merge + dedup, stessa
// tecnica di download_history.js), e salva. Non riscarica mai la storia
// intera — solo l'aggiornamento.

var https = require('https');
var store = require('../persistence/stateStore.js');
var config = require('../../core/config/index.js');
var logging = require('../../core/logging/index.js');
var bus = require('../../core/events/index.js');

var log = logging.forComponent('market-data');

var TF_DEF = {
  h4: { interval: '4h', ms: 4 * 3600e3 },
  h1: { interval: '1h', ms: 3600e3 },
  m15: { interval: '15min', ms: 15 * 60e3 },
  m5: { interval: '5min', ms: 5 * 60e3 }
};

// Nessun valore hardcoded: tutto dal Configuration Engine.
function md() { return config.get().marketData; }

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function loadReqTimes() {
  return (store.load('rate_times', []) || []).filter(function (t) { return Date.now() - t < 60000; });
}
function saveReqTimes(times) { store.save('rate_times', times.slice(-20)); }

async function waitForRateSlot(reqTimes) {
  while (true) {
    var fresh = reqTimes.filter(function (t) { return Date.now() - t < 60000; });
    if (fresh.length < md().rateLimitPerMin) return fresh;
    var waitMs = Math.max(500, fresh[0] + 60000 - Date.now() + 200);
    log.info('rate.wait', 'limite richieste raggiunto, attendo ' + Math.ceil(waitMs / 1000) + 's', { waitMs: waitMs });
    await sleep(waitMs);
  }
}

function httpsGetJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Risposta non-JSON da Twelve Data: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function mergeDedup(existing, incoming) {
  var byTs = {};
  existing.concat(incoming).forEach(function (c) { byTs[c.t] = c; });
  return Object.keys(byTs).map(function (k) { return byTs[k]; }).sort(function (a, b) { return a.t - b.t; });
}

async function fetchTimeframe(tfKey, reqTimesRef) {
  var apiKey = md().apiKey;
  var def = TF_DEF[tfKey];
  reqTimesRef.times = await waitForRateSlot(reqTimesRef.times);
  var url = 'https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=' + def.interval +
    '&outputsize=' + md().updateOutputsize + '&timezone=UTC&apikey=' + apiKey;
  reqTimesRef.times.push(Date.now());
  saveReqTimes(reqTimesRef.times);

  var data = await httpsGetJson(url);
  if (data.status === 'error' || !data.values) {
    throw new Error('Twelve Data ha risposto con errore per ' + tfKey + ': ' + (data.message || JSON.stringify(data)));
  }
  var fresh = data.values.map(function (v) {
    return { t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'), o: parseFloat(v.open), h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close) };
  });

  var cache = store.load('candles_' + tfKey, []);
  var merged = mergeDedup(cache, fresh);
  // finestra scorrevole: stessa dimensione che il motore usa dal vivo
  // (120 candele per H4/H1, come in index.html) — non serve accumulare
  // più storia di quella che il motore consulta davvero.
  var windowSize = md().candleWindowSize;
  var trimmed = merged.slice(-windowSize);
  store.save('candles_' + tfKey, trimmed);
  return trimmed;
}

// Un timeframe va riscaricato SOLO quando una sua candela è realmente
// chiusa dall'ultimo scarico. Una candela H4 chiude ogni 4 ore: scaricare
// H4 ogni 5 minuti sprecava oltre 280 richieste al giorno per nulla.
//
// Consumo giornaliero con questa regola:
//   M5  288/giorno · M15 96 · H1 24 · H4 6  →  circa 414 totali
// contro le ~1150 di prima, che sfondavano il limite giornaliero di 800
// imposto da Twelve Data (verificato dal vivo: servizio cieco per ore).
function needsFetch(tfKey, cached, now) {
  if (!cached || !cached.length) return true; // nessun dato: serve scaricare
  var tfMs = TF_DEF[tfKey].ms;
  var lastCandleStart = cached[cached.length - 1].t;
  // inizio dell'ultima candela che risulta CHIUSA in questo momento
  var currentClosedStart = Math.floor(now / tfMs) * tfMs - tfMs;
  return lastCandleStart < currentClosedStart;
}

async function fetchAllTimeframes() {
  var reqTimesRef = { times: loadReqTimes() };
  var out = {};
  var tfList = ['m5', 'm15', 'h1', 'h4'];
  var now = Date.now();
  var fetched = [], reused = [];

  try {
    for (var tfKey of tfList) {
      var cached = store.load('candles_' + tfKey, []);
      if (needsFetch(tfKey, cached, now)) {
        out[tfKey] = await fetchTimeframe(tfKey, reqTimesRef);
        fetched.push(tfKey);
      } else {
        out[tfKey] = cached; // nessuna candela nuova: riuso quelle in cache
        reused.push(tfKey);
      }
    }
  } catch (err) {
    log.error('fetch.failed', 'aggiornamento dati di mercato fallito: ' + err.message, { requestsUsed: reqTimesRef.times.length, fetched: fetched });
    bus.publish(bus.EVENTS.MARKET_DATA_FAILED, { error: err.message });
    throw err;
  }

  if (fetched.length) {
    log.debug('fetch.done', 'timeframe aggiornati: ' + (fetched.join(', ') || 'nessuno') + ' · riusati dalla cache: ' + (reused.join(', ') || 'nessuno'));
  }
  bus.publish(bus.EVENTS.MARKET_DATA_UPDATED, {
    counts: tfList.reduce(function (a, k) { a[k] = out[k].length; return a; }, {}),
    requestsUsed: reqTimesRef.times.length, fetched: fetched, reused: reused
  });
  return out;
}

module.exports = { fetchAllTimeframes: fetchAllTimeframes, TF_DEF: TF_DEF };
