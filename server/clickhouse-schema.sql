CREATE DATABASE IF NOT EXISTS quantx;

CREATE TABLE IF NOT EXISTS quantx.market_snapshots
(
  ts DateTime64(3),
  market_type LowCardinality(String),
  symbol LowCardinality(String),
  last_price String,
  price_change_percent String,
  quote_volume String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (market_type, symbol, ts)
TTL ts + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS quantx.klines
(
  ts DateTime64(3),
  market_type LowCardinality(String),
  symbol LowCardinality(String),
  interval LowCardinality(String),
  open Float64,
  high Float64,
  low Float64,
  close Float64,
  volume Float64,
  quote_volume Float64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (market_type, symbol, interval, ts)
TTL ts + INTERVAL 180 DAY;

CREATE TABLE IF NOT EXISTS quantx.funding_snapshots
(
  ts DateTime64(3),
  symbol LowCardinality(String),
  last_funding_rate String,
  next_funding_time UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (symbol, ts)
TTL ts + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS quantx.orderbook_snapshots
(
  ts DateTime64(3),
  market_type LowCardinality(String),
  symbol LowCardinality(String),
  depth_limit UInt16,
  ready UInt8,
  asks_json String,
  bids_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (market_type, symbol, ts)
TTL ts + INTERVAL 14 DAY;

CREATE TABLE IF NOT EXISTS quantx.indicator_snapshots
(
  ts DateTime64(3),
  market_type LowCardinality(String),
  symbol LowCardinality(String),
  interval LowCardinality(String),
  data_limit UInt32,
  base_url String,
  ma_json String,
  ema_json String,
  rsi_json String,
  macd_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (market_type, symbol, interval, ts)
TTL ts + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS quantx.account_snapshots
(
  ts DateTime64(3),
  token String,
  account_ready UInt8,
  account_error String,
  spot_balances_json String,
  futures_balances_json String,
  funding_balances_json String,
  futures_positions_json String,
  spot_open_orders_json String,
  futures_open_orders_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (token, ts)
TTL ts + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS quantx.proxy_health_events
(
  ts DateTime64(3),
  cache_json String,
  bus_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY ts
TTL ts + INTERVAL 14 DAY;

CREATE TABLE IF NOT EXISTS quantx.trades_raw
(
  ts DateTime64(3),
  market_type LowCardinality(String),
  symbol LowCardinality(String),
  trade_id UInt64,
  side LowCardinality(String),
  price Float64,
  quantity Float64,
  quote_quantity Float64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (market_type, symbol, ts, trade_id)
TTL ts + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS quantx.account_events
(
  ts DateTime64(3),
  token String,
  event_type LowCardinality(String),
  symbol LowCardinality(String),
  payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (token, event_type, ts)
TTL ts + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS quantx.dead_letter_events
(
  ts DateTime64(3),
  source LowCardinality(String),
  topic String,
  event_key String,
  error String,
  payload_json String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (source, topic, ts)
TTL ts + INTERVAL 30 DAY;
