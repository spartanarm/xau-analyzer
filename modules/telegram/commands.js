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

  return '📊 <b>Stato del servizio</b>\n' +
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

function cmdNews() {
  return '📰 Il modulo News non è ancora attivo — arriverà in una fase successiva del progetto.';
}

function cmdHelp() {
  return '🤖 <b>Comandi disponibili</b>\n' +
    '/status — stato del servizio\n' +
    '/market — prezzo e struttura attuale\n' +
    '/setup — dettaglio del setup corrente\n' +
    '/open — posizione attualmente aperta\n' +
    '/history — ultimi trade conclusi\n' +
    '/stats — statistiche di trading\n' +
    '/news — stato modulo news\n' +
    '/help — questo elenco';
}

module.exports = {
  cmdStatus: cmdStatus, cmdMarket: cmdMarket, cmdSetup: cmdSetup, cmdOpen: cmdOpen,
  cmdHistory: cmdHistory, cmdStats: cmdStats, cmdNews: cmdNews, cmdHelp: cmdHelp
};
