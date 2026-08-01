// ══════════════════════════════════════════════════════════════════
// TEST FASE 6 — Risk Engine
//
// La garanzia più importante: questo modulo NON deve mai influenzare
// la logica tecnica. Calcola solo quanto rischiare e quando fermarsi.

var fails = 0, total = 0;
function check(name, cond, extra) {
  total++;
  console.log((cond ? '✅' : '❌'), name, extra !== undefined ? ('— ' + extra) : '');
  if (!cond) fails++;
}

var risk = require('../modules/riskEngine/index.js');
var gate = require('../modules/decisionGate/index.js');

// Configurazione che rispecchia il conto reale: XM, GOLDm, micro lotti
var BROKER = { contractSize: 10, minLot: 0.10, lotStep: 0.01 };

// ═══ DIMENSIONE POSIZIONE ═══
console.log('\n═══ DIMENSIONE POSIZIONE ═══');

var r1 = risk.computePositionSize(Object.assign({
  accountCapital: 1000, riskPercentPerTrade: 1, entry: 4100, sl: 4090
}, BROKER));
check('1000€, rischio 1%, stop 10$ → 0.10 lotti', r1.valid && r1.lots === 0.10, r1.lots);
check('Il rischio effettivo è esattamente 10 (1% di 1000)', r1.riskAmount === 10);
check('La percentuale reale coincide con quella desiderata', r1.riskPercentActual === 1);

// Stop doppio: servirebbero 0.05 lotti, ma il minimo del broker è 0.10.
// Il modulo RIFIUTA correttamente invece di raddoppiare il rischio.
var r2 = risk.computePositionSize(Object.assign({
  accountCapital: 1000, riskPercentPerTrade: 1, entry: 4100, sl: 4080
}, BROKER));
check('Stop doppio (20$) → servirebbero 0.05 lotti, sotto il minimo del broker', r2.valid === false && r2.lotsRequired === 0.05, r2.lotsRequired);
check('GARANZIA: rifiuta invece di accettare il doppio del rischio previsto', /2% del capitale/.test(r2.reason), r2.reason);

// Con capitale doppio, lo stesso stop torna gestibile
var r2b = risk.computePositionSize(Object.assign({
  accountCapital: 2000, riskPercentPerTrade: 1, entry: 4100, sl: 4080
}, BROKER));
check('Stop 20$ con capitale 2000 → 0.10 lotti, rischio esatto 20 (1%)', r2b.valid && r2b.lots === 0.10 && r2b.riskAmount === 20);

var r3 = risk.computePositionSize(Object.assign({
  accountCapital: 5000, riskPercentPerTrade: 2, entry: 4100, sl: 4095
}, BROKER));
check('5000€, rischio 2%, stop 5$ → 2.00 lotti', r3.valid && r3.lots === 2.00, r3.lots);
check('Rischio 100 (2% di 5000)', r3.riskAmount === 100);

// GARANZIA: arrotondamento sempre per difetto
var r4 = risk.computePositionSize(Object.assign({
  accountCapital: 1000, riskPercentPerTrade: 1, entry: 4100, sl: 4093
}, BROKER));
check('GARANZIA: arrotondamento per DIFETTO (meglio rischiare meno del previsto)',
  r4.valid && r4.riskPercentActual <= 1, r4.lots + ' lotti = ' + r4.riskPercentActual + '%');

// ═══ IL CASO CRITICO: capitale piccolo, lotto minimo troppo grande ═══
console.log('\n═══ CAPITALE PICCOLO (caso reale) ═══');
var rPiccolo = risk.computePositionSize(Object.assign({
  accountCapital: 77, riskPercentPerTrade: 1, entry: 4100, sl: 4090
}, BROKER));
check('GARANZIA CRITICA: con 77€ e stop 10$, il lotto minimo è RIFIUTATO', rPiccolo.valid === false);
check('Il motivo dice esattamente quanto si rischierebbe davvero', /12.99%/.test(rPiccolo.reason), rPiccolo.reason);
check('Espone il rischio reale del lotto minimo (per decidere consapevolmente)',
  rPiccolo.riskAtMinLot === 10 && rPiccolo.riskPercentAtMinLot === 12.99);

// Con uno stop più stretto, lo stesso capitale può bastare
var rStretto = risk.computePositionSize(Object.assign({
  accountCapital: 77, riskPercentPerTrade: 10, entry: 4100, sl: 4099
}, BROKER));
check('Stop stretto (1$) e rischio 10% → operazione possibile anche con 77€', rStretto.valid === true, rStretto.lots + ' lotti');

// ═══ DIMENSIONE CONTRATTO: l'errore da 10 volte ═══
console.log('\n═══ DIMENSIONE CONTRATTO ═══');
var rMicro = risk.computePositionSize({ accountCapital: 1000, riskPercentPerTrade: 1, entry: 4100, sl: 4090, contractSize: 10, minLot: 0.10, lotStep: 0.01 });
var rStandard = risk.computePositionSize({ accountCapital: 1000, riskPercentPerTrade: 1, entry: 4100, sl: 4090, contractSize: 100, minLot: 0.01, lotStep: 0.01 });
check('GARANZIA: contratto da 10 once → 0.10 lotti', rMicro.lots === 0.10);
check('GARANZIA: contratto da 100 once → 0.01 lotti (10 volte meno)', rStandard.lots === 0.01);
check('In entrambi i casi il rischio in denaro è identico (10)', rMicro.riskAmount === 10 && rStandard.riskAmount === 10);

// ═══ CASI LIMITE ═══
console.log('\n═══ CASI LIMITE ═══');
check('Capitale non configurato → rifiutato con motivo', risk.computePositionSize(Object.assign({ accountCapital: null, riskPercentPerTrade: 1, entry: 4100, sl: 4090 }, BROKER)).valid === false);
check('Entry o SL mancanti → rifiutato (mai un calcolo su dati assenti)', risk.computePositionSize(Object.assign({ accountCapital: 1000, riskPercentPerTrade: 1, entry: 4100, sl: null }, BROKER)).valid === false);
check('Stop a distanza zero → rifiutato (mai una divisione per zero)', risk.computePositionSize(Object.assign({ accountCapital: 1000, riskPercentPerTrade: 1, entry: 4100, sl: 4100 }, BROKER)).valid === false);

// ═══ LIMITI GIORNALIERI ═══
console.log('\n═══ LIMITI GIORNALIERI ═══');
var CFG = { enabled: true, accountCapital: 1000, riskPercentPerTrade: 1, maxOpenPositions: 1, maxDailyLossPercent: 3, maxDailyTrades: 5, contractSize: 10, minLot: 0.10, lotStep: 0.01 };

check('Nessun trade oggi → consentito', risk.checkDailyLimits({ config: CFG, todayTrades: [], openPositions: 0 }).allowed === true);
check('Posizione già aperta → bloccato', risk.checkDailyLimits({ config: CFG, todayTrades: [], openPositions: 1 }).allowed === false);

var cinqueTrade = [{ pnlR: 1 }, { pnlR: -1 }, { pnlR: 0.5 }, { pnlR: -0.5 }, { pnlR: 1 }];
check('5 trade oggi (limite raggiunto) → bloccato', risk.checkDailyLimits({ config: CFG, todayTrades: cinqueTrade, openPositions: 0 }).allowed === false);

var treP = [{ pnlR: -1 }, { pnlR: -1 }, { pnlR: -1 }];
var lim = risk.checkDailyLimits({ config: CFG, todayTrades: treP, openPositions: 0 });
check('GARANZIA: -3R con rischio 1% = -3% → limite di perdita raggiunto, BLOCCATO', lim.allowed === false);
check('Il motivo indica la perdita reale', /3%/.test(lim.reason), lim.reason);

var dueP = [{ pnlR: -1 }, { pnlR: -1 }];
check('-2R (sotto il limite) → ancora consentito', risk.checkDailyLimits({ config: CFG, todayTrades: dueP, openPositions: 0 }).allowed === true);

var misto = [{ pnlR: -2 }, { pnlR: 3 }];
check('GARANZIA: i profitti compensano le perdite (+1R netto → consentito)', risk.checkDailyLimits({ config: CFG, todayTrades: misto, openPositions: 0 }).allowed === true);

// ═══ INTEGRAZIONE COL DECISION GATE ═══
console.log('\n═══ INTEGRAZIONE COL DECISION GATE ═══');
var piano = { action: 'PLAN', status: 'TRADE_READY', direction: 'BUY', entryLo: 4100, sl: 4090, reason: 'Setup A+' };

var vOk = risk.evaluate({ config: CFG, entry: 4100, sl: 4090, openPositions: 0, todayTrades: [] });
check('Risk Engine autorizza quando tutto è in regola', vOk.allowed === true);
check('E fornisce i lotti calcolati', vOk.sizing && vOk.sizing.lots === 0.10);

var gOk = gate.evaluate({ plan: piano, newsLock: { locked: false }, riskVerdict: vOk });
check('Il Decision Gate lascia passare → ACTIONABLE', gOk.decision === gate.DECISIONS.ACTIONABLE);

var vNo = risk.evaluate({ config: CFG, entry: 4100, sl: 4090, openPositions: 0, todayTrades: treP });
var gNo = gate.evaluate({ plan: piano, newsLock: { locked: false }, riskVerdict: vNo });
check('Limite di perdita superato → il gate BLOCCA', gNo.decision === gate.DECISIONS.BLOCKED_BY_RISK);
check('Il motivo arriva fino all\'utente', /perdita giornaliera/.test(gNo.reason), gNo.reason);

// GARANZIA CENTRALE: il Risk Engine non tocca la tecnica
var pianoPrima = JSON.stringify(piano);
risk.evaluate({ config: CFG, entry: piano.entryLo, sl: piano.sl, openPositions: 0, todayTrades: [] });
check('GARANZIA CENTRALE: il Risk Engine NON modifica il piano tecnico', JSON.stringify(piano) === pianoPrima);

// GARANZIA: news batte rischio
var vRisk = risk.evaluate({ config: CFG, entry: 4100, sl: 4090, openPositions: 0, todayTrades: treP });
var gEntrambi = gate.evaluate({ plan: piano, newsLock: { locked: true, reason: 'FOMC tra 10 minuti' }, riskVerdict: vRisk });
check('Se news e rischio bloccano insieme, vince la news (precedenza confermata)', gEntrambi.blockedBy === 'news');

// ═══ DISATTIVATO DI DEFAULT ═══
console.log('\n═══ DISATTIVATO ═══');
var vOff = risk.evaluate({ config: { enabled: false }, entry: 4100, sl: 4090 });
check('Risk Engine disattivato → lascia passare tutto (comportamento invariato)', vOff.allowed === true && vOff.disabled === true);
check('Nessun calcolo di lotti quando è spento', vOff.sizing === null);

console.log('\n' + (fails
  ? '❌ FASE 6: ' + fails + '/' + total + ' TEST FALLITI'
  : '✅ FASE 6: TUTTI I ' + total + ' TEST SUPERATI'));
process.exit(fails ? 1 : 0);
