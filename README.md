# QuantX Platform

QuantX Platform 是一套以 FMZ 为核心回测底座的量化工作台，当前重点能力包括：

- 策略档案库与本地 Python 策略导入
- FMZ 风格本地回测
- 回测结果展示、行情数据、收益概览、日志与资产结果
- 交易所联通检测

当前技术栈：

- 前端：React + TypeScript + Vite
- 后端：Python + FastAPI
- 回测：FMZ 官方本地 Python 回测库
- 数据存储：MongoDB 7
- 缓存与运行时加速：Redis 协议兼容服务

## 本地启动

### 前置依赖

- Node.js 20+
- Python 3.11+
- MongoDB 7
- Redis 7 或 Redis 协议兼容服务

Windows 本地环境推荐：

- MongoDB：MongoDB Community Server 7.x
- Redis：Memurai Developer

### 安装项目依赖

1. 安装前端依赖

```bash
npm install
```

2. 安装 Python 依赖

```bash
pip install -r python_services/requirements.txt
```

### 启动本地依赖

如果你已经把 MongoDB 和 Memurai 安装为 Windows 服务，可以直接启动：

```powershell
Start-Service MongoDB
Start-Service Memurai
```

可用下面的方式验证服务：

```powershell
sc query MongoDB
sc query Memurai
```

### 配置环境变量

在项目根目录创建 `.env.local`：

```env
PY_PLATFORM_STORAGE_BACKEND=mongo
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB_NAME=quantx_platform
REDIS_URL=redis://127.0.0.1:6379/0
```

如果你暂时不想启用 MongoDB，也可以不配置这些变量，后端会回退到本地 JSON 存储模式。

### 启动开发环境

整套开发环境：

```bash
npm run dev:all
```

只启动 Python 平台服务：

```bash
python python_services/run_server.py
```

启动后默认地址：

- 前端开发环境：`http://localhost:3000`
- Python 平台服务：`http://127.0.0.1:8800`

## 存储目录

### 策略档案目录

默认保存在：

`python_services/strategy_store/`

可通过环境变量 `PY_PLATFORM_STRATEGY_STORE` 自定义。

### 回测详情目录

回测摘要保存在主存储中，详细结果默认保存在：

`python_services/data/backtests/`

这样可以避免把整份大回测结果都塞进主状态存储，减少读取和写入压力。

## 当前存储架构

### MongoDB 7

用于保存主业务状态：

- 用户与会话
- 策略摘要
- 回测摘要
- 审计事件

### Redis

用于运行时加速：

- 策略列表缓存
- 回测列表缓存
- 运行时联通检测缓存
- 分布式锁预留

## 已完成的性能优化

- 回测摘要与回测详情拆分存储
- 前端改为摘要列表 + 单条详情按需加载
- GET 请求短 TTL 缓存与去重
- 联通检测缓存与并行探测
- 回测 OHLCV 改为直接走 FMZ 官方历史数据接口，去掉第二次 FMZ 引擎执行
- 主存储支持切换到 MongoDB，缓存支持切换到 Redis
