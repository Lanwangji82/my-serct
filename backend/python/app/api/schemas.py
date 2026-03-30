from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

BrokerId = Literal["paper", "binance", "okx", "bybit", "ibkr"]
BrokerMode = Literal["paper", "sandbox", "production"]
StrategyRuntime = Literal["backtest-only", "paper", "sandbox", "production"]
MarketType = Literal["spot", "futures"]
StrategyTemplate = Literal["smaCross", "breakout", "python"]


class LoginRequest(BaseModel):
    email: str
    password: str


class BacktestRequest(BaseModel):
    strategyId: str
    brokerTarget: str = "binance:production"
    startTime: str | None = "2025-01-01 00:00:00"
    endTime: str | None = "2026-03-21 08:00:00"
    period: str = "4h"
    basePeriod: str = "1h"
    mode: str = "模拟级"
    initialCapital: float = Field(default=10000, gt=0)
    quoteAsset: str = "USDT"
    tolerancePct: float = Field(default=50, ge=0)
    openFeePct: float = Field(default=0.03, ge=0)
    closeFeePct: float = Field(default=0.03, ge=0)
    slippagePoints: float = Field(default=0, ge=0)
    candleLimit: int = Field(default=300, ge=10, le=5000)
    chartDisplay: str = "显示"
    depthMin: int = Field(default=20, ge=1)
    depthMax: int = Field(default=200, ge=1)
    recordEvents: bool = False
    leverage: float | None = None
    chartBars: int = Field(default=3000, ge=200, le=10000)
    delayMs: int = Field(default=200, ge=0, le=5000)
    logLimit: int = Field(default=8000, ge=100, le=50000)
    profitLimit: int = Field(default=50000, ge=100, le=50000)
    dataSource: str = "默认"
    orderMode: str = "已成交"
    distributor: str = "本地回测引擎: Python3 - 12 vCPU / 4G RAM"


class StrategyRequest(BaseModel):
    id: str | None = None
    name: str
    description: str
    marketType: MarketType
    symbol: str
    interval: str
    runtime: StrategyRuntime
    template: StrategyTemplate
    parameters: dict[str, float]
    risk: dict[str, Any]
    sourceCode: str | None = None


class StrategyCompileRequest(BaseModel):
    sourceCode: str


class TushareConfigRequest(BaseModel):
    enabled: bool = True
    token: str = ""
    baseUrl: str = "http://api.tushare.pro"


class LlmConfigRequest(BaseModel):
    enabled: bool = False
    provider: str = "openai"
    apiKey: str = ""
    baseUrl: str = "https://api.openai.com/v1"
    model: str = "gpt-5.4-mini"
