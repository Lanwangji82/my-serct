<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# QuantX Platform

QuantX 是一套以 FMZ 为核心回测与部署底座的量化工作台，当前重点聚焦在策略档案库、本地 Python 策略导入、FMZ 风格回测、结果展示与执行联通检查。

当前核心技术栈：
- 前端：React + TypeScript
- 后端：Python + FastAPI
- 数据处理：Polars
- 回测：本地 FMZ 风格回测引擎
- 执行：CCXT / 交易所联通检测

## 本地启动

前置条件：
- Node.js
- Python 3.11+

启动步骤：
1. 安装前端依赖  
   `npm install`
2. 安装 Python 依赖  
   `pip install -r python_services/requirements.txt`
3. 按需配置 [`.env.example`](/D:/quantx-platform/.env.example)
4. 启动整套开发环境  
   `npm run dev:all`

## 策略落盘目录

默认保存在：

`python_services/strategy_store/`

可通过环境变量 `PY_PLATFORM_STRATEGY_STORE` 自定义。
