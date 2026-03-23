# Polars、CCXT、VectorBT 函数库中文使用文档

本文档基于当前项目实际实现编写，覆盖三部分：

- `Polars`：行情数据结构、字段约定、策略函数输入输出
- `CCXT`：交易所客户端创建、历史数据拉取、凭证与代理处理
- `VectorBT`：回测入口、参数含义、回测结果结构

对应后端主文件：

- [python_services/main.py](/D:/quantx-platform/python_services/main.py)

## 1. 整体调用关系

当前项目的量化链路如下：

1. 通过 `CCXT` 创建交易所客户端
2. 拉取 K 线并转成 `Polars DataFrame`
3. 策略函数 `generate_signals(frame, params)` 基于 `Polars` 生成开平仓信号
4. 将信号交给 `VectorBT` 执行回测
5. 输出收益、回撤、交易明细、权益曲线

对应核心函数：

- `create_exchange_client(...)`
- `fetch_ohlcv_frame(...)`
- `run_python_strategy_signals(...)`
- `run_vectorbt_backtest(...)`
- `compile_python_strategy(...)`
- `evaluate_pre_trade_risk(...)`

---

## 2. Polars：数据结构与策略函数写法

### 2.1 当前项目里 K 线数据的标准结构

`fetch_ohlcv_frame(...)` 会返回一个 `pl.DataFrame`，字段固定为：

| 字段名 | 类型 | 含义 |
|---|---|---|
| `timestamp` | `int` | 毫秒时间戳 |
| `open` | `float` | 开盘价 |
| `high` | `float` | 最高价 |
| `low` | `float` | 最低价 |
| `close` | `float` | 收盘价 |
| `volume` | `float` | 成交量 |

示例：

```python
import polars as pl

frame = pl.DataFrame(
    {
        "timestamp": [1710000000000, 1710003600000],
        "open": [68000.0, 68120.0],
        "high": [68250.0, 68300.0],
        "low": [67920.0, 68050.0],
        "close": [68110.0, 68220.0],
        "volume": [120.5, 98.2],
    }
)
```

### 2.2 策略函数标准入口

当前平台的 Python 策略必须定义：

```python
def generate_signals(frame, params) -> dict:
    ...
```

要求：

- `frame` 是 `Polars DataFrame`
- `params` 是策略参数字典
- 返回值必须是 `dict`
- 必须至少包含：
  - `entries`
  - `exits`

返回格式：

```python
{
    "entries": [True, False, False, True],
    "exits": [False, False, True, False],
}
```

长度要求：

- `entries` 长度必须与 `frame` 行数一致
- `exits` 长度必须与 `frame` 行数一致

### 2.3 一个可直接使用的均线策略示例

```python
import polars as pl


def generate_signals(frame: pl.DataFrame, params: dict) -> dict:
    fast_period = int(params.get("fastPeriod", 10))
    slow_period = int(params.get("slowPeriod", 30))

    if frame.height == 0:
        return {"entries": [], "exits": []}

    close = frame["close"]
    fast = close.rolling_mean(fast_period)
    slow = close.rolling_mean(slow_period)

    entries = []
    exits = []
    previous_fast = None
    previous_slow = None

    for current_fast, current_slow in zip(fast.to_list(), slow.to_list()):
        can_compare = None not in (previous_fast, previous_slow, current_fast, current_slow)
        entries.append(bool(can_compare and current_fast > current_slow and previous_fast <= previous_slow))
        exits.append(bool(can_compare and current_fast < current_slow and previous_fast >= previous_slow))
        previous_fast = current_fast
        previous_slow = current_slow

    return {"entries": entries, "exits": exits}
```

### 2.4 当前平台支持的安全执行环境

`run_python_strategy_signals(...)` 在执行策略时，只开放了有限内建函数和模块。

可用内容包括：

- `pl`
- `math`
- 基础内建：
  - `abs`
  - `all`
  - `any`
  - `bool`
  - `dict`
  - `enumerate`
  - `float`
  - `int`
  - `len`
  - `list`
  - `max`
  - `min`
  - `range`
  - `round`
  - `sum`
  - `zip`

这意味着：

- 你可以正常写 `import polars as pl`
- 你可以做常规数值运算
- 但不要假设任意 Python 标准库都开放了

---

## 3. CCXT：交易所连接与历史数据函数

### 3.1 创建交易所客户端

函数：

```python
create_exchange_client(
    broker_id: str,
    market_type: str,
    credentials: dict[str, str] | None = None,
    broker_mode: str = "sandbox",
)
```

参数说明：

| 参数 | 含义 |
|---|---|
| `broker_id` | 交易所标识，当前主要支持 `binance`、`okx` |
| `market_type` | `spot` 或 `futures` |
| `credentials` | 可选，包含 `apiKey`、`apiSecret`、`passphrase` |
| `broker_mode` | `sandbox` 或 `production` |

当前行为：

- `okx`
  - 现货时 `defaultType = "spot"`
  - 合约时 `defaultType = "swap"`
  - 非 `production` 自动调用 `set_sandbox_mode(True)`
- `binance`
  - 现货使用 `ccxt.binance`
  - 合约使用 `ccxt.binanceusdm`
  - 非 `production` 自动调用 `set_sandbox_mode(True)`

### 3.2 代理与系统网络

当前项目会优先使用以下代理来源：

1. 显式环境变量
   - `CCXT_HTTP_PROXY`
   - `CCXT_HTTPS_PROXY`
   - `CCXT_SOCKS_PROXY`
   - `HTTP_PROXY`
   - `HTTPS_PROXY`
   - `ALL_PROXY`
2. Windows 系统代理

设计目标：

- 优先保证 `ccxt` 与系统实际网络出口一致
- 避免“浏览器能访问，策略引擎不能访问”的情况

### 3.3 拉取历史 K 线

函数：

```python
fetch_ohlcv_frame(
    broker_target: str,
    market_type: str,
    symbol: str,
    interval: str,
    limit: int,
) -> tuple[pl.DataFrame, str]
```

参数说明：

| 参数 | 示例 | 含义 |
|---|---|---|
| `broker_target` | `okx:sandbox` | 交易所目标 |
| `market_type` | `futures` | 市场类型 |
| `symbol` | `BTCUSDT` | 标的 |
| `interval` | `1h` | 周期 |
| `limit` | `500` | 拉取 K 线数量 |

返回值：

```python
(frame, source)
```

- `frame`：`Polars DataFrame`
- `source`：数据来源标记

当前可能的 `source`：

- `broker-historical`
- `synthetic-fallback`

说明：

- 如果交易所行情拉取失败，系统会自动回退到合成数据
- 这样回测链路不会因为外部网络波动完全中断

### 3.4 市场符号解析

函数：

```python
resolve_market_symbol(client, broker_id, market_type, compact_symbol)
```

作用：

- 把平台内部的 `BTCUSDT`
- 转成交易所真实可识别的市场符号
- 例如：
  - `BTC/USDT`
  - `BTC/USDT:USDT`

这个函数对 `OKX` 的现货和合约场景做了额外兼容。

---

## 4. VectorBT：回测函数说明

### 4.1 回测入口

函数：

```python
run_vectorbt_backtest(
    strategy: dict[str, Any],
    frame: pl.DataFrame,
    lookback: int,
    initial_capital: float,
    fee_bps: float,
    slippage_bps: float,
) -> dict[str, Any]
```

### 4.2 参数说明

| 参数 | 含义 |
|---|---|
| `strategy` | 平台保存的策略对象 |
| `frame` | Polars K 线数据 |
| `lookback` | 回测样本长度 |
| `initial_capital` | 初始资金 |
| `fee_bps` | 手续费，单位 bps |
| `slippage_bps` | 滑点，单位 bps |

换算规则：

- `1 bps = 0.01%`
- 回测内部会转换为：
  - `fees = fee_bps / 10000`
  - `slippage = slippage_bps / 10000`

### 4.3 当前回测输出结构

回测结果会返回：

```python
{
    "id": "...",
    "strategyId": "...",
    "symbol": "BTCUSDT",
    "interval": "1h",
    "marketType": "futures",
    "source": "broker-historical",
    "params": {
        "lookback": 500,
        "initialCapital": 10000,
        "feeBps": 4,
        "slippageBps": 2,
    },
    "metrics": {
        "totalReturnPct": 7.72,
        "sharpe": 1.35,
        "maxDrawdownPct": 4.18,
        "winRatePct": 56.0,
        "trades": 5,
        "endingEquity": 10772.02,
    },
    "equityCurve": [...],
    "trades": [...],
}
```

### 4.4 关键指标解释

| 字段 | 含义 |
|---|---|
| `totalReturnPct` | 总收益率 |
| `sharpe` | 夏普比率 |
| `maxDrawdownPct` | 最大回撤 |
| `winRatePct` | 胜率 |
| `trades` | 成交笔数 |
| `endingEquity` | 期末权益 |

### 4.5 交易明细

回测交易明细来自：

```python
serialize_trade_records(portfolio)
```

前端会展示的主要字段：

- `time`
- `side`
- `price`
- `quantity`
- `fee`
- `pnl`

---

## 5. 编译与策略校验函数

### 5.1 编译函数

函数：

```python
compile_python_strategy(source_code: str) -> dict[str, Any]
```

作用：

- 做 Python 语法检查
- 检查是否定义了 `generate_signals`
- 给出警告信息

返回结构：

```python
{
    "valid": True,
    "errors": [],
    "warnings": [],
    "functions": ["generate_signals"],
}
```

当前主要校验规则：

- 源码不能为空
- 必须定义 `generate_signals(frame, params)`
- 如果没有 `import` 语句，会给出提示

### 5.2 执行策略信号函数

函数：

```python
run_python_strategy_signals(strategy, frame, index)
```

作用：

- 先调用 `compile_python_strategy`
- 再执行用户策略源码
- 解析返回的 `entries` / `exits`
- 最终转成 `pandas.Series`

为什么这里最终是 `pandas.Series`：

- 因为 `VectorBT` 的 `Portfolio.from_signals(...)` 直接吃 `pandas` 结构

所以当前项目的真实形态是：

- 数据输入：`Polars`
- 信号输出：`Pandas Series`
- 回测引擎：`VectorBT`

---

## 6. 风控函数

### 6.1 下单前风险检查

函数：

```python
evaluate_pre_trade_risk(strategy, requested_notional, leverage)
```

当前检查项：

- 名义金额是否超过 `maxNotional`
- 杠杆是否超过 `maxLeverage`

返回值：

```python
{
    "allow": True,
    "breaches": [],
}
```

或：

```python
{
    "allow": False,
    "breaches": [
        "notional limit exceeded",
        "leverage limit exceeded",
    ],
}
```

---

## 7. 当前项目 API 与函数的对应关系

### 7.1 策略保存

接口：

```http
POST /api/platform/strategies
```

请求模型：

```python
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
```

### 7.2 策略编译

接口：

```http
POST /api/platform/strategies/compile
```

请求体：

```json
{
  "sourceCode": "..."
}
```

### 7.3 回测执行

接口：

```http
POST /api/platform/backtests
```

请求模型：

```python
class BacktestRequest(BaseModel):
    strategyId: str
    lookback: int = 500
    initialCapital: float = 10000
    feeBps: float = 4
    slippageBps: float = 2
```

### 7.4 凭证保存

接口：

```http
POST /api/platform/credentials
```

请求模型：

```python
class CredentialRequest(BaseModel):
    brokerTarget: str
    label: str
    apiKey: str
    apiSecret: str
    apiPassphrase: str | None = None
```

---

## 8. 推荐使用方式

### 8.1 写策略

建议先在平台中按这个顺序操作：

1. 新建 Python 策略
2. 填参数：
   - `fastPeriod`
   - `slowPeriod`
   - `positionSizeUsd`
   - `maxNotional`
   - `maxLeverage`
   - `maxDailyLoss`
3. 写 `generate_signals(frame, params)`
4. 点击“编译检查”
5. 通过后保存
6. 再运行回测

### 8.2 联网不稳定时

如果交易所网络不稳定：

- 回测仍可能继续运行，因为有 `synthetic-fallback`
- 但要注意：
  - 这种结果适合调试流程
  - 不适合作为最终实盘依据

### 8.3 实盘前最低要求

在把策略从回测推进到沙盒或生产前，至少要确认：

1. 编译通过
2. 回测结果稳定
3. 联通检测通过
4. 凭证保存正确
5. 风控参数完整

---

## 9. 常见问题

### 9.1 为什么策略里用 Polars，回测里又变成 Pandas？

因为当前项目采用的是：

- `Polars` 负责数据处理
- `VectorBT` 负责回测

而 `VectorBT` 更适合直接接收 `pandas.Series` 作为价格与信号输入。

### 9.2 为什么拉不到真实 K 线还能回测？

因为 `fetch_ohlcv_frame(...)` 在失败时会降级成：

- `synthetic-fallback`

这样平台不会因为外部接口抖动彻底不可用。

### 9.3 什么时候必须用交易所代理？

当系统无法直连交易所时，`CCXT` 需要通过：

- 显式代理环境变量
- 或系统代理

否则会出现：

- 域名解析失败
- public time 接口不可达
- 凭证接口无法联通

---

## 10. 你最常会直接用到的函数

如果只记最核心的 6 个，记这几个：

- `create_exchange_client(...)`
- `fetch_ohlcv_frame(...)`
- `compile_python_strategy(...)`
- `run_python_strategy_signals(...)`
- `run_vectorbt_backtest(...)`
- `evaluate_pre_trade_risk(...)`

这 6 个函数基本构成了当前平台从“连接交易所”到“写策略”再到“跑回测”的最小闭环。

