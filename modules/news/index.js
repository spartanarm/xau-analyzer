// ══════════════════════════════════════════════════════════════════
// NEWS ENGINE — le REGOLE, indipendenti dal fornitore dei dati.
//
// Divisione deliberata:
//   · l'ADAPTER (provider-*.js) parla con il fornitore e traduce in un
//     formato interno unico
//   · questo modulo lavora SOLO su quel formato interno
//
// Così cambiare fornitore (Finnhub → Trading Economics) significa
// scrivere un nuovo adapter, senza toccare una riga di queste regole —
// che sono le TUE, non quelle del fornitore.
//
// Formato interno di un evento:
//   { id, timestampUtc, currency, title, impact, actual, forecast, previous }

// Classificazione dell'impatto. Un evento è ad alto impatto se il suo
// titolo contiene una delle parole chiave configurate (FOMC, CPI, NFP...).
// Il confronto è insensibile a maiuscole/minuscole e cerca la parola
// ovunque nel titolo, perché i fornitori scrivono lo stesso evento in
// modi diversi ("Non-Farm Payrolls", "NFP", "Nonfarm Payroll").
function isHighImpact(event, keywords) {
  if (!event || !event.title) return false;
  // se il fornitore dichiara già l'impatto, lo rispettiamo
  if (event.impact && String(event.impact).toLowerCase() === 'high') return true;
  var title = String(event.title).toLowerCase();
  return keywords.some(function (k) { return title.indexOf(String(k).toLowerCase()) !== -1; });
}

// Solo gli eventi che riguardano l'oro: USD (l'oro è quotato in dollari)
// e i grandi eventi globali. Un dato sull'inflazione neozelandese non
// deve bloccare un trade su XAU/USD.
var RELEVANT_CURRENCIES = ['USD', 'US'];

function isRelevantForGold(event) {
  if (!event.currency) return true; // se il fornitore non lo dichiara, non escludiamo
  return RELEVANT_CURRENCIES.indexOf(String(event.currency).toUpperCase()) !== -1;
}

// Filtra gli eventi ad alto impatto rilevanti per l'oro.
function filterHighImpact(events, cfg) {
  var keywords = cfg.highImpactKeywords || [];
  return (events || []).filter(function (e) {
    return isRelevantForGold(e) && isHighImpact(e, keywords);
  });
}

// Verdetto di blocco: siamo dentro la finestra di un evento importante?
// Restituisce SEMPRE il motivo, mai un semplice true/false — serve per
// spiegare all'utente perché un setup valido non è operativo.
function getNewsLock(events, now, cfg) {
  var highImpact = filterHighImpact(events, cfg);
  var before = cfg.lockBeforeMs, after = cfg.lockAfterMs;

  for (var i = 0; i < highImpact.length; i++) {
    var e = highImpact[i];
    var t = e.timestampUtc;
    if (!t) continue;
    if (now >= (t - before) && now <= (t + after)) {
      var minsToEvent = Math.round((t - now) / 60000);
      return {
        locked: true,
        event: e,
        until: t + after,
        reason: minsToEvent > 0
          ? (e.title + ' tra ' + minsToEvent + ' minuti')
          : (e.title + ' (pubblicato ' + Math.abs(minsToEvent) + ' minuti fa)')
      };
    }
  }
  return { locked: false, event: null, until: null, reason: null };
}

// I prossimi eventi importanti, per il comando /news e la dashboard.
function getUpcoming(events, now, cfg, limit) {
  return filterHighImpact(events, cfg)
    .filter(function (e) { return e.timestampUtc && e.timestampUtc > now; })
    .sort(function (a, b) { return a.timestampUtc - b.timestampUtc; })
    .slice(0, limit || 5);
}

module.exports = {
  isHighImpact: isHighImpact,
  isRelevantForGold: isRelevantForGold,
  filterHighImpact: filterHighImpact,
  getNewsLock: getNewsLock,
  getUpcoming: getUpcoming
};
