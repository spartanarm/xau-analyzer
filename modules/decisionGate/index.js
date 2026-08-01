// ══════════════════════════════════════════════════════════════════
// DECISION GATE — compone i verdetti, non ne produce di nuovi.
//
// Risolve una contraddizione che avevamo individuato in fase di
// progetto: il motore deve fare SOLO "esiste un setup tecnico?", il
// Risk Engine non deve influenzare la tecnica, ma il news lock deve
// comunque impedire di operare durante un FOMC.
//
// La soluzione: nessuno dei tre decide da solo. Ognuno produce il
// proprio verdetto in totale indipendenza, e questo modulo li compone.
//
//   Market Engine → "esiste un setup A+ BUY a 4085"   (invariato)
//   News Engine   → "FOMC tra 18 minuti"              (indipendente)
//   Risk Engine   → "esposizione al massimo"          (indipendente)
//                          ↓
//                   DECISION GATE
//                          ↓
//        "SETUP VALIDO ma BLOCCATO — motivo: news lock FOMC"
//
// PRINCIPIO FONDAMENTALE: il gate NON cancella mai un setup. Lo marca
// come bloccato, con il motivo. Così nel database resta la traccia che
// tecnicamente il setup c'era — informazione preziosa per capire, in
// futuro, quanti buoni setup si perdono per il news lock e se la regola
// è troppo severa. Cancellarlo significherebbe distruggere quella prova.

var DECISIONS = {
  NO_SETUP: 'NO_SETUP',                   // il motore non ha trovato nulla
  ACTIONABLE: 'ACTIONABLE',               // setup valido e operativo
  BLOCKED_BY_NEWS: 'BLOCKED_BY_NEWS',     // setup valido, ma news lock attivo
  BLOCKED_BY_RISK: 'BLOCKED_BY_RISK'      // setup valido, ma limiti di rischio
};

// Regole di precedenza: la più severa vince. L'ordine non è casuale —
// una news ad alto impatto è un rischio di mercato che precede qualsiasi
// considerazione di gestione del capitale.
function evaluate(input) {
  var plan = input.plan;
  var newsLock = input.newsLock || { locked: false };
  var riskVerdict = input.riskVerdict || { allowed: true };

  // 1. Nessun setup tecnico: non c'è nulla da bloccare.
  var hasTradeableSetup = plan && plan.action === 'PLAN' && plan.status === 'TRADE_READY';
  if (!hasTradeableSetup) {
    return {
      decision: DECISIONS.NO_SETUP,
      blocked: false,
      blockedBy: null,
      reason: plan ? plan.reason : null,
      newsContext: newsLock.locked ? { locked: true, reason: newsLock.reason } : null
    };
  }

  // 2. News lock: il setup è tecnicamente valido, ma non si opera.
  if (newsLock.locked) {
    return {
      decision: DECISIONS.BLOCKED_BY_NEWS,
      blocked: true,
      blockedBy: 'news',
      reason: 'Setup tecnicamente valido ma BLOCCATO da news ad alto impatto: ' + newsLock.reason,
      newsContext: { locked: true, reason: newsLock.reason, event: newsLock.event, until: newsLock.until }
    };
  }

  // 3. Risk Engine (Fase 6: oggi restituisce sempre allowed).
  if (!riskVerdict.allowed) {
    return {
      decision: DECISIONS.BLOCKED_BY_RISK,
      blocked: true,
      blockedBy: 'risk',
      reason: 'Setup tecnicamente valido ma BLOCCATO dalla gestione del rischio: ' + (riskVerdict.reason || 'limite raggiunto'),
      newsContext: null
    };
  }

  // 4. Tutto libero.
  return {
    decision: DECISIONS.ACTIONABLE,
    blocked: false,
    blockedBy: null,
    reason: plan.reason,
    newsContext: null
  };
}

module.exports = { evaluate: evaluate, DECISIONS: DECISIONS };
