// ══════════════════════════════════════════════════════════════════
// TEST MODULO 0 — Measurement Layer
//
// La garanzia più importante: questo modulo OSSERVA e basta. Se
// fallisse del tutto, il sistema si comporterebbe esattamente come oggi.

var fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '✅' : '❌'), name, extra !== undefined ? ('— ' + extra) : '');
  if (!cond) fails++;
}

process.env.TWELVEDATA_API_KEY = 'test';
process.env.DATA_DIR = '/tmp/test-measurement-data';
process.env.DATABASE_URL = 'postgres://fake';
var fs = require('fs');
try { fs.rmSync('/tmp/test-measurement-data', { recursive: true, force: true }); } catch (e) { }

var config = require('../core/config/index.js');
var logging = require('../core/logging/index.js');
var bus = require('../core/events/index.js');
var store = require('../modules/persistence/stateStore.js');
var measurement = require('../modules/measurement/index.js');
var db = require('../modules/database/index.js');
var repo = require('../modules/database/repository.js');
var fakePg = require('./fakePg.js');

logging.configure({ level: 'ERROR', toFile: false });
config.load();

// ═══ CALCOLO DELL'ESITO IPOTETICO ═══
console.log('\n═══ CALCOLO ESITO IPOTETICO ═══');
check('BUY, entry 4100, SL 4090, uscita 4130 → +3R', measurement.computeHypotheticalR(4100, 4090, 4130, 'BUY') === 3);
check('BUY che sarebbe andato in stop → -1R', measurement.computeHypotheticalR(4100, 4090, 4090, 'BUY') === -1);
check('SELL, entry 4100, SL 4110, uscita 4070 → +3R', measurement.computeHypotheticalR(4100, 4110, 4070, 'SELL') === 3);
check('Dati mancanti → nessun calcolo inventato', measurement.computeHypotheticalR(null, 4090, 4130, 'BUY') === null);
check('Rischio nullo → nessuna divisione per zero', measurement.computeHypotheticalR(4100, 4100, 4130, 'BUY') === null);

var pool = db.init(config, logging, fakePg);

(async function run() {
  await db.runMigrations();

  // ═══ REGISTRAZIONE DEL BLOCCO ═══
  console.log('\n═══ REGISTRAZIONE DEL BLOCCO ═══');
  bus.reset();
  store.save('blocked_pending_XAUUSD', {});
  measurement.attach(bus, config, logging, { store: store, repo: repo });

  bus.publish(bus.EVENTS.DECISION_BLOCKED, {
    symbol: 'XAU/USD', setupId: 'S-BLK-001', direction: 'BUY', blockedBy: 'news',
    gateReason: 'Setup valido ma bloccato: FOMC tra 12 minuti',
    entryLo: 4100, sl: 4090, tp1: 4130,
    quality: { grade: 'A+', confidence: 82 }, executionMode: 'MARKET'
  });
  await new Promise(function (r) { setTimeout(r, 30); });

  var pending = measurement.getPending('XAU/USD');
  check('Il blocco viene registrato in attesa di esito', !!pending['S-BLK-001']);
  check('Conserva i livelli del piano al momento del blocco', pending['S-BLK-001'].entry === 4100 && pending['S-BLK-001'].sl === 4090);
  check('Conserva grade e confidence (per capire QUALI setup vengono bloccati)',
    pending['S-BLK-001'].grade === 'A+' && pending['S-BLK-001'].confidence === 82);
  check('Registra quale filtro ha bloccato', pending['S-BLK-001'].blockedBy === 'news');
  check('Scrive nel database', pool.tables.blocked_decisions.length === 1);

  // GARANZIA: un setup bloccato per più cicli non genera righe duplicate
  bus.publish(bus.EVENTS.DECISION_BLOCKED, {
    symbol: 'XAU/USD', setupId: 'S-BLK-001', direction: 'BUY', blockedBy: 'news',
    gateReason: 'ancora bloccato', entryLo: 4100, sl: 4090, tp1: 4130, quality: { grade: 'A+', confidence: 82 }
  });
  await new Promise(function (r) { setTimeout(r, 30); });
  check('GARANZIA: blocchi ripetuti dello stesso setup NON creano duplicati', pool.tables.blocked_decisions.length === 1);

  // ═══ OSSERVAZIONE DELL'ESITO (dai segnali del motore) ═══
  console.log('\n═══ OSSERVAZIONE DELL\'ESITO ═══');
  bus.publish(bus.EVENTS.SETUP_TARGET_HIT, { symbol: 'XAU/USD', setupId: 'S-BLK-001', priceAtEvent: 4129.5 });
  await new Promise(function (r) { setTimeout(r, 30); });

  var row = pool.tables.blocked_decisions[0];
  check('L\'esito viene osservato dal segnale del motore (nessun ricontrollo dei prezzi)', row.outcome === 'WOULD_HIT_TP');
  check('Calcola quanto avremmo guadagnato: +2.95R', Math.abs(row.hypothetical_r - 2.95) < 0.01, row.hypothetical_r);
  check('Il setup esce dalla lista in attesa', !measurement.getPending('XAU/USD')['S-BLK-001']);

  // Caso opposto: un blocco che ci ha PROTETTI
  bus.publish(bus.EVENTS.DECISION_BLOCKED, {
    symbol: 'XAU/USD', setupId: 'S-BLK-002', direction: 'BUY', blockedBy: 'news',
    gateReason: 'NFP tra 20 minuti', entryLo: 4100, sl: 4090, tp1: 4130, quality: { grade: 'A', confidence: 65 }
  });
  await new Promise(function (r) { setTimeout(r, 30); });
  bus.publish(bus.EVENTS.SETUP_INVALIDATED, { symbol: 'XAU/USD', setupId: 'S-BLK-002', invalid: 4090 });
  await new Promise(function (r) { setTimeout(r, 30); });

  var row2 = pool.tables.blocked_decisions.find(function (r) { return r.setup_id === 'S-BLK-002'; });
  check('Un setup bloccato che sarebbe andato in stop viene registrato come tale', row2.outcome === 'WOULD_HIT_SL');
  check('Con perdita evitata di -1R', row2.hypothetical_r === -1);

  // Setup scaduto: né successo né fallimento
  bus.publish(bus.EVENTS.DECISION_BLOCKED, {
    symbol: 'XAU/USD', setupId: 'S-BLK-003', direction: 'SELL', blockedBy: 'risk',
    gateReason: 'limite giornaliero', entryLo: 4100, sl: 4110, tp1: 4070, quality: { grade: 'B', confidence: 50 }
  });
  await new Promise(function (r) { setTimeout(r, 30); });
  bus.publish(bus.EVENTS.SETUP_EXPIRED, { symbol: 'XAU/USD', setupId: 'S-BLK-003' });
  await new Promise(function (r) { setTimeout(r, 30); });

  var row3 = pool.tables.blocked_decisions.find(function (r) { return r.setup_id === 'S-BLK-003'; });
  check('Un setup scaduto è contato a parte (non falsa le statistiche)', row3.outcome === 'EXPIRED');
  check('Senza un risultato in R inventato', row3.hypothetical_r === null);

  // ═══ SETUP NON BLOCCATI: non devono finire qui ═══
  console.log('\n═══ SETUP NON BLOCCATI ═══');
  var prima = pool.tables.blocked_decisions.length;
  bus.publish(bus.EVENTS.SETUP_TARGET_HIT, { symbol: 'XAU/USD', setupId: 'S-NORMALE', priceAtEvent: 4130 });
  await new Promise(function (r) { setTimeout(r, 30); });
  check('GARANZIA: un setup mai bloccato non viene registrato per errore', pool.tables.blocked_decisions.length === prima);

  // ═══ STATISTICHE PER FILTRO ═══
  console.log('\n═══ STATISTICHE PER FILTRO ═══');
  var stats = await repo.getFilterStats('XAU/USD');
  check('Le statistiche sono raggruppate per filtro ed esito', stats.length >= 3, JSON.stringify(stats.map(function (s) { return s.blocked_by + '/' + s.outcome; })));
  var newsTP = stats.find(function (s) { return s.blocked_by === 'news' && s.outcome === 'WOULD_HIT_TP'; });
  var newsSL = stats.find(function (s) { return s.blocked_by === 'news' && s.outcome === 'WOULD_HIT_SL'; });
  check('Il News Lock ha bloccato 1 setup che sarebbe andato in TP', newsTP && parseInt(newsTP.n, 10) === 1);
  check('E 1 che sarebbe andato in SL', newsSL && parseInt(newsSL.n, 10) === 1);

  // ═══ PERSISTENZA TRA RIAVVII ═══
  console.log('\n═══ PERSISTENZA ═══');
  bus.publish(bus.EVENTS.DECISION_BLOCKED, {
    symbol: 'XAU/USD', setupId: 'S-BLK-004', direction: 'BUY', blockedBy: 'news',
    gateReason: 'x', entryLo: 4100, sl: 4090, tp1: 4130, quality: null
  });
  await new Promise(function (r) { setTimeout(r, 30); });
  var salvato = store.load('blocked_pending_XAUUSD', {});
  check('GARANZIA: i blocchi in attesa sopravvivono a un riavvio (un esito può arrivare ore dopo)', !!salvato['S-BLK-004']);

  // ═══ ISOLAMENTO: la garanzia centrale ═══
  console.log('\n═══ ISOLAMENTO (garanzia centrale) ═══');
  bus.reset();
  logging.reset(); logging.configure({ level: 'ERROR', toFile: false });
  var altriRicevuti = [];
  bus.subscribe(bus.EVENTS.DECISION_BLOCKED, 'altro-consumatore', function () { altriRicevuti.push('ok'); });
  measurement.attach(bus, config, logging, { store: store, repo: repo });

  pool.simulateFailure('database irraggiungibile');
  var esploso = false;
  try {
    bus.publish(bus.EVENTS.DECISION_BLOCKED, {
      symbol: 'XAU/USD', setupId: 'S-ISO', direction: 'BUY', blockedBy: 'news',
      gateReason: 'x', entryLo: 4100, sl: 4090, tp1: 4130, quality: null
    });
  } catch (e) { esploso = true; }
  await new Promise(function (r) { setTimeout(r, 30); });

  check('GARANZIA: un errore del database non fa esplodere nulla', esploso === false);
  check('GARANZIA: gli altri consumatori ricevono comunque l\'evento', altriRicevuti.length === 1);
  check('Il blocco resta comunque tracciato su file (il dato non si perde)', !!measurement.getPending('XAU/USD')['S-ISO']);

  console.log('\n' + (fails
    ? '❌ MEASUREMENT LAYER: ' + fails + '/' + total + ' TEST FALLITI'
    : '✅ MEASUREMENT LAYER: TUTTI I ' + total + ' TEST SUPERATI'));
  process.exit(fails ? 1 : 0);
})();
