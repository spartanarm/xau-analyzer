// ══════════════════════════════════════════════════════════════════
// ORARI DI MERCATO — il motore deve sapere quando il mercato è chiuso.
//
// PROBLEMA REALE (osservato dal vivo): il sabato mattina arrivavano
// notifiche "Opportunity Radar" su un mercato fermo da ore. Analisi
// inutili, notifiche fuorvianti, e chiamate API sprecate.
//
// DUE GUARDIE, deliberatamente diverse e complementari:
//
//   1. CALENDARIO (weekend) — l'oro chiude venerdì sera e riapre
//      domenica sera. Questa guardia evita di sprecare chiamate API nel
//      fine settimana: se il mercato è certamente chiuso, non chiediamo
//      nemmeno i dati. Importante dato il limite di 800 richieste/giorno.
//
//   2. FRESCHEZZA DEI DATI — se l'ultima candela M5 disponibile è
//      vecchia di ore, il mercato è fermo, punto. Questa guardia è
//      AUTO-ADATTANTE: gestisce da sola le festività, il cambio di ora
//      legale, e le chiusure specifiche del broker, senza che nessuno
//      debba aggiornare un calendario a mano.
//
// La seconda è la più importante: il calendario può sbagliare (festività
// non previste, ora legale), i dati no. Se le candele non arrivano, il
// mercato non sta scambiando — qualunque cosa dica il calendario.
//
// ORARI DI RIFERIMENTO (fonte: specifiche di mercato XAU/USD spot):
//   apertura domenica ~22:00 UTC · chiusura venerdì ~21:00-22:00 UTC
// L'ora esatta slitta di un'ora tra estate e inverno per l'ora legale
// americana. Uso i limiti PIÙ PRUDENTI per non dichiarare "chiuso" un
// mercato che è ancora aperto: meglio un ciclo in più che un segnale perso.

var DEFAULTS = {
  // Venerdì: chiudiamo alle 22:00 UTC (il più tardi possibile tra
  // estate e inverno) per non perdere l'ultima ora di contrattazioni.
  fridayCloseUtcHour: 22,
  // Domenica: riapriamo alle 22:00 UTC. Prima di quell'ora il mercato è
  // certamente fermo in entrambi i regimi di ora legale.
  sundayOpenUtcHour: 22,
  // Se l'ultima candela M5 è più vecchia di questo, il mercato è fermo
  // indipendentemente dal calendario (festività, chiusure impreviste).
  // 30 minuti: ampio margine sopra i 5 minuti di una candela normale,
  // così un semplice ritardo del fornitore dati non viene scambiato per
  // una chiusura di mercato.
  maxCandleAgeMs: 30 * 60 * 1000
};

// Guardia 1: calendario. Restituisce true se siamo nel fine settimana.
function isWeekendClosed(now, cfg) {
  var c = cfg || DEFAULTS;
  var d = new Date(now);
  var day = d.getUTCDay();       // 0 = domenica, 5 = venerdì, 6 = sabato
  var hour = d.getUTCHours();

  if (day === 6) return true;                                   // sabato: sempre chiuso
  if (day === 5 && hour >= c.fridayCloseUtcHour) return true;   // venerdì sera
  if (day === 0 && hour < c.sundayOpenUtcHour) return true;     // domenica fino a sera
  return false;
}

// Guardia 2: freschezza dei dati. Restituisce true se le candele sono
// troppo vecchie perché il mercato possa essere attivo.
function isStale(lastCandleTs, now, cfg) {
  var c = cfg || DEFAULTS;
  if (lastCandleTs === null || lastCandleTs === undefined) return false; // nessun dato: non è una prova di chiusura
  return (now - lastCandleTs) > c.maxCandleAgeMs;
}

// Verdetto complessivo, con il MOTIVO — mai un semplice true/false:
// serve sapere perché, sia per i log sia per la dashboard.
function getMarketState(opts) {
  var now = opts.now;
  var cfg = opts.config || DEFAULTS;

  if (isWeekendClosed(now, cfg)) {
    return { open: false, reason: 'weekend', message: 'Mercato chiuso (fine settimana)' };
  }
  if (isStale(opts.lastCandleTs, now, cfg)) {
    var ageMin = Math.floor((now - opts.lastCandleTs) / 60000);
    return {
      open: false, reason: 'stale_data',
      message: 'Mercato fermo: nessuna candela nuova da ' + ageMin + ' minuti (festività o chiusura non prevista dal calendario)'
    };
  }
  return { open: true, reason: null, message: 'Mercato aperto' };
}

module.exports = {
  getMarketState: getMarketState,
  isWeekendClosed: isWeekendClosed,
  isStale: isStale,
  DEFAULTS: DEFAULTS
};
