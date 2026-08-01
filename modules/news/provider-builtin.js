// ══════════════════════════════════════════════════════════════════
// PROVIDER INTERNO — nessun fornitore esterno, nessun costo, nessuna
// chiave API.
//
// PERCHÉ ESISTE: Finnhub e FMP tengono il calendario economico dietro
// piani a pagamento (verificato dal vivo: errore 403 da entrambi). Ma
// le date degli eventi che contano davvero sono PUBBLICHE e pubblicate
// in anticipo dagli enti ufficiali americani.
//
// COSA COPRE (e con quale affidabilità — dichiarato onestamente):
//
//   · FOMC → date ESATTE, verificate dal calendario ufficiale della
//     Federal Reserve (federalreserve.gov). Lo statement esce alle
//     14:00 ET del secondo giorno di riunione. È l'evento singolo più
//     importante per l'oro.
//
//   · NFP (Employment Situation) → regola: primo venerdì del mese alle
//     8:30 ET. È la regola standard, ma il BLS occasionalmente sposta
//     la data. Per questo la finestra di blocco è più ampia del solito.
//
//   · CPI, PCE, PPI → NON generati automaticamente. Le loro date non
//     seguono una regola deducibile con certezza (il CPI esce "12-14
//     giorni dopo la fine del mese di riferimento", che non basta per
//     calcolare l'orario esatto). Possono essere aggiunti a mano in
//     customEvents: meglio un evento assente che uno con l'orario
//     sbagliato, che bloccherebbe un trade nel momento sbagliato.
//
// LIMITE DICHIARATO: questo provider non sostituisce un calendario
// professionale a pagamento. Copre l'evento più critico (FOMC) con
// precisione totale e il secondo (NFP) con buona approssimazione.

// Date ufficiali FOMC — secondo giorno di riunione, quando esce lo
// statement alle 14:00 ET. Fonte: federalreserve.gov, calendario 2026.
var FOMC_STATEMENT_DATES = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'
];

// L'ora legale americana sposta la conversione ET→UTC di un'ora:
// 14:00 EDT (estate) = 18:00 UTC · 14:00 EST (inverno) = 19:00 UTC.
// Regola DST USA: dalla seconda domenica di marzo alla prima di novembre.
function isUsDst(year, month, day) {
  if (month > 3 && month < 11) return true;
  if (month < 3 || month > 11) return false;
  // marzo: DST dalla seconda domenica; novembre: fino alla prima domenica
  var d = new Date(Date.UTC(year, month - 1, 1));
  var firstSunday = 1 + ((7 - d.getUTCDay()) % 7);
  if (month === 3) return day >= (firstSunday + 7);
  return day < firstSunday;
}

function etToUtcMs(dateStr, etHour, etMinute) {
  var parts = dateStr.split('-').map(Number);
  var offset = isUsDst(parts[0], parts[1], parts[2]) ? 4 : 5; // EDT=UTC-4, EST=UTC-5
  return Date.UTC(parts[0], parts[1] - 1, parts[2], etHour + offset, etMinute || 0, 0);
}

function buildFomcEvents() {
  return FOMC_STATEMENT_DATES.map(function (d) {
    return {
      id: 'fomc|' + d,
      timestampUtc: etToUtcMs(d, 14, 0),
      currency: 'USD',
      title: 'FOMC Rate Decision',
      impact: 'high',
      actual: null, forecast: null, previous: null,
      source: 'builtin (Federal Reserve, date ufficiali)'
    };
  });
}

// NFP: primo venerdì del mese alle 8:30 ET.
function firstWeekdayOfMonth(year, month, weekday) {
  var d = new Date(Date.UTC(year, month - 1, 1));
  return 1 + ((weekday - d.getUTCDay() + 7) % 7);
}

// N-esimo giorno LAVORATIVO del mese (lunedì-venerdì; non considera le
// festività americane, quindi la data può slittare di un giorno).
function nthBusinessDay(year, month, n) {
  var day = 0, count = 0;
  while (count < n && day < 31) {
    day++;
    var wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (wd !== 0 && wd !== 6) count++;
  }
  return day;
}

function dateStr(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function monthsAhead(now, count) {
  var out = [], start = new Date(now);
  for (var i = 0; i < count; i++) {
    var y = start.getUTCFullYear(), m = start.getUTCMonth() + 1 + i;
    while (m > 12) { m -= 12; y += 1; }
    out.push({ y: y, m: m });
  }
  return out;
}

function buildNfpEvents(now, daysAhead) {
  return monthsAhead(now, 4).map(function (p) {
    var ds = dateStr(p.y, p.m, firstWeekdayOfMonth(p.y, p.m, 5)); // 5 = venerdì
    return {
      id: 'nfp|' + ds,
      timestampUtc: etToUtcMs(ds, 8, 30),
      currency: 'USD',
      title: 'Non-Farm Payrolls (data stimata: primo venerdì del mese)',
      impact: 'high',
      actual: null, forecast: null, previous: null,
      source: 'builtin (regola BLS standard — la data può variare)'
    };
  });
}

// Altri eventi ricorrenti ad alto impatto per il dollaro, con regole di
// pubblicazione documentate:
//   · ISM Manufacturing PMI → primo giorno lavorativo del mese, 10:00 ET
//     (regola dichiarata dall'ISM stesso)
//   · ISM Services PMI → terzo giorno lavorativo del mese, 10:00 ET
//   · ADP Employment → mercoledì della settimana dell'NFP, 8:15 ET
//   · Initial Jobless Claims → ogni giovedì, 8:30 ET
// Tutte marcate come STIMATE: le festività americane possono spostarle.
function buildRecurringEvents(now, daysAhead) {
  var out = [];

  monthsAhead(now, 4).forEach(function (p) {
    var ismM = dateStr(p.y, p.m, nthBusinessDay(p.y, p.m, 1));
    out.push({
      id: 'ism-manu|' + ismM, timestampUtc: etToUtcMs(ismM, 10, 0), currency: 'USD',
      title: 'ISM Manufacturing PMI (data stimata: primo giorno lavorativo)',
      impact: 'high', actual: null, forecast: null, previous: null,
      source: 'builtin (regola ISM — può slittare per festività)'
    });

    var ismS = dateStr(p.y, p.m, nthBusinessDay(p.y, p.m, 3));
    out.push({
      id: 'ism-serv|' + ismS, timestampUtc: etToUtcMs(ismS, 10, 0), currency: 'USD',
      title: 'ISM Services PMI (data stimata: terzo giorno lavorativo)',
      impact: 'high', actual: null, forecast: null, previous: null,
      source: 'builtin (regola ISM — può slittare per festività)'
    });

    // ADP: mercoledì della stessa settimana dell'NFP (2 giorni prima)
    var friday = firstWeekdayOfMonth(p.y, p.m, 5);
    var adpDay = friday - 2;
    if (adpDay >= 1) {
      var adp = dateStr(p.y, p.m, adpDay);
      out.push({
        id: 'adp|' + adp, timestampUtc: etToUtcMs(adp, 8, 15), currency: 'USD',
        title: 'ADP Employment Report (data stimata: mercoledì prima dell\'NFP)',
        impact: 'high', actual: null, forecast: null, previous: null,
        source: 'builtin (regola ADP — può variare)'
      });
    }
  });

  // Jobless Claims: ogni giovedì nell'orizzonte richiesto
  var d = new Date(now);
  var horizon = now + (daysAhead || 30) * 24 * 3600e3;
  var cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  while (cursor <= horizon) {
    var day = new Date(cursor);
    if (day.getUTCDay() === 4) { // giovedì
      var jc = dateStr(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      out.push({
        id: 'claims|' + jc, timestampUtc: etToUtcMs(jc, 8, 30), currency: 'USD',
        title: 'Initial Jobless Claims (settimanale, giovedì)',
        impact: 'high', actual: null, forecast: null, previous: null,
        source: 'builtin (regola DOL settimanale)'
      });
    }
    cursor += 24 * 3600e3;
  }

  return out;
}

// Eventi aggiunti a mano dall'utente, per CPI/PCE/PPI o qualsiasi altro.
// Formato atteso: [{ date: '2026-08-12', etHour: 8, etMinute: 30, title: 'CPI YoY' }]
function buildCustomEvents(customList) {
  return (customList || []).map(function (e) {
    return {
      id: 'custom|' + e.title + '|' + e.date,
      timestampUtc: etToUtcMs(e.date, e.etHour !== undefined ? e.etHour : 8, e.etMinute !== undefined ? e.etMinute : 30),
      currency: e.currency || 'USD',
      title: e.title,
      impact: 'high',
      actual: null, forecast: null, previous: null,
      source: 'builtin (inserito manualmente)'
    };
  });
}

async function fetchEvents(apiKey, now, daysAhead, options) {
  var horizon = now + (daysAhead || 7) * 24 * 3600e3;
  var all = buildFomcEvents()
    .concat(buildNfpEvents(now, daysAhead))
    .concat(buildRecurringEvents(now, daysAhead))
    .concat(buildCustomEvents(options && options.customEvents));

  // solo gli eventi dentro l'orizzonte richiesto, ordinati
  return all
    .filter(function (e) { return e.timestampUtc >= (now - 24 * 3600e3) && e.timestampUtc <= horizon; })
    .sort(function (a, b) { return a.timestampUtc - b.timestampUtc; });
}

module.exports = {
  fetchEvents: fetchEvents,
  buildFomcEvents: buildFomcEvents,
  buildNfpEvents: buildNfpEvents,
  buildRecurringEvents: buildRecurringEvents,
  etToUtcMs: etToUtcMs,
  isUsDst: isUsDst,
  name: 'builtin'
};
