# FMZ 接入说明

本文档说明如何把 QuantX 作为“策略编写与研究前端”，把 FMZ 作为“交易所适配、机器人托管与部署平台”。

## 为什么接入 FMZ

当前团队最缺的不是再造一套交易所适配层，而是稳定地把策略跑起来。FMZ 更适合承担这些职责：

- 统一 Binance、OKX 等交易所接口
- 提供回测、模拟盘、实盘和托管者部署
- 让策略从“写完代码”更快走到“跑起来”

QuantX 保留的价值：

- 策略编辑与版本沉淀
- 中文策略管理界面
- 本地研究、回测记录与团队工作流
- 将 Python 策略导出为 FMZ 可继续改造的脚本模板

## 当前接入方式

当前版本不是直接替代 FMZ Web 平台，而是做了三件事：

1. 在 `设置 -> FMZ 接入` 中保存 FMZ 基础配置
2. 在 `策略工作流 -> Python 策略编辑器` 中将当前策略导出到 FMZ
3. 将导出产物写入本地 `python_services/fmz_exports`

导出内容包括：

- `fmz_strategy.py`
- `fmz_export.json`

## 使用步骤

1. 在 QuantX 中完成 Python 策略编写与保存
2. 打开 `设置`
3. 在 `FMZ 接入` 中填写：
   - `FMZ 地址`
   - `FMZ API Key`
   - `FMZ API Secret`
   - `账号标识`（可选）
4. 保存配置
5. 回到 `策略工作流`
6. 选择已保存的 Python 策略
7. 点击 `导出到 FMZ`
8. 打开导出目录，将 `fmz_strategy.py` 上传到 FMZ

## 导出目录

默认目录：

`python_services/fmz_exports`

每个策略会创建独立子目录，例如：

`python_services/fmz_exports/策略名__策略ID`

## 导出的 FMZ 脚本包含什么

导出的脚本包含：

- QuantX 里保存的 `generate_signals(frame, params)` 源码
- FMZ K 线记录转 `polars.DataFrame` 的适配函数
- FMZ `main()` 运行循环模板
- 合约与周期映射

注意：

当前导出脚本默认只生成信号和日志，不会盲目替你发实盘订单。这样更安全，也更适合你先在 FMZ 里继续补自己的下单逻辑和风控逻辑。

## 环境变量

可选环境变量：

- `FMZ_BASE_URL`
- `FMZ_API_KEY`
- `FMZ_API_SECRET`
- `FMZ_ACCOUNT_ID`
- `PY_PLATFORM_FMZ_EXPORT_ROOT`

如果不配置环境变量，也可以直接在软件里保存 FMZ 配置。

## 推荐工作流

推荐把两边职责分开：

- QuantX：写策略、存策略、中文工作流、研究记录
- FMZ：对接交易所、机器人托管、回测与实盘部署

这样可以明显减少自研执行层维护成本。
