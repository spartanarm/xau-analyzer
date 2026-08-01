// ══════════════════════════════════════════════════════════════════
// TEST FASE 5 — News Engine + Decision Gate
//
// Le garanzie che contano:
//   1. Il motore NON viene mai toccato: il gate compone, non ricalcola
//   2. Un setup bloccato viene MARCATO, mai cancellato (serve la prova
//      storica di quanti buoni setup si perdono per il news lock)
//   3. Un fornitore news irraggiungibile non blocca l'analisi tecnica

var fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '✅' : '❌'), name, extra !== undefined ? ('— ' + extra) : '');
  if (!cond) fails++;
}

var newsEngine = require('../modules/news/index.js');
var gate = require('../modules/decisionGate/index.js');
var finnhub = require('../modules/news/provider-finnhub.js');

var NEWS_CFG = {
  highImpactKeywords: ['FOMC', 'CPI', 'NFP', 'Non-Farm', 'PPI', 'PCE', 'Powell', 'ADP', 'ISM', 'PMI', 'GDP', 'Jobless Claims', 'Retail Sales'],
  lockBeforeMs: 30 * 60 * 1000,
  lockAfterMs: 15 * 60 * 1000
};

// ═══ CLASSIFICAZIONE IMPATTO ═══
console.log('\n═══ CLASSIFICAZIONE IMPATTO ═══');
check('FOMC riconosciuto come alto impatto', newsEngine.isHighImpact({ title: 'FOMC Rate Decision' }, NEWS_CFG.highImpactKeywords));
check('CPI riconosciuto', newsEngine.isHighImpact({ title: 'CPI YoY' }, NEWS_CFG.highImpactKeywords));
check('Non-Farm Payrolls riconosciuto (scritto per esteso)', newsEngine.isHighImpact({ title: 'Non-Farm Payrolls' }, NEWS_CFG.highImpactKeywords));
check('Powell riconosciuto', newsEngine.isHighImpact({ title: 'Fed Chair Powell Speech' }, NEWS_CFG.highImpactKeywords));
check('Jobless Claims riconosciuto', newsEngine.isHighImpact({ title: 'Initial Jobless Claims' }, NEWS_CFG.highImpactKeywords));
check('Un evento minore NON è alto impatto', newsEngine.isHighImpact({ title: 'Redbook Index' }, NEWS_CFG.highImpactKeywords) === false);
check('Se il fornitore dichiara impact=high, viene rispettato anche senza parola chiave', newsEngine.isHighImpact({ title: 'Evento Sconosciuto', impact: 'high' }, NEWS_CFG.highImpactKeywords));

console.log('\n═══ RILEVANZA PER L\'ORO ═══');
check('Evento USD è rilevante', newsEngine.isRelevantForGold({ currency: 'USD' }));
check('Evento neozelandese NON è rilevante per XAU/USD', newsEngine.isRelevantForGold({ currency: 'NZD' }) === false);
check('Se la valuta non è dichiarata, non escludiamo (prudenza)', newsEngine.isRelevantForGold({ currency: null }));

// ═══ FINESTRE DI BLOCCO ═══
console.log('\n═══ FINESTRE DI BLOCCO ═══');
var now = Date.parse('2026-08-05T12:00:00Z');
var eventi = [
  { id: 'e1', title: 'FOMC Rate Decision', currency: 'USD', timestampUtc: Date.parse('2026-08-05T12:20:00Z') },
  { id: 'e2', title: 'Redbook Index', currency: 'USD', timestampUtc: Date.parse('2026-08-05T12:05:00Z') }
];

var lock = newsEngine.getNewsLock(eventi, now, NEWS_CFG);
check('FOMC tra 20 minuti → LOCK ATTIVO', lock.locked === true);
check('Il motivo spiega quale evento e tra quanto', /FOMC.*20 minuti/.test(lock.reason), lock.reason);
check('Un evento minore tra 5 minuti NON blocca', newsEngine.getNewsLock([eventi[1]], now, NEWS_CFG).locked === false);

var dopoEvento = Date.parse('2026-08-05T12:30:00Z'); // 10 min dopo il FOMC
check('10 minuti DOPO il FOMC → ancora bloccato (la volatilità continua)', newsEngine.getNewsLock(eventi, dopoEvento, NEWS_CFG).locked === true);
var benDopo = Date.parse('2026-08-05T12:40:00Z'); // 20 min dopo, oltre lockAfterMs
check('20 minuti dopo → sbloccato', newsEngine.getNewsLock(eventi, benDopo, NEWS_CFG).locked === false);
var benPrima = Date.parse('2026-08-05T11:00:00Z'); // 80 min prima
check('80 minuti prima → non ancora bloccato', newsEngine.getNewsLock(eventi, benPrima, NEWS_CFG).locked === false);
check('Nessun evento in calendario → nessun blocco', newsEngine.getNewsLock([], now, NEWS_CFG).locked === false);

// ═══ DECISION GATE — le garanzie fondamentali ═══
console.log('\n═══ DECISION GATE ═══');
var pianoValido = { action: 'PLAN', status: 'TRADE_READY', direction: 'BUY', reason: 'Setup A+ confermato', entryLo: 4100, sl: 4090, tp1: 4130 };
var pianoAssente = { action: 'NO_TRADE', status: 'WATCHING', reason: 'Nessuna zona operativa' };

var v1 = gate.evaluate({ plan: pianoValido, newsLock: { locked: false }, riskVerdict: { allowed: true } });
check('Setup valido + tutto libero → ACTIONABLE', v1.decision === gate.DECISIONS.ACTIONABLE && v1.blocked === false);

var v2 = gate.evaluate({ plan: pianoValido, newsLock: lock, riskVerdict: { allowed: true } });
check('Setup valido + news lock → BLOCCATO da news', v2.decision === gate.DECISIONS.BLOCKED_BY_NEWS && v2.blocked === true);
check('GARANZIA: il motivo dice chiaramente che il setup è VALIDO ma bloccato (non "non c\'è setup")',
  /tecnicamente valido/.test(v2.reason) && /FOMC/.test(v2.reason), v2.reason);
check('GARANZIA: il contesto news è conservato (per il database e le statistiche future)', v2.newsContext && v2.newsContext.locked === true);

var v3 = gate.evaluate({ plan: pianoValido, newsLock: { locked: false }, riskVerdict: { allowed: false, reason: 'esposizione massima' } });
check('Setup valido + rischio nega → BLOCCATO da rischio', v3.decision === gate.DECISIONS.BLOCKED_BY_RISK);

var v4 = gate.evaluate({ plan: pianoAssente, newsLock: lock, riskVerdict: { allowed: true } });
check('Nessun setup tecnico → NO_SETUP (non "bloccato": non c\'era nulla da bloccare)', v4.decision === gate.DECISIONS.NO_SETUP && v4.blocked === false);
check('Ma il contesto news viene comunque registrato', v4.newsContext && v4.newsContext.locked === true);

// PRECEDENZA: se news e rischio bloccano insieme, vince la news
var v5 = gate.evaluate({ plan: pianoValido, newsLock: lock, riskVerdict: { allowed: false, reason: 'x' } });
check('Precedenza: news batte rischio (una news è un rischio di mercato, precede la gestione capitale)', v5.blockedBy === 'news');

// GARANZIA CENTRALE: il gate non altera MAI il piano del motore
var pianoOriginale = JSON.stringify(pianoValido);
gate.evaluate({ plan: pianoValido, newsLock: lock, riskVerdict: { allowed: false } });
check('GARANZIA CENTRALE: il gate NON modifica il piano prodotto dal motore', JSON.stringify(pianoValido) === pianoOriginale);

// ═══ ADAPTER: traduzione nel formato interno ═══
console.log('\n═══ ADAPTER FINNHUB ═══');
var rawFinnhub = {
  economicCalendar: [
    { country: 'US', event: 'CPI YoY', time: '2026-08-05 12:30:00', impact: 'high', actual: null, estimate: 2.4, prev: 2.6 },
    { country: 'US', event: 'Redbook', time: '2026-08-05 13:55:00', impact: 'low' },
    { country: 'JP', event: 'Something', time: 'data-non-valida' }
  ]
};
var normalizzati = finnhub.normalize(rawFinnhub);
check('Traduce nel formato interno', normalizzati.length === 2, normalizzati.length + ' eventi validi su 3');
check('Il timestamp è convertito correttamente in UTC', normalizzati[0].timestampUtc === Date.parse('2026-08-05T12:30:00Z'));
check('Gli eventi con data non valida vengono scartati (mai un timestamp inventato)', !normalizzati.some(function (e) { return e.timestampUtc === null; }));
check('I campi previsione/precedente sono mappati', normalizzati[0].forecast === 2.4 && normalizzati[0].previous === 2.6);
check('Gli eventi tradotti funzionano col News Engine (formato compatibile)',
  newsEngine.getNewsLock(normalizzati, Date.parse('2026-08-05T12:15:00Z'), NEWS_CFG).locked === true);

// ═══ ADAPTER FMP (scritto in modo difensivo: i nomi esatti dei campi
// non erano verificabili dalla documentazione) ═══
console.log('\n═══ ADAPTER FMP ═══');
var fmp = require('../modules/news/provider-fmp.js');

var fmpStandard = fmp.normalize([
  { date: '2026-08-05 12:30:00', country: 'US', currency: 'USD', event: 'CPI YoY', impact: 'High', estimate: 2.4, previous: 2.6 }
]);
check('Formato documentato: tradotto correttamente', fmpStandard.length === 1 && fmpStandard[0].timestampUtc === Date.parse('2026-08-05T12:30:00Z'));
check('Impatto e previsione mappati', fmpStandard[0].impact === 'High' && fmpStandard[0].forecast === 2.4);

var fmpAlt = fmp.normalize([
  { time: '2026-08-05T14:00:00Z', currency: 'USD', name: 'FOMC Rate Decision', importance: 'high', forecast: 1, prev: 2 }
]);
check('GARANZIA: nomi di campo alternativi funzionano lo stesso (adapter tollerante)', fmpAlt.length === 1 && fmpAlt[0].title === 'FOMC Rate Decision');

var fmpSporco = fmp.normalize([
  { date: 'data-non-valida', event: 'Evento senza orario' },
  { date: '2026-08-05 10:00:00', event: 'Evento valido' },
  { date: '2026-08-05 11:00:00' }
]);
check('GARANZIA: un evento senza orario valido viene SCARTATO (mai un orario inventato)', fmpSporco.length === 1 && fmpSporco[0].title === 'Evento valido');

check('Gli eventi FMP funzionano col News Engine (formato compatibile)',
  newsEngine.getNewsLock(fmpAlt, Date.parse('2026-08-05T13:45:00Z'), NEWS_CFG).locked === true);

// ═══ ISOLAMENTO: un fornitore news rotto non blocca l'analisi ═══
console.log('\n═══ ISOLAMENTO ═══');
process.env.TWELVEDATA_API_KEY = 'test';
process.env.DATA_DIR = '/tmp/test-phase5-data';
process.env.NEWS_PROVIDER = 'finnhub';
process.env.NEWS_API_KEY = 'fake';
var fs = require('fs');
try { fs.rmSync('/tmp/test-phase5-data', { recursive: true, force: true }); } catch (e) { }

var config = require('../core/config/index.js');
var logging = require('../core/logging/index.js');
logging.configure({ level: 'ERROR', toFile: false });
config.load();
var newsScheduler = require('../modules/news/scheduler.js');

(async function run() {
  var esploso = false;
  var risultato;
  try {
    risultato = await newsScheduler.refresh(function () { return Promise.reject(new Error('fornitore news irraggiungibile')); });
  } catch (e) { esploso = true; }

  check('GARANZIA: un fornitore news irraggiungibile non fa esplodere nulla', esploso === false);
  check('L\'errore viene registrato e restituito, non ingoiato', risultato && risultato.error);

  // il gate senza news deve comportarsi come se non ci fosse blocco
  var senzaNews = gate.evaluate({ plan: pianoValido, newsLock: { locked: false }, riskVerdict: { allowed: true } });
  check('GARANZIA: senza dati news, un setup valido resta operativo (non blocchiamo per ignoranza)', senzaNews.decision === gate.DECISIONS.ACTIONABLE);

  console.log('\n' + (fails
    ? '❌ FASE 5: ' + fails + '/' + total + ' TEST FALLITI'
    : '✅ FASE 5: TUTTI I ' + total + ' TEST SUPERATI'));
  process.exit(fails ? 1 : 0);
})();
