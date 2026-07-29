// ══════════════════════════════════════════════════════════════════
// STATE STORE — sostituisce localStorage del browser con file su disco.
// Ogni pezzo di memoria che l'app teneva nel browser (tracker, radar,
// stability, storico setup, cache candele, contatore rate-limit) vive
// qui, con lo stesso identico contenuto/formato — solo il "dove" cambia.
//
// Scelta deliberata: file JSON, non un database vero, per ora. È il modo
// più veloce e sicuro di partire (fase 2 del piano di migrazione già
// discusso): un database arriverà quando il servizio girerà stabile da
// un po' e servirà interrogare mesi di storico in modo comodo.

var fs = require('fs');
var path = require('path');

// IMPORTANTE: sui servizi di hosting il disco è "effimero" — tutto ciò
// che viene scritto sparisce a ogni riavvio o aggiornamento. Per questo
// la cartella dei dati è configurabile: sul server va puntata a un
// "volume" (disco permanente), così la memoria del motore (tracker,
// stato del ciclo di vita, contatore richieste) sopravvive ai riavvii.
// In locale, senza configurazione, usa semplicemente ./data
var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('[state-store] cartella dati: ' + DATA_DIR);

function filePath(key) { return path.join(DATA_DIR, key + '.json'); }

function load(key, fallback) {
  try {
    var raw = fs.readFileSync(filePath(key), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try {
    fs.writeFileSync(filePath(key), JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('[state-store] impossibile salvare ' + key + ':', e.message);
    return false;
  }
}

// ── Le stesse identiche chiavi che il browser teneva in localStorage ──
var KEYS = {
  SETUP: 'xau_ta_setup_v1',
  STABILITY: 'xau_ta_stab_v1',
  RADAR: 'xau_ta_radar_v1',
  LAST_TERMINAL: 'xau_ta_lastterm_v1',
  SETUP_HISTORY: 'xau_ta_setup_hist_v1',
  TF_CACHE: 'xau_ta_tfcache_v1',
  RATE_TIMES: 'xau_ta_reqts_v1',
  ALERT_SIG: 'xau_ta_alertsig_v1',
  SIGNALS: 'xau_ta_signals_v1',
  CFG: 'xau_ta_cfg_v1'
};

module.exports = { load: load, save: save, KEYS: KEYS };
