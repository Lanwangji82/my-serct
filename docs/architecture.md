# QuantX Architecture

## Overview

QuantX is organized around a single platform API and a small set of sidecar services:

- `src/`: React + Vite frontend
- `python_services/`: FastAPI platform API and core business logic
- `python_services/app/`: Python platform layering for adapters, repositories, and service modules
- `server/`: Node/TypeScript sidecars for market data, proxy integration, and local development tooling
- `config/`: shared runtime configuration files

## Runtime Roles

### FastAPI platform API

The Python service is the main source of truth for:

- runtime configuration
- network client settings
- strategy metadata
- backtests
- governance and audit data
- connectivity and latency inspection

The Python side is being refactored into explicit layers:

- `app/bootstrap/`: environment loading and runtime/storage assembly
  Includes the application factory that wires repositories, services, adapters, and route registration.
- `app/repositories/`: storage-facing access wrappers
- `app/services/`: auth, audit, runtime, strategy, and backtest workflows
- `app/adapters/`: broker/network specific infrastructure integrations
- `app/api/`: FastAPI route registration and request schema definitions
- `app/adapters/interfaces.py`: protocol-style extension points for broker and network integrations

### Node sidecars

The Node layer is reserved for sidecar responsibilities:

- exchange proxying
- market data helpers
- WebSocket or streaming bridges
- local development orchestration

Node services consume shared runtime configuration but do not own platform state.

## Shared Configuration

Runtime network routing is stored in:

- `config/network-clients.json`

Both Python and Node load this file so that:

- the settings UI updates one source of truth
- broker routing stays consistent across runtimes
- open-source users can adapt local proxy ports without editing application code

Environment variables remain supported as overrides for deployment-specific cases.

## Target Direction

The intended long-term structure is:

1. Frontend talks only to the FastAPI platform API.
2. FastAPI owns business workflows and persisted runtime settings.
3. Node sidecars expose narrowly scoped infrastructure capabilities.
4. Broker, market-data, and network integrations evolve into pluggable adapters.

## Current Refactor Status

The project has already moved part of the Python platform into reusable modules:

- auth and session flow now lives behind a dedicated auth service
- audit persistence now lives behind an audit service
- broker latency probing now goes through an adapter
- strategy, backtest, and runtime configuration logic are split out of `main.py`
- strategy and backtest services now live under `python_services/app/services/`
- runtime service now lives under `python_services/app/services/` and network runtime configuration is accessed through a dedicated adapter
- runtime config storage has also moved behind `python_services/app/adapters/`
- platform routes and request schemas now live under `python_services/app/api/`
- bootstrap and storage setup now live under `python_services/app/bootstrap/`, leaving `main.py` focused on app assembly
- service and adapter wiring now also lives under `python_services/app/bootstrap/`, so `main.py` stays close to a pure entrypoint
- broker latency probing no longer reaches into config storage directly; proxy resolution now comes through the network runtime adapter boundary
- broker targets and network implementations are now described through a bootstrap registry, which gives the project a clearer plugin-style extension surface
- adapter creation now also goes through the bootstrap registry, so adding a new network runtime or broker latency provider is primarily a registry change instead of a factory rewrite

The remaining direction is to keep shrinking `main.py` into a route entrypoint while making adapters and repositories the stable extension surface for open-source contributors.
