// ══════════════════════════════════════════════════════════════════
// INDEX.JS — punto di avvio unico del servizio.
//
// Fa partire insieme le due parti:
//   1. lo SCHEDULER, che ogni 5 minuti scarica i prezzi e fa girare il
//      motore (il "cervello" invariato)
//   2. il SERVER, che mostra l'ultimo risultato su una pagina web
//
// La chiave Twelve Data NON è scritta qui dentro: viene letta da una
// "variabile d'ambiente" — un campo protetto che si imposta nel
// pannello del servizio di hosting. Così la chiave non finisce mai nel
// codice né in un file che potrebbe essere visto da altri.

var scheduler = require('./scheduler.js');
var server = require('./server.js');

var API_KEY = process.env.TWELVEDATA_API_KEY;

if (!API_KEY) {
  console.error('');
  console.error('❌ MANCA LA CHIAVE API.');
  console.error('   Nel pannello del servizio di hosting, aggiungi una variabile');
  console.error('   chiamata TWELVEDATA_API_KEY con la tua chiave Twelve Data.');
  console.error('');
  process.exit(1);
}

console.log('═══════════════════════════════════════════');
console.log(' XAU/USD Technical Analyzer — servizio H24');
console.log('═══════════════════════════════════════════');

// Il server parte per primo: così la pagina web risponde subito
// ("nessuna analisi ancora disponibile") invece di dare errore mentre
// il primo ciclo dello scheduler è ancora in corso.
server.start();
scheduler.start(API_KEY);
