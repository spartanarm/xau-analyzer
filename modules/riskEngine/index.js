// ══════════════════════════════════════════════════════════════════
// RISK ENGINE — COMPLETAMENTE separato dal motore decisionale.
//
// Il motore risponde a una sola domanda: "esiste un setup tecnico?"
// Questo modulo risponde a domande completamente diverse:
//   · quanti lotti aprire per rischiare esattamente X€?
//   · ho già perso troppo oggi?
//   · ho già troppe posizioni aperte?
//
// NON guarda MAI bias, struttura, zone, qualità del setup. Non sa
// nemmeno cosa sia un BOS. Riceve due soli numeri dal piano — il prezzo
// di ingresso e quello dello stop — e da lì calcola tutto il resto.
//
// DIMENSIONE POSIZIONE, la formula:
//   rischio in denaro = capitale × percentuale di rischio
//   distanza stop     = |entry − SL|  (in dollari per oncia)
//   lotti             = rischio in denaro / (distanza stop × dimensione contratto)
//
// Per XAU/USD un lotto standard è 100 once: se lo stop dista 10$ e apri
// 1 lotto, rischi 1000$. Il broker XM con GOLDm usa lotti da 10 once
// (micro), quindi la dimensione del contratto è configurabile — mai
// data per scontata, perché sbagliarla significa rischiare 10 volte
// tanto senza accorgersene.

function round2(n) { return Math.round(n * 100) / 100; }

// Calcolo della dimensione della posizione.
function computePositionSize(input) {
  var capital = input.accountCapital;
  var riskPercent = input.riskPercentPerTrade;
  var entry = input.entry;
  var sl = input.sl;
  var contractSize = input.contractSize;   // once per lotto
  var minLot = input.minLot;
  var lotStep = input.lotStep;

  if (!(capital > 0)) return { valid: false, reason: 'capitale non configurato' };
  if (!(riskPercent > 0)) return { valid: false, reason: 'percentuale di rischio non valida' };
  if (entry === null || sl === null || entry === undefined || sl === undefined) {
    return { valid: false, reason: 'entry o stop loss non disponibili nel piano' };
  }

  var stopDistance = Math.abs(entry - sl);
  if (!(stopDistance > 0)) return { valid: false, reason: 'distanza dello stop nulla' };

  var riskAmount = capital * (riskPercent / 100);
  var valuePerLot = stopDistance * contractSize;   // perdita in valuta se salta lo stop, per 1 lotto
  var rawLots = riskAmount / valuePerLot;

  // Arrotondamento SEMPRE per difetto al passo del broker: meglio
  // rischiare un po' meno del previsto che un po' di più.
  var lots = Math.floor(rawLots / lotStep) * lotStep;
  lots = round2(lots);

  if (lots < minLot) {
    // Caso reale e importante: con un capitale piccolo e uno stop largo,
    // il lotto minimo del broker comporta un rischio SUPERIORE a quello
    // desiderato. Va detto esplicitamente, non nascosto.
    var riskAtMinLot = minLot * valuePerLot;
    var riskPercentAtMinLot = (riskAtMinLot / capital) * 100;
    return {
      valid: false,
      reason: 'il lotto minimo del broker (' + minLot + ') comporterebbe un rischio di ' +
        round2(riskAtMinLot) + ' (' + round2(riskPercentAtMinLot) + '% del capitale), superiore al ' +
        riskPercent + '% desiderato',
      lotsRequired: round2(rawLots),
      minLot: minLot,
      riskAtMinLot: round2(riskAtMinLot),
      riskPercentAtMinLot: round2(riskPercentAtMinLot)
    };
  }

  return {
    valid: true,
    lots: lots,
    riskAmount: round2(lots * valuePerLot),
    riskPercentActual: round2(((lots * valuePerLot) / capital) * 100),
    stopDistance: round2(stopDistance),
    valuePerLot: round2(valuePerLot)
  };
}

// Limiti giornalieri: si basano sui trade REALMENTE chiusi oggi, presi
// dal Position Tracker/database — mai su stime.
function checkDailyLimits(input) {
  var cfg = input.config;
  var todayTrades = input.todayTrades || [];   // [{ pnlR, closedAt }]
  var openPositions = input.openPositions || 0;
  var capital = input.accountCapital;

  if (openPositions >= cfg.maxOpenPositions) {
    return { allowed: false, reason: 'numero massimo di posizioni aperte raggiunto (' + cfg.maxOpenPositions + ')' };
  }

  if (todayTrades.length >= cfg.maxDailyTrades) {
    return { allowed: false, reason: 'numero massimo di trade giornalieri raggiunto (' + cfg.maxDailyTrades + ')' };
  }

  // Perdita giornaliera: sommiamo le R negative e le convertiamo in
  // percentuale del capitale usando il rischio per trade configurato.
  // Esempio: -2R con rischio 1% per trade = -2% del capitale.
  var totalR = todayTrades.reduce(function (s, t) { return s + (Number(t.pnlR) || 0); }, 0);
  var lossPercent = totalR < 0 ? Math.abs(totalR) * cfg.riskPercentPerTrade : 0;

  if (lossPercent >= cfg.maxDailyLossPercent) {
    return {
      allowed: false,
      reason: 'limite di perdita giornaliera raggiunto: ' + round2(lossPercent) + '% (massimo ' + cfg.maxDailyLossPercent + '%)',
      lossPercent: round2(lossPercent),
      totalR: round2(totalR)
    };
  }

  return {
    allowed: true,
    tradesToday: todayTrades.length,
    totalR: round2(totalR),
    lossPercent: round2(lossPercent)
  };
}

// Verdetto complessivo: è il punto che il Decision Gate interroga.
function evaluate(input) {
  var cfg = input.config;
  if (!cfg.enabled) return { allowed: true, reason: null, sizing: null, disabled: true };

  var limits = checkDailyLimits({
    config: cfg, todayTrades: input.todayTrades,
    openPositions: input.openPositions, accountCapital: cfg.accountCapital
  });
  if (!limits.allowed) return { allowed: false, reason: limits.reason, sizing: null, limits: limits };

  var sizing = computePositionSize({
    accountCapital: cfg.accountCapital,
    riskPercentPerTrade: cfg.riskPercentPerTrade,
    entry: input.entry, sl: input.sl,
    contractSize: cfg.contractSize, minLot: cfg.minLot, lotStep: cfg.lotStep
  });

  if (!sizing.valid) {
    return { allowed: false, reason: sizing.reason, sizing: sizing, limits: limits };
  }

  return { allowed: true, reason: null, sizing: sizing, limits: limits };
}

module.exports = {
  evaluate: evaluate,
  computePositionSize: computePositionSize,
  checkDailyLimits: checkDailyLimits
};
