<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# QuantX Platform

QuantX 是一个面向研究、回测、执行与治理的一体化量化平台。

当前核心技术栈：

- 前端：React + TypeScript
- 后端：Python + FastAPI
- 数据处理：Polars
- 回测：VectorBT
- 执行：CCXT

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

## 策略与平台文档

- [量化策略函数手册](/D:/quantx-platform/docs/量化策略函数手册.md)
- [平台策略落盘与治理说明](/D:/quantx-platform/docs/平台策略落盘与治理说明.md)
- [平台公司化推进路线图](/D:/quantx-platform/docs/平台公司化推进路线图.md)

## 当前策略落盘目录

默认保存在：

`python_services/strategy_store/`

可通过环境变量 `PY_PLATFORM_STRATEGY_STORE` 自定义。
