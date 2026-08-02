// ══════════════════════════════════════════════════════════════════
// COMANDI TELEGRAM — ognuno legge da una fonte già esistente e
// testata (scheduler, snapshot, Position Tracker, database). Nessuna
// nuova logica di calcolo: solo formattazione di dati già prodotti.

function fmt(n, d) { return (n === null || n === undefined) ? 'n.d.' : Number(n).toFixed(d !== undefined ? d : 2); }
function fmtPct(n) { return (n === null || n === undefined) ? 'n.d.' : Number(n).toFixed(1) + '%'; }
function fmtDate(ms) { return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'n.d.'; }
function fmtDur(ms) {
  var min = Math.floor(ms / 60000);
  if (min < 60) return min + ' min';
  var h = Math.floor(min / 60);
  if (h < 24) return h + 'h ' + (min % 60) + 'm';
  return Math.floor(h / 24) + 'g ' + (h % 24) + 'h';
}

async function cmdStatus(ctx) {
  var st = ctx.scheduler.getStats();
  var dbHealth = ctx.config.get().database.enabled ? await ctx.database.health() : { connected: false, reason: 'non configurato' };
  var snap = ctx.store.load('latest_snapshot', null);
  var ageMs = snap ? (Date.now() - snap.generatedAt) : null;

  var mkt = st.lastMarketState;
  var mktLine = mkt
    ? (mkt.open ? '🟢 Mercato aperto' : '🔴 Mercato chiuso' + (mkt.reason === 'weekend' ? ' (fine settimana)' : ' (nessun dato nuovo)'))
    : 'Mercato: non ancora valutato';

  return '📊 <b>Stato del servizio</b>\n' +
    mktLine + '\n' +
    'Uptime: ' + fmtDur(st.uptimeMs) + '\n' +
    'Cicli: ' + st.cyclesRun + ' completati, ' + st.cyclesSkipped + ' saltati, ' + st.cyclesFailed + ' falliti\n' +
    'Ultima analisi: ' + (ageMs !== null ? Math.floor(ageMs / 60000) + ' min fa' : 'nessuna ancora') + '\n' +
    'Database: ' + (dbHealth.connected ? 'connesso ✅' : 'non connesso ⚠️ (' + dbHealth.reason + ')') + '\n' +
    (st.lastError ? ('Ultimo errore: ' + st.lastError.message) : 'Nessun errore recente');
}

function cmdMarket(ctx) {
  var snap = ctx.store.load('latest_snapshot', null);
  if (!snap) return '📈 Nessuna analisi ancora disponibile.';
  var p = snap.plan;
  return '📈 <b>' + snap.symbol + '</b>\n' +
    'Prezzo: ' + fmt(snap.price) + '\n' +
    'Bias: ' + snap.bias.bias + '\n' +
    'ATR H1: ' + fmt(snap.atr.h1) + ' · ATR M15: ' + fmt(snap.atr.m15) + '\n' +
    'Stato piano: ' + p.status + ' (' + (p.executionMode || 'NO TRADE') + ')\n' +
    'Aggiornato: ' + fmtDate(snap.generatedAt);
}

function cmdSetup(ctx) {
  var snap = ctx.store.load('latest_snapshot', null);
  if (!snap) return '🔎 Nessun setup ancora disponibile.';
  var p = snap.plan;
  if (p.status === 'WATCHING' || !p.direction) return '🔎 Nessun setup attivo al momento.\n' + (p.reason || '');
  var lines = ['🔎 <b>Setup ' + p.direction + '</b>', 'Modalità: ' + (p.executionMode || 'n.d.') + ' (' + (p.orderType || 'n.d.') + ')', 'Stato: ' + p.status];
  if (p.quality) lines.push('Qualità: ' + (p.quality.grade || '—') + ' · Confidence ' + p.quality.confidence + '/100');
  if (p.entryLo !== null && p.entryLo !== undefined) lines.push('Entry: ' + fmt(p.entryLo) + (p.entryHi ? ('–' + fmt(p.entryHi)) : ''));
  if (p.sl !== null && p.sl !== undefined) lines.push('SL: ' + fmt(p.sl));
  if (p.tp1 !== null && p.tp1 !== undefined) lines.push('TP1: ' + fmt(p.tp1));
  if (p.tp2 !== null && p.tp2 !== undefined) lines.push('TP2: ' + fmt(p.tp2) + ' (informativo)');
  if (p.reason) lines.push('\n' + p.reason);
  return lines.join('\n');
}

function cmdOpen(ctx, symbol) {
  var pos = ctx.positionTracker.getOpenPosition(symbol);
  if (!pos) return '📭 Nessuna posizione aperta al momento.';
  return '📬 <b>Posizione aperta — ' + pos.direction + '</b>\n' +
    'Entry: ' + fmt(pos.entryPrice) + ' · SL: ' + fmt(pos.sl) + ' · TP1: ' + fmt(pos.tp1) +
    (pos.tp2 ? (' · TP2: ' + fmt(pos.tp2) + ' (informativo)') : '') + '\n' +
    'Aperta: ' + fmtDate(pos.openedAt) + ' (' + fmtDur(Date.now() - pos.openedAt) + ' fa)';
}

async function cmdHistory(ctx, symbol) {
  if (!ctx.config.get().database.enabled) return '📜 Cronologia non disponibile: il database non è collegato.';
  var rows = await ctx.repo.getRecentClosedPositions(symbol, 10);
  if (!rows.length) return '📜 Nessun trade concluso ancora nello storico.';
  var lines = rows.map(function (r) {
    var icon = r.exit_reason === 'TP1' ? '🎯' : '❌';
    return icon + ' ' + r.direction + ' · ' + (r.pnl_r !== null ? (Number(r.pnl_r) >= 0 ? '+' : '') + fmt(r.pnl_r) + 'R' : 'n.d.') +
      ' · ' + fmtDate(r.closed_at);
  });
  return '📜 <b>Ultimi ' + rows.length + ' trade</b>\n' + lines.join('\n');
}

async function cmdStats(ctx, symbol) {
  if (!ctx.config.get().database.enabled) return '📈 Statistiche non disponibili: il database non è collegato.';
  var s = await ctx.repo.getPositionStats(symbol);
  if (s.trades === 0) return '📈 Ancora nessun trade concluso — statistiche non disponibili.\nServe un campione più ampio prima che questi numeri abbiano senso.';
  return '📈 <b>Statistiche — ' + symbol + '</b>\n' +
    'Trade totali: ' + s.trades + ' (' + s.wins + ' vinti, ' + s.losses + ' persi)\n' +
    'Win rate: ' + fmtPct(s.winRate) + '\n' +
    'Profit factor: ' + (s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor)) + '\n' +
    'Expectancy: ' + fmt(s.expectancyR) + 'R per trade\n' +
    (s.trades < 30 ? '\n⚠️ Campione ancora piccolo (' + s.trades + ' trade): questi numeri non sono ancora statisticamente affidabili.' : '');
}

function cmdNews(ctx) {
  var cfg = ctx.config.get();
  if (!cfg.news.enabled) return '📰 Il modulo News non è configurato (manca la chiave del fornitore).';

  var events = ctx.store.load('news_events', []);
  if (!events.length) {
    // Distinzione importante: "calendario vuoto" e "scarico fallito"
    // sono due situazioni diverse e vanno dette diversamente, altrimenti
    // un guasto sembra una giornata tranquilla.
    var st = ctx.newsStats ? ctx.newsStats() : null;
    if (st && st.lastError) {
      return '📰 <b>Calendario non disponibile</b>\nL\'ultimo aggiornamento è fallito:\n' + st.lastError.message;
    }
    if (st && !st.lastFetchAt) return '📰 Calendario non ancora scaricato (il primo aggiornamento avviene all\'avvio).';
    return '📰 Nessun evento in calendario al momento.';
  }

  var newsEngine = ctx.newsEngine;
  var now = Date.now();
  var lock = newsEngine.getNewsLock(events, now, cfg.news);
  var upcoming = newsEngine.getUpcoming(events, now, cfg.news, 5);

  var lines = ['📰 <b>Calendario economico</b>'];
  if (lock.locked) lines.push('🔒 <b>NEWS LOCK ATTIVO</b>: ' + lock.reason);
  if (!upcoming.length) { lines.push('Nessun evento ad alto impatto nei prossimi giorni.'); return lines.join('\n'); }

  lines.push('');
  upcoming.forEach(function (e) {
    var mins = Math.round((e.timestampUtc - now) / 60000);
    var quando = mins < 60 ? (mins + ' min') : (mins < 1440 ? (Math.round(mins / 60) + 'h') : (Math.round(mins / 1440) + 'g'));
    lines.push('· ' + e.title + ' — tra ' + quando);
  });
  return lines.join('\n');
}

function cmdRisk(ctx, symbol) {
  var cfg = ctx.config.get();
  if (!cfg.risk.enabled) return '💰 Il Risk Engine non è configurato (manca il capitale del conto).';

  var riskEngine = ctx.riskEngine;
  var openPos = ctx.positionTracker.getOpenPosition(symbol);
  var today = (ctx.store.load('trades_today_' + symbol.replace('/', ''), []) || [])
    .filter(function (t) { return (Date.now() - t.closedAt) < 24 * 3600e3; });

  var limits = riskEngine.checkDailyLimits({
    config: cfg.risk, todayTrades: today,
    openPositions: openPos ? 1 : 0, accountCapital: cfg.risk.accountCapital
  });

  var lines = ['💰 <b>Gestione del rischio</b>'];
  lines.push('Capitale: ' + cfg.risk.accountCapital + ' · Rischio per trade: ' + cfg.risk.riskPercentPerTrade + '%');
  lines.push('Broker: ' + cfg.risk.contractSize + ' once/lotto · lotto min ' + cfg.risk.minLot);
  lines.push('');
  lines.push('Trade oggi: ' + today.length + '/' + cfg.risk.maxDailyTrades);
  lines.push('Risultato oggi: ' + (limits.totalR >= 0 ? '+' : '') + fmt(limits.totalR) + 'R');
  lines.push('Perdita giornaliera: ' + fmt(limits.lossPercent) + '% (limite ' + cfg.risk.maxDailyLossPercent + '%)');
  lines.push('Posizioni aperte: ' + (openPos ? 1 : 0) + '/' + cfg.risk.maxOpenPositions);
  lines.push('');
  lines.push(limits.allowed ? '✅ Operatività consentita' : '⛔ BLOCCATO: ' + limits.reason);

  // Se c'è un piano attivo, mostra i lotti calcolati
  var snap = ctx.store.load('latest_snapshot', null);
  if (snap && snap.plan && snap.plan.entryLo !== null && snap.plan.sl !== null) {
    var sizing = riskEngine.computePositionSize({
      accountCapital: cfg.risk.accountCapital, riskPercentPerTrade: cfg.risk.riskPercentPerTrade,
      entry: snap.plan.entryLo, sl: snap.plan.sl,
      contractSize: cfg.risk.contractSize, minLot: cfg.risk.minLot, lotStep: cfg.risk.lotStep
    });
    lines.push('');
    lines.push('<b>Setup corrente:</b>');
    if (sizing.valid) {
      lines.push('Lotti: ' + sizing.lots + ' · Rischio: ' + sizing.riskAmount + ' (' + sizing.riskPercentActual + '%)');
    } else {
      lines.push('⚠️ ' + sizing.reason);
    }
  }
  return lines.join('\n');
}

async function cmdFilters(ctx, symbol) {
  if (!ctx.config.get().database.enabled) return '🔍 Misurazione non disponibile: il database non è collegato.';

  var rows = await ctx.repo.getFilterStats(symbol);
  if (!rows.length) return '🔍 Nessun setup è stato ancora bloccato dai filtri.\nQuando accadrà, qui vedrai se il blocco ti ha protetto o ti ha tolto un\'occasione.';

  // Raggruppo per filtro: quante volte ha bloccato, e con quale esito
  var perFiltro = {};
  rows.forEach(function (r) {
    var f = r.blocked_by;
    perFiltro[f] = perFiltro[f] || { totale: 0, tp: 0, sl: 0, scaduti: 0, inAttesa: 0, sommaR: 0 };
    var n = parseInt(r.n, 10);
    perFiltro[f].totale += n;
    if (r.outcome === 'WOULD_HIT_TP') { perFiltro[f].tp += n; perFiltro[f].sommaR += parseFloat(r.sum_r || 0); }
    else if (r.outcome === 'WOULD_HIT_SL') { perFiltro[f].sl += n; perFiltro[f].sommaR += parseFloat(r.sum_r || 0); }
    else if (r.outcome === 'EXPIRED') perFiltro[f].scaduti += n;
    else perFiltro[f].inAttesa += n;
  });

  var lines = ['🔍 <b>Efficacia dei filtri</b>'];
  Object.keys(perFiltro).forEach(function (f) {
    var s = perFiltro[f];
    var risolti = s.tp + s.sl;
    lines.push('');
    lines.push('<b>' + (f === 'news' ? 'News Lock' : f === 'risk' ? 'Risk Engine' : f) + '</b>');
    lines.push('Setup bloccati: ' + s.totale);
    if (risolti > 0) {
      lines.push('Sarebbero andati: ' + s.tp + ' in TP · ' + s.sl + ' in SL');
      lines.push('Risultato evitato: ' + (s.sommaR >= 0 ? '+' : '') + fmt(s.sommaR) + 'R');
      lines.push(s.sommaR < 0
        ? '✅ Il filtro ti ha PROTETTO (' + fmt(Math.abs(s.sommaR)) + 'R di perdite evitate)'
        : '⚠️ Il filtro ti ha COSTATO ' + fmt(s.sommaR) + 'R di occasioni');
    }
    if (s.scaduti) lines.push('Scaduti senza esito: ' + s.scaduti);
    if (s.inAttesa) lines.push('In attesa di esito: ' + s.inAttesa);
    if (risolti < 10) lines.push('⚠️ Campione ancora piccolo (' + risolti + '): non trarre conclusioni.');
  });
  return lines.join('\n');
}

function cmdHelp() {
  return '🤖 <b>Comandi disponibili</b>\n' +
    '/status — stato del servizio\n' +
    '/market — prezzo e struttura attuale\n' +
    '/setup — dettaglio del setup corrente\n' +
    '/open — posizione attualmente aperta\n' +
    '/history — ultimi trade conclusi\n' +
    '/stats — statistiche di trading\n' +
    '/risk — gestione del rischio e lotti\n' +
    '/filters — efficacia dei filtri (news, rischio)\n' +
    '/news — stato modulo news\n' +
    '/help — questo elenco';
}

module.exports = {
  cmdStatus: cmdStatus, cmdMarket: cmdMarket, cmdSetup: cmdSetup, cmdOpen: cmdOpen,
  cmdHistory: cmdHistory, cmdStats: cmdStats, cmdNews: cmdNews, cmdRisk: cmdRisk, cmdFilters: cmdFilters, cmdHelp: cmdHelp
};
