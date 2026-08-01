// ══════════════════════════════════════════════════════════════════
// AGGIORNAMENTO NEWS — su una cadenza SUA, lenta e separata.
//
// Il calendario economico non cambia ogni 5 minuti: gli eventi sono noti
// giorni prima. Aggiornarlo ad ogni ciclo di prezzo sarebbe uno spreco
// (288 chiamate al giorno invece di 4) e, peggio, legherebbe l'analisi
// tecnica alla disponibilità del fornitore news.
//
// GARANZIA: se il fornitore news è irraggiungibile, il ciclo di prezzo
// continua a funzionare normalmente. Gli eventi già scaricati restano
// validi (sono noti in anticipo, non scadono in fretta).

var config = require('../../core/config/index.js');
var logging = require('../../core/logging/index.js');
var bus = require('../../core/events/index.js');
var store = require('../persistence/stateStore.js');

var log = logging.forComponent('news');
var timer = null;
var stats = { lastFetchAt: null, lastError: null, eventsLoaded: 0 };

function getProvider(name) {
  if (name === 'finnhub') return require('./provider-finnhub.js');
  if (name === 'fmp') return require('./provider-fmp.js');
  return null;
}

async function refresh(fetchFnOverride) {
  var cfg = config.get();
  if (!cfg.news.enabled) return { skipped: true };

  var provider = getProvider(cfg.news.provider);
  if (!provider) {
    log.error('provider.unknown', 'fornitore news non riconosciuto: ' + cfg.news.provider);
    return { skipped: true };
  }

  try {
    var events = await provider.fetchEvents(cfg.news.apiKey, Date.now(), 7, fetchFnOverride);
    store.save('news_events', events);
    stats.lastFetchAt = Date.now();
    stats.lastError = null;
    stats.eventsLoaded = events.length;

    var newsEngine = require('./index.js');
    var upcoming = newsEngine.getUpcoming(events, Date.now(), cfg.news, 5);
    log.info('news.updated', 'calendario aggiornato', {
      provider: provider.name, totale: events.length, altoImpattoInArrivo: upcoming.length
    });
    bus.publish(bus.EVENTS.NEWS_UPDATED, { count: events.length, upcoming: upcoming });
    return { events: events, upcoming: upcoming };
  } catch (err) {
    // GARANZIA: un fallimento qui non deve mai propagarsi al ciclo di
    // prezzo. Registriamo e proseguiamo con gli eventi già in memoria.
    stats.lastError = { at: Date.now(), message: err.message };
    log.error('news.failed', 'aggiornamento calendario fallito: gli eventi già scaricati restano validi', { error: err.message });
    return { error: err.message };
  }
}

function start() {
  var cfg = config.get();
  if (!cfg.news.enabled) {
    log.info('news.disabled', 'modulo news non configurato: nessun aggiornamento, nessun blocco per news');
    return false;
  }
  log.info('news.started', 'aggiornamento calendario ogni ' + (cfg.news.refreshEveryMs / 3600000) + ' ore', { provider: cfg.news.provider });
  refresh();
  timer = setInterval(refresh, cfg.news.refreshEveryMs);
  return true;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }
function getStats() { return Object.assign({}, stats); }

module.exports = { start: start, stop: stop, refresh: refresh, getStats: getStats };
