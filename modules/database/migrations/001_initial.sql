-- ══════════════════════════════════════════════════════════════════
-- MIGRAZIONE 001 — schema iniziale.
--
-- Principio guida: tutte le tabelle sono ADDITIVE (si aggiungono righe,
-- non si sovrascrivono dati passati) e ogni CREATE è "IF NOT EXISTS":
-- si può rilanciare questo file quante volte si vuole (a ogni riavvio
-- del servizio) senza effetti collaterali.
--
-- "symbol" è presente in ogni tabella fin da subito, anche se oggi
-- esiste solo XAU/USD: aggiungere uno strumento in futuro significa
-- inserire righe, non modificare lo schema.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── SETUPS — un record per ciascun setupId, aggiornato mentre vive,
-- mai cancellato. Contiene tutti i campi richiesti: bias, confidence,
-- grade, entry, SL, TP1, TP2, motivo, struttura di mercato, ATR, trend,
-- risultato finale.
CREATE TABLE IF NOT EXISTS setups (
  id                  TEXT NOT NULL,
  symbol              TEXT NOT NULL,
  direction           TEXT,               -- BUY | SELL
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  execution_mode      TEXT,               -- DIRECT LIMIT | FAST CONFIRMATION | ...
  order_type          TEXT,
  status              TEXT,               -- stato di ciclo di vita corrente

  bias                TEXT,
  grade               TEXT,               -- A+ | A | B | null
  confidence          NUMERIC,

  entry_lo            NUMERIC,
  entry_hi            NUMERIC,
  sl                  NUMERIC,
  tp1                 NUMERIC,
  tp2                 NUMERIC,
  tp_fast             NUMERIC,
  rr1                 NUMERIC,
  rr2                 NUMERIC,
  required_rr         NUMERIC,
  invalidation_level  NUMERIC,

  atr_h1              NUMERIC,
  atr_m15             NUMERIC,

  market_structure    JSONB,              -- trend/state/lastEvent per timeframe
  zones               JSONB,              -- supporti e resistenze al momento della creazione
  quality_factors     JSONB,              -- il dettaglio "WHY THIS TRADE IS ACCEPTABLE"
  news_context        JSONB,              -- vuoto oggi, popolato in Fase 5

  reason              TEXT,

  -- esito finale: valorizzati quando il setup termina (Fase 3 per
  -- exit_price/pnl_r precisi, oggi restano NULL finché non c'è il
  -- Position Tracker)
  terminal_at         TIMESTAMPTZ,
  outcome             TEXT,               -- INVALIDATED | EXPIRED | TARGET_HIT | ...
  exit_price          NUMERIC,
  pnl_r               NUMERIC,

  PRIMARY KEY (symbol, id)
);

CREATE INDEX IF NOT EXISTS idx_setups_symbol_created ON setups (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_setups_status ON setups (status);
CREATE INDEX IF NOT EXISTS idx_setups_outcome ON setups (outcome) WHERE outcome IS NOT NULL;

-- ── SETUP_EVENTS — la cronologia di OGNI transizione. Senza questa
-- tabella si possono solo contare gli esiti finali; con questa si può
-- chiedere "quanti setup TOUCHED non arrivano mai a conferma?".
CREATE TABLE IF NOT EXISTS setup_events (
  id           BIGSERIAL PRIMARY KEY,
  setup_id     TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  at           TIMESTAMPTZ NOT NULL,
  event_type   TEXT NOT NULL,        -- lo stesso tipo pubblicato sull'Event Bus
  from_state   TEXT,
  to_state     TEXT,
  reason       TEXT,
  payload      JSONB,

  FOREIGN KEY (symbol, setup_id) REFERENCES setups (symbol, id)
);

CREATE INDEX IF NOT EXISTS idx_setup_events_setup ON setup_events (symbol, setup_id, at);

-- ── ANALYSES — uno snapshot per ciclo REALMENTE eseguito (la guardia
-- anti-ricalcolo evita righe duplicate quando nulla cambia). Stesso
-- schema logico di evaluations.json già usato dal backtest, così le
-- statistiche live e quelle storiche sono confrontabili con le stesse query.
CREATE TABLE IF NOT EXISTS analyses (
  id              BIGSERIAL PRIMARY KEY,
  symbol          TEXT NOT NULL,
  at              TIMESTAMPTZ NOT NULL,
  price           NUMERIC,
  bias            TEXT,
  grade           TEXT,
  confidence      NUMERIC,
  execution_mode  TEXT,
  decision        TEXT,             -- TRADE | NO_TRADE
  status          TEXT,
  reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_analyses_symbol_at ON analyses (symbol, at DESC);

-- ── LOGS — solo gli eventi rilevanti (non ogni riga di DEBUG: quelli
-- restano sul file per non gonfiare il database). Il logger decide cosa
-- arriva qui in base al livello configurato.
CREATE TABLE IF NOT EXISTS logs (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL,
  level       TEXT NOT NULL,
  component   TEXT NOT NULL,
  event_type  TEXT,
  message     TEXT NOT NULL,
  context     JSONB
);

CREATE INDEX IF NOT EXISTS idx_logs_at ON logs (at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level) WHERE level IN ('WARN', 'ERROR');
