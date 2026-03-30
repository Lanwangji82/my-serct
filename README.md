# QuantX Platform

中文量化交易工作台，聚焦本地研究、市场情报、行情查看、策略管理与回测。

## 目录结构

- `frontend/`
  React + TypeScript + Vite 前端界面与构建产物
- `backend/python/`
  FastAPI 主平台 API、运行时配置、市场情报、行情与回测服务
- `backend/node/`
  Node 边车、代理集成、市场侧工具与本地开发编排
- `docs/`
  架构说明与文档资源
- `config/`
  共享运行时配置
- `scripts/`
  本地启动与停止脚本

## 主要能力

- A 股与加密双市场情报
- A 股与加密 K 线行情中心
- 策略管理与本地回测
- 网络端口与代理路由配置
- Tushare / LLM 数据源配置
- Redis 热缓存 + Mongo 快照 + 后台刷新任务

## 本地开发

安装依赖：

```bash
npm install
pip install -r backend/python/requirements.txt
```

启动整套开发环境：

```bash
npm run dev:all
```

后台启动与停止：

```bash
npm run dev:all:bg
npm run dev:all:stop
```

仅启动 Python 平台：

```bash
python backend/python/run_server.py
```

## 前端构建

```bash
npm run build
```

前端构建产物输出到：

`frontend/build/`

## 运行依赖

- Node.js 20+
- Python 3.11+
- MongoDB 7
- Redis 7 或兼容服务

## 文档

- 架构说明见 [docs/architecture.md](D:\quantx-platform\docs\architecture.md)
