from __future__ import annotations

from typing import Any, Callable


class MarketRegimeService:
    def __init__(
        self,
        *,
        redis_cache: Any,
        now_ms: Callable[[], int],
        market_data_service: Any,
        market_intelligence_service: Any | None = None,
        cache_ttl_ms: int = 60_000,
    ) -> None:
        self.redis_cache = redis_cache
        self.now_ms = now_ms
        self.market_data_service = market_data_service
        self.market_intelligence_service = market_intelligence_service
        self.cache_ttl_ms = cache_ttl_ms

    def get_market_regimes(self, force_refresh: bool = False) -> dict[str, Any]:
        cache_key = "market-regime:overview"
        if not force_refresh:
          cached = self.redis_cache.get_json(cache_key)
          if cached is not None:
              return cached

        payload = {
            "generatedAt": self.now_ms(),
            "markets": [
                self._build_a_share_regime(),
                self._build_crypto_regime(),
            ],
        }
        self.redis_cache.set_json(cache_key, payload, self.cache_ttl_ms)
        return payload

    def _build_a_share_regime(self) -> dict[str, Any]:
        benchmark = self.market_data_service.get_series(
            market="a_share",
            symbol="000300.SH",
            interval="1d",
            limit=90,
            force_refresh=False,
        )
        growth = self.market_data_service.get_series(
            market="a_share",
            symbol="399006.SZ",
            interval="1d",
            limit=90,
            force_refresh=False,
        )
        mood = self._read_market_mood("a_share")
        breadth_hint = self._read_market_breadth("a_share")

        score = 0
        reasons: list[str] = []
        score += self._score_series(benchmark, "沪深300", reasons)
        growth_score = self._score_series(growth, "创业板指", reasons)
        score += growth_score
        if mood == "偏强":
            score += 1
            reasons.append("情报概览显示A股偏强")
        elif mood == "偏弱":
            score -= 1
            reasons.append("情报概览显示A股偏弱")
        elif mood:
            reasons.append(f"情报概览显示A股{mood}")
        if breadth_hint:
            reasons.append(f"宽度参考：{breadth_hint}")

        regime, strength = self._finalize_regime(score)
        return {
            "market": "a_share",
            "label": "A股",
            "regime": regime,
            "regimeLabel": self._regime_label(regime),
            "strength": strength,
            "strengthLabel": self._strength_label(strength),
            "score": score,
            "reasons": reasons[:5],
            "benchmarks": [
                self._build_benchmark_row("沪深300", benchmark),
                self._build_benchmark_row("创业板指", growth),
            ],
        }

    def _build_crypto_regime(self) -> dict[str, Any]:
        btc = self.market_data_service.get_series(
            market="crypto",
            symbol="BTC/USDT",
            interval="1d",
            exchange_id="binance",
            market_type="spot",
            limit=90,
            force_refresh=False,
        )
        eth = self.market_data_service.get_series(
            market="crypto",
            symbol="ETH/USDT",
            interval="1d",
            exchange_id="binance",
            market_type="spot",
            limit=90,
            force_refresh=False,
        )
        mood = self._read_market_mood("crypto")
        breadth_hint = self._read_market_breadth("crypto")

        score = 0
        reasons: list[str] = []
        score += self._score_series(btc, "BTC", reasons)
        score += self._score_series(eth, "ETH", reasons)
        btc_vs_eth = self._relative_strength_score(btc, eth)
        score += btc_vs_eth["score"]
        reasons.append(btc_vs_eth["reason"])
        if mood == "偏强":
            score += 1
            reasons.append("情报概览显示加密偏强")
        elif mood == "偏弱":
            score -= 1
            reasons.append("情报概览显示加密偏弱")
        elif mood:
            reasons.append(f"情报概览显示加密{mood}")
        if breadth_hint:
            reasons.append(f"宽度参考：{breadth_hint}")

        regime, strength = self._finalize_regime(score)
        return {
            "market": "crypto",
            "label": "加密",
            "regime": regime,
            "regimeLabel": self._regime_label(regime),
            "strength": strength,
            "strengthLabel": self._strength_label(strength),
            "score": score,
            "reasons": reasons[:5],
            "benchmarks": [
                self._build_benchmark_row("BTC", btc),
                self._build_benchmark_row("ETH", eth),
            ],
        }

    def _score_series(self, payload: dict[str, Any], label: str, reasons: list[str]) -> int:
        candles = list(payload.get("candles") or [])
        if not candles:
            reasons.append(f"{label}缺少K线数据")
            return 0
        last = candles[-1]
        close = float(last.get("close") or 0)
        ma20 = float(last.get("ma20") or 0)
        ma7 = float(last.get("ma7") or 0)
        change_pct = float((payload.get("snapshot") or {}).get("changePct") or 0)
        score = 0
        if close >= ma20 > 0:
            score += 1
            reasons.append(f"{label}收盘站上20日均线")
        else:
            score -= 1
            reasons.append(f"{label}收盘跌破20日均线")
        if ma7 >= ma20 > 0:
            score += 1
            reasons.append(f"{label}短均线在长均线上方")
        elif ma20 > 0:
            score -= 1
            reasons.append(f"{label}短均线弱于长均线")
        if change_pct >= 2:
            score += 1
            reasons.append(f"{label}最新涨幅偏强")
        elif change_pct <= -2:
            score -= 1
            reasons.append(f"{label}最新跌幅偏弱")
        return score

    def _relative_strength_score(self, btc: dict[str, Any], eth: dict[str, Any]) -> dict[str, Any]:
        btc_change = self._window_change_pct(btc, 20)
        eth_change = self._window_change_pct(eth, 20)
        delta = btc_change - eth_change
        if delta >= 5:
            return {"score": 1, "reason": "BTC相对ETH更强，偏防守顺风"}
        if delta <= -5:
            return {"score": -1, "reason": "ETH相对BTC更强，市场风格更激进"}
        return {"score": 0, "reason": "BTC与ETH相对强弱接近"}

    def _window_change_pct(self, payload: dict[str, Any], window: int) -> float:
        candles = list(payload.get("candles") or [])
        if len(candles) < 2:
            return 0.0
        end_close = float(candles[-1].get("close") or 0)
        start_close = float(candles[max(0, len(candles) - window)].get("close") or 0)
        if start_close <= 0:
            return 0.0
        return ((end_close / start_close) - 1) * 100

    def _build_benchmark_row(self, label: str, payload: dict[str, Any]) -> dict[str, Any]:
        snapshot = payload.get("snapshot") or {}
        indicators = payload.get("indicators") or {}
        return {
            "label": label,
            "last": float(snapshot.get("last") or 0),
            "changePct": float(snapshot.get("changePct") or 0),
            "trend": str(indicators.get("trend") or "--"),
        }

    def _read_market_mood(self, market: str) -> str:
        if self.market_intelligence_service is None:
            return ""
        try:
            overview = self.market_intelligence_service.get_overview(force_refresh=False)
            target = next((item for item in overview.get("markets", []) if item.get("market") == market), None)
            return str((target or {}).get("overview", {}).get("mood") or "")
        except Exception:
            return ""

    def _read_market_breadth(self, market: str) -> str:
        if self.market_intelligence_service is None:
            return ""
        try:
            overview = self.market_intelligence_service.get_overview(force_refresh=False)
            target = next((item for item in overview.get("markets", []) if item.get("market") == market), None)
            return str((target or {}).get("overview", {}).get("breadth") or "")
        except Exception:
            return ""

    def _finalize_regime(self, score: int) -> tuple[str, str]:
        if score >= 3:
            return "bull", "strong"
        if score == 2:
            return "bull", "mid"
        if score <= -3:
            return "bear", "strong"
        if score == -2:
            return "bear", "mid"
        return "range", "weak" if abs(score) <= 1 else "mid"

    def _regime_label(self, regime: str) -> str:
        return {
            "bull": "多头",
            "bear": "空头",
            "range": "震荡",
        }.get(regime, "震荡")

    def _strength_label(self, strength: str) -> str:
        return {
            "strong": "强",
            "mid": "中",
            "weak": "弱",
        }.get(strength, "中")
