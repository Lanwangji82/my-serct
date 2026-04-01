import { useEffect, useRef, useState } from "react";
import { authorizedFetch } from "../lib/platform-client";

export type PortfolioEvent = {
  eventId: string;
  title: string;
  sentimentLabel: string;
  executionLabel: string;
  publishedAt: number;
};

export type PortfolioPosition = {
  positionId: string;
  accountId: string;
  accountLabel: string;
  scopeId?: string;
  market: "a_share" | "crypto";
  providerId: string;
  exchangeId?: string;
  connectionMode: "live" | "paper";
  symbol: string;
  label: string;
  assetType: string;
  side: string;
  quantity: number;
  availableQuantity?: number;
  frozenQuantity?: number;
  avgCost: number;
  lastPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  currency: string;
  strategyType?: string;
  thesis?: string;
  exitRule?: string;
  entryRegime?: string;
  currentRegime?: string;
  latestEvents: PortfolioEvent[];
  reminders: string[];
  updatedAt: number;
  raw?: Record<string, unknown>;
};

export type PortfolioSummaryRow = {
  accountId: string;
  accountLabel: string;
  market: "a_share" | "crypto";
  providerId: string;
  exchangeId?: string;
  marketValue: number;
  unrealizedPnl: number;
  positionCount: number;
  scopes?: string[];
};

export type PortfolioPayload = {
  generatedAt: number;
  totals: {
    marketValue: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number;
    positionCount: number;
    accountCount: number;
  };
  byMarket: Array<{
    market: "a_share" | "crypto";
    marketValue: number;
    unrealizedPnl: number;
    positionCount: number;
  }>;
  byAccount: PortfolioSummaryRow[];
  positions: PortfolioPosition[];
};

type PortfolioFilters = { market?: string; accountId?: string; connectionMode?: string };

const POLL_INTERVAL_MS = 5_000;

function buildPath(nextFilters: PortfolioFilters = {}) {
  const query = new URLSearchParams();
  if (nextFilters.market && nextFilters.market !== "all") query.set("market", nextFilters.market);
  if (nextFilters.accountId && nextFilters.accountId !== "all") query.set("accountId", nextFilters.accountId);
  if (nextFilters.connectionMode && nextFilters.connectionMode !== "all") query.set("connectionMode", nextFilters.connectionMode);
  return query.toString() ? `/portfolio/positions?${query.toString()}` : "/portfolio/positions";
}

export function usePortfolioPositions(filters?: PortfolioFilters) {
  const [data, setData] = useState<PortfolioPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const requestSeqRef = useRef(0);

  const reload = async (nextFilters: PortfolioFilters = filters || {}, options?: { silent?: boolean }) => {
    const requestSeq = ++requestSeqRef.current;
    const silent = Boolean(options?.silent);
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const payload = await authorizedFetch<PortfolioPayload>(buildPath(nextFilters), "");
      if (requestSeq !== requestSeqRef.current) return null;
      setData(payload);
      setError("");
      return payload;
    } catch (nextError) {
      if (requestSeq === requestSeqRef.current) {
        setError(nextError instanceof Error ? nextError.message : "加载持仓失败");
      }
      return null;
    } finally {
      if (requestSeq === requestSeqRef.current) {
        if (silent) {
          setRefreshing(false);
        } else {
          setLoading(false);
        }
      }
    }
  };

  useEffect(() => {
    void reload(filters || {});
  }, [filters?.accountId, filters?.market, filters?.connectionMode]);

  useEffect(() => {
    let timer: number | null = null;

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (typeof window !== "undefined" && !window.navigator.onLine) return;
      void reload(filters || {}, { silent: true });
    };

    if (typeof window !== "undefined") {
      timer = window.setInterval(tick, POLL_INTERVAL_MS);
    }

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void reload(filters || {}, { silent: true });
      }
    };

    const handleFocus = () => {
      void reload(filters || {}, { silent: true });
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleFocus);
    }

    return () => {
      if (timer !== null && typeof window !== "undefined") {
        window.clearInterval(timer);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleFocus);
      }
    };
  }, [filters?.accountId, filters?.market, filters?.connectionMode]);

  return {
    data,
    loading,
    refreshing,
    error,
    reload,
  };
}
