import { useEffect, useState } from "react";
import {
  authorizedFetch,
  PLATFORM_API_BASE,
  type BrokerRegistrySummary,
  type RuntimeConfig,
  type RuntimeOperations,
} from "../lib/platform-client";
import type {
  AppTab,
  AuditEventSummary,
  BacktestRunSummary,
  Connectivity,
  ConnectivityBroker,
  PlatformSnapshot,
  StrategySummary,
} from "./platform-types";

export function usePlatformSnapshot(activeTab: AppTab): PlatformSnapshot {
  const [user, setUser] = useState<{ email: string; roles?: string[] } | null>(null);
  const [brokers, setBrokers] = useState<BrokerRegistrySummary[]>([]);
  const [strategies, setStrategies] = useState<StrategySummary[]>([]);
  const [backtests, setBacktests] = useState<BacktestRunSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventSummary[]>([]);
  const [connectivity, setConnectivity] = useState<Connectivity | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [runtimeOperations, setRuntimeOperations] = useState<RuntimeOperations | null>(null);
  const [status, setStatus] = useState("姝ｅ湪鍚屾骞冲彴鐘舵€?..");

  const shouldLoadBrokers = activeTab === "dataCenter";
  const shouldLoadStrategies = activeTab === "dataCenter" || activeTab === "backtesting";
  const shouldLoadBacktests = activeTab === "dataCenter" || activeTab === "backtesting";
  const shouldLoadAudit = false;
  const shouldLoadConnectivity = activeTab === "dataCenter";
  const shouldLoadRuntime = activeTab === "dataCenter" || activeTab === "settings";
  const shouldLoadOperations = activeTab === "dataCenter";

  const reload = async (tab: AppTab = activeTab) => {
    try {
      const loadBrokers = tab === "dataCenter";
      const loadStrategies = tab === "dataCenter" || tab === "backtesting";
      const loadBacktests = tab === "dataCenter" || tab === "backtesting";
      const loadAudit = false;
      const loadConnectivity = tab === "dataCenter";
      const loadRuntime = tab === "dataCenter" || tab === "settings";

      const [me, nextBrokers, nextStrategies, nextBacktests, nextAudit, nextConnectivity, nextRuntime, nextOperations] = await Promise.all([
        authorizedFetch<{ user: { email: string; roles?: string[] } }>(`${PLATFORM_API_BASE}/me`, ""),
        loadBrokers ? authorizedFetch<BrokerRegistrySummary[]>(`${PLATFORM_API_BASE}/brokers`, "") : Promise.resolve(null),
        loadStrategies ? authorizedFetch<StrategySummary[]>(`${PLATFORM_API_BASE}/strategies`, "") : Promise.resolve(null),
        loadBacktests ? authorizedFetch<BacktestRunSummary[]>(`${PLATFORM_API_BASE}/backtests`, "") : Promise.resolve(null),
        loadAudit ? authorizedFetch<AuditEventSummary[]>(`${PLATFORM_API_BASE}/audit`, "") : Promise.resolve(null),
        loadConnectivity ? authorizedFetch<Connectivity>(`${PLATFORM_API_BASE}/runtime/connectivity`, "").catch(() => null) : Promise.resolve(null),
        loadRuntime ? authorizedFetch<RuntimeConfig>(`${PLATFORM_API_BASE}/runtime/config`, "").catch(() => null) : Promise.resolve(null),
        tab === "dataCenter" ? authorizedFetch<RuntimeOperations>(`${PLATFORM_API_BASE}/runtime/operations`, "").catch(() => null) : Promise.resolve(null),
      ]);

      setUser(me.user);
      if (nextBrokers) setBrokers(nextBrokers);
      if (nextStrategies) setStrategies(nextStrategies);
      if (nextBacktests) setBacktests(nextBacktests);
      if (nextAudit) setAuditEvents(nextAudit);
      if (nextConnectivity) setConnectivity(nextConnectivity);
      if (nextRuntime) setRuntimeConfig(nextRuntime);
      if (nextOperations) setRuntimeOperations(nextOperations);
      setStatus("骞冲彴鐘舵€佸凡鏇存柊");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "鍔犺浇骞冲彴鐘舵€佸け璐?");
    }
  };

  useEffect(() => {
    void reload(activeTab);
  }, [activeTab]);

  const mergeConnectivityBroker = (broker: ConnectivityBroker) => {
    setConnectivity((current) => {
      const previous = current?.brokers || [];
      const nextBrokers = previous.some((item) => item.brokerTarget === broker.brokerTarget)
        ? previous.map((item) => (item.brokerTarget === broker.brokerTarget ? { ...item, ...broker } : item))
        : [...previous, broker];
      return {
        ...(current || {}),
        brokers: nextBrokers,
        checkedAt: broker.checkedAt || Date.now(),
      };
    });
  };

  const saveNetworkClients = async (payload: RuntimeConfig["networkClients"]) => {
    const nextRuntime = await authorizedFetch<RuntimeConfig>(`${PLATFORM_API_BASE}/runtime/network-clients`, "", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setRuntimeConfig(nextRuntime);
    setConnectivity((current) => ({
      ...(current || {}),
      proxy: nextRuntime.proxy,
      checkedAt: Date.now(),
    }));
    setStatus("缃戠粶绔彛閰嶇疆宸蹭繚瀛?");
    return nextRuntime;
  };

  const refreshRuntimeConnectivity = async (forceRefresh = true) => {
    const nextConnectivity = await authorizedFetch<Connectivity>(
      `${PLATFORM_API_BASE}/runtime/connectivity${forceRefresh ? "?forceRefresh=1" : ""}`,
      "",
    ).catch(() => null);
    if (nextConnectivity) {
      setConnectivity(nextConnectivity);
    }
    return nextConnectivity;
  };

  const refreshRuntimeOperations = async (forceRefresh = true) => {
    const nextOperations = await authorizedFetch<RuntimeOperations>(
      `${PLATFORM_API_BASE}/runtime/operations${forceRefresh ? "?forceRefresh=1" : ""}`,
      "",
    ).catch(() => null);
    if (nextOperations) {
      setRuntimeOperations(nextOperations);
    }
    return nextOperations;
  };

  return {
    user,
    brokers: shouldLoadBrokers ? brokers : [],
    strategies: shouldLoadStrategies ? strategies : [],
    backtests: shouldLoadBacktests ? backtests : [],
    auditEvents: shouldLoadAudit ? auditEvents : [],
    connectivity: shouldLoadConnectivity ? connectivity : null,
    runtimeConfig: shouldLoadRuntime ? runtimeConfig : null,
    runtimeOperations: shouldLoadOperations ? runtimeOperations : null,
    status,
    reload,
    mergeConnectivityBroker,
    saveNetworkClients,
    refreshRuntimeConnectivity,
    refreshRuntimeOperations,
  };
}
