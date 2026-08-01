// ══════════════════════════════════════════════════════════════════
// TEST — ORARI DI MERCATO
//
// Bug reale segnalato dall'utente: sabato mattina arrivavano notifiche
// "Opportunity Radar" su un mercato fermo da ore.
//
// La garanzia che conta di più: a mercato chiuso NON deve essere
// pubblicato nessun evento di analisi né di notifica.

var fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '✅' : '❌'), name, extra !== undefined ? ('— ' + extra) : '');
  if (!cond) fails++;
}

var mh = require('../modules/marketHours/index.js');

// ═══ CALENDARIO ═══
console.log('\n═══ CALENDARIO (weekend) ═══');
function at(iso) { return Date.parse(iso); }

check('Sabato mattina → CHIUSO (il caso reale segnalato)', mh.isWeekendClosed(at('2026-08-01T09:00:00Z')) === true);
check('Sabato sera → CHIUSO', mh.isWeekendClosed(at('2026-08-01T23:00:00Z')) === true);
check('Venerdì pomeriggio → APERTO', mh.isWeekendClosed(at('2026-07-31T15:00:00Z')) === false);
check('Venerdì 21:00 UTC → ancora APERTO (non chiudiamo troppo presto: in inverno si scambia fino alle 22:00)', mh.isWeekendClosed(at('2026-07-31T21:00:00Z')) === false);
check('Venerdì 22:30 UTC → CHIUSO', mh.isWeekendClosed(at('2026-07-31T22:30:00Z')) === true);
check('Domenica pomeriggio → CHIUSO', mh.isWeekendClosed(at('2026-08-02T15:00:00Z')) === true);
check('Domenica 22:00 UTC → APERTO (riapertura)', mh.isWeekendClosed(at('2026-08-02T22:00:00Z')) === false);
check('Lunedì mattina → APERTO', mh.isWeekendClosed(at('2026-08-03T08:00:00Z')) === false);
check('Mercoledì notte → APERTO (il mercato è attivo 24h nei giorni feriali)', mh.isWeekendClosed(at('2026-08-05T03:00:00Z')) === false);

// ═══ FRESCHEZZA DEI DATI (festività, chiusure impreviste) ═══
console.log('\n═══ FRESCHEZZA DEI DATI ═══');
var mercoledi = at('2026-08-05T12:00:00Z');
check('Candela di 3 minuti fa → mercato attivo', mh.isStale(mercoledi - 3 * 60000, mercoledi) === false);
check('Candela di 10 minuti fa → ancora attivo (un ritardo del fornitore non è una chiusura)', mh.isStale(mercoledi - 10 * 60000, mercoledi) === false);
check('Candela di 3 ore fa in un giorno feriale → mercato FERMO (festività non prevista dal calendario)', mh.isStale(mercoledi - 3 * 3600000, mercoledi) === true);
check('Nessun dato disponibile → NON viene dichiarato chiuso (l\'assenza di dati non è una prova)', mh.isStale(null, mercoledi) === false);

// ═══ VERDETTO COMPLESSIVO, con il motivo ═══
console.log('\n═══ VERDETTO E MOTIVO ═══');
var sab = mh.getMarketState({ now: at('2026-08-01T09:00:00Z'), lastCandleTs: at('2026-07-31T21:55:00Z') });
check('Sabato: chiuso, motivo "weekend"', sab.open === false && sab.reason === 'weekend');
var festivo = mh.getMarketState({ now: mercoledi, lastCandleTs: mercoledi - 4 * 3600000 });
check('Giorno feriale con dati vecchi: chiuso, motivo "stale_data"', festivo.open === false && festivo.reason === 'stale_data');
check('Il messaggio spiega da quanti minuti mancano i dati', /\d+ minuti/.test(festivo.message), festivo.message);
var normale = mh.getMarketState({ now: mercoledi, lastCandleTs: mercoledi - 2 * 60000 });
check('Giorno feriale con dati freschi: aperto', normale.open === true && normale.reason === null);

// ═══ LA GARANZIA CHE CONTA: nessun evento a mercato chiuso ═══
console.log('\n═══ GARANZIA: nessuna analisi né notifica a mercato chiuso ═══');
process.env.TWELVEDATA_API_KEY = 'test-key';
process.env.DATA_DIR = '/tmp/test-markethours-data';
var fs = require('fs');
try { fs.rmSync('/tmp/test-markethours-data', { recursive: true, force: true }); } catch (e) { }

var config = require('../core/config/index.js');
var logging = require('../core/logging/index.js');
var bus = require('../core/events/index.js');
logging.configure({ level: 'ERROR', toFile: false });
config.load();

// Sostituisco Date.now per simulare "è sabato mattina"
var realNow = Date.now;
Date.now = function () { return at('2026-08-01T09:00:00Z'); };

var fetchChiamato = false;
var Module = require('module'), origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../marketData/fetcher.js') {
    return { fetchAllTimeframes: async function () { fetchChiamato = true; return { h4: [], h1: [], m15: [], m5: [] }; } };
  }
  return origRequire.apply(this, arguments);
};

delete require.cache[require.resolve('../modules/orchestrator/scheduler.js')];
var scheduler = require('../modules/orchestrator/scheduler.js');

var eventiPubblicati = [];
bus.reset();
bus.subscribe('*', 'osservatore', function (ev) { eventiPubblicati.push(ev.type); });

(async function run() {
  await scheduler.runCycle('XAU/USD');

  check('GARANZIA: a mercato chiuso NON viene scaricato nulla (nessuna chiamata API sprecata)', fetchChiamato === false);
  check('GARANZIA: viene pubblicato l\'evento "mercato chiuso"', eventiPubblicati.indexOf('cycle.marketClosed') !== -1, eventiPubblicati.join(', '));
  check('GARANZIA CRITICA: nessun evento Opportunity Radar (il bug segnalato)', eventiPubblicati.indexOf('radar.opportunity') === -1);
  check('GARANZIA: nessun evento di setup', !eventiPubblicati.some(function (e) { return e.indexOf('setup.') === 0; }));
  check('GARANZIA: nessun ciclo completato (nessuna analisi eseguita)', eventiPubblicati.indexOf('cycle.completed') === -1);
  check('L\'evento "mercato chiuso" è distinto da quello anti-ricalcolo (situazioni diverse, log distinguibili)',
    bus.EVENTS.CYCLE_MARKET_CLOSED !== bus.EVENTS.CYCLE_SKIPPED);

  var st = scheduler.getStats();
  check('Lo stato del mercato è esposto per dashboard e comando /status', st.lastMarketState && st.lastMarketState.open === false && st.lastMarketState.reason === 'weekend');

  Date.now = realNow;
  Module.prototype.require = origRequire;

  console.log('\n' + (fails
    ? '❌ ORARI DI MERCATO: ' + fails + '/' + total + ' TEST FALLITI'
    : '✅ ORARI DI MERCATO: TUTTI I ' + total + ' TEST SUPERATI'));
  process.exit(fails ? 1 : 0);
})();
