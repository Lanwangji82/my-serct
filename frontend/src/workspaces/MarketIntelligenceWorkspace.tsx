import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "../components/common/ui";
import { authorizedFetch, formatDateTime, PLATFORM_API_BASE } from "../lib/platform-client";
import { usePortfolioPositions } from "../hooks/usePortfolioPositions";

type MarketKey = "a_share" | "crypto";
type ProviderKey = "all" | "reuters" | "gelonghui";
type SentimentKey = "all" | "bullish" | "bearish" | "neutral";

type Headline = {
  id: string;
  market: MarketKey;
  title: string;
  source: string;
  publishedAt: number;
  url: string;
  summary: string;
  tags: string[];
};

type Overview = {
  generatedAt: number;
  live: boolean;
  summary: {
    headline: string;
    liveSources: number;
    totalSources: number;
    topTheme: string;
  };
  headlines: Headline[];
};

type ArtifactEvent = {
  id: string;
  eventId: string;
  market: MarketKey;
  title: string;
  summary: string;
  summaryLines: string[];
  eventType: string;
  eventTypeLabel: string;
  sentiment: "bullish" | "bearish" | "neutral";
  sentimentLabel: string;
  assets: Array<{ kind: string; symbol: string; label: string }>;
  sourceList: string[];
  publishTime: number;
  importanceScore: number;
  execution: { state: "observe" | "track" | "actionable"; label: string; reason: string };
  tags: string[];
  sources: string[];
  freshness: "new" | "tracked";
  headlines: Array<{ id: string; title: string; source: string; publishedAt: number; url?: string }>;
};

type ArtifactPayload = {
  market: MarketKey;
  generatedAt: number;
  newsEvents: ArtifactEvent[];
};

type SearchResult = {
  kind: "news" | "event";
  market: MarketKey;
  id: string;
  title: string;
  summary: string;
  tags: string[];
  source?: string;
  sources?: string[];
  publishedAt: number;
  url?: string;
};

type SearchPayload = {
  query: string;
  market: string;
  items: SearchResult[];
};

type NewsFeedItem = {
  id: string;
  kind: "headline" | "event" | "search";
  market: MarketKey;
  title: string;
  source: string;
  publishedAt: number;
  summary: string;
  summaryLines: string[];
  url?: string;
  tags: string[];
  category: string;
  categoryLabel: string;
  sentiment?: "bullish" | "bearish" | "neutral";
  sentimentLabel?: string;
  assets: Array<{ symbol: string; label: string }>;
  importanceScore: number;
  freshness?: string;
  providerGroup: ProviderKey;
  executionLabel?: string;
  executionReason?: string;
  commodities: string[];
};

type WatchlistOption = {
  key: string;
  label: string;
  market: MarketKey;
  symbol: string;
  aliases: string[];
};

type FilterMenuProps = {
  label: string;
  valueLabel: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  options: Array<{ value: string; label: string; hint?: string }>;
  selectedValue: string;
  onSelect: (value: string) => void;
  minWidthClass?: string;
};

const COMMODITY_LIBRARY = [
  { code: "BRC", aliases: ["BRC", "BRENT", "BRENT CRUDE", "布伦特", "布伦特原油"] },
  { code: "XAG", aliases: ["XAG", "SILVER", "白银"] },
  { code: "XAU", aliases: ["XAU", "GOLD", "黄金"] },
  { code: "WTI", aliases: ["WTI", "原油", "美油"] },
  { code: "BTC", aliases: ["BTC", "BITCOIN", "比特币"] },
  { code: "ETH", aliases: ["ETH", "ETHEREUM", "以太坊"] },
  { code: "SOL", aliases: ["SOL", "SOLANA"] },
  { code: "XRP", aliases: ["XRP", "RIPPLE"] },
];

function providerTone(source: string) {
  const normalized = source.toLowerCase();
  if (normalized.includes("reuters")) return "warning";
  if (normalized.includes("gelonghui")) return "default";
  return "outline";
}

function sentimentTone(value?: "bullish" | "bearish" | "neutral") {
  if (value === "bullish") return "success";
  if (value === "bearish") return "warning";
  return "outline";
}

function formatRelativeTime(value: number) {
  const diffMinutes = Math.max(1, Math.floor((Date.now() - value) / 60_000));
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  return formatDateTime(value);
}

function normalizeProvider(source: string): ProviderKey {
  const normalized = source.toLowerCase();
  if (normalized.includes("reuters")) return "reuters";
  if (normalized.includes("gelonghui")) return "gelonghui";
  return "all";
}

function extractCommodities(title: string, summary: string, tags: string[], assets: Array<{ symbol: string; label: string }>) {
  const haystack = [title, summary, ...tags, ...assets.map((item) => item.symbol), ...assets.map((item) => item.label)].join(" ").toUpperCase();
  return COMMODITY_LIBRARY.filter((item) => item.aliases.some((alias) => haystack.includes(alias.toUpperCase()))).map((item) => item.code);
}

function matchesWatchlist(item: NewsFeedItem, watchlist: WatchlistOption) {
  const haystack = [item.title, item.summary, ...item.tags, ...item.assets.map((asset) => asset.symbol), ...item.assets.map((asset) => asset.label)]
    .join(" ")
    .toUpperCase();
  return watchlist.aliases.some((alias) => haystack.includes(alias.toUpperCase()));
}

function FilterMenu(props: FilterMenuProps) {
  return (
    <div className={`relative ${props.minWidthClass || "min-w-[132px]"}`}>
      <button
        type="button"
        onClick={props.onToggle}
        className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-2 text-sm transition ${
          props.open ? "border-zinc-500 bg-zinc-900 text-zinc-50" : "border-zinc-800 bg-zinc-900/35 text-zinc-300 hover:border-zinc-700"
        }`}
      >
        <span className="truncate">{props.valueLabel || props.label}</span>
        <span className="text-xs text-zinc-500">{props.open ? "收起" : "展开"}</span>
      </button>
      {props.open ? (
        <>
          <button type="button" aria-label="close" className="fixed inset-0 z-10 cursor-default" onClick={props.onClose} />
          <div className="absolute left-0 top-[calc(100%+8px)] z-20 w-full min-w-[220px] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40">
            <div className="border-b border-zinc-800 px-4 py-3 text-xs uppercase tracking-[0.18em] text-zinc-500">{props.label}</div>
            <div className="max-h-72 overflow-y-auto py-2">
              {props.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    props.onSelect(option.value);
                    props.onClose();
                  }}
                  className={`w-full px-4 py-3 text-left transition ${props.selectedValue === option.value ? "bg-zinc-100/10 text-zinc-50" : "text-zinc-300 hover:bg-zinc-900"}`}
                >
                  <div className="text-sm">{option.label}</div>
                  {option.hint ? <div className="mt-1 text-xs text-zinc-500">{option.hint}</div> : null}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function MarketIntelligenceWorkspace() {
  const portfolio = usePortfolioPositions();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [status, setStatus] = useState("正在加载新闻流...");
  const [refreshing, setRefreshing] = useState(false);
  const [marketFilter, setMarketFilter] = useState<"all" | MarketKey>("all");
  const [watchlistFilter, setWatchlistFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState<ProviderKey>("all");
  const [commodityFilter, setCommodityFilter] = useState("all");
  const [sentimentFilter, setSentimentFilter] = useState<SentimentKey>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactPayload>>({});
  const [selectedId, setSelectedId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [openMenu, setOpenMenu] = useState<null | "watchlist" | "provider" | "commodity" | "category">(null);

  const loadOverview = async (forceRefresh = false) => {
    setRefreshing(true);
    try {
      const nextOverview = await authorizedFetch<Overview>(`${PLATFORM_API_BASE}/intelligence/overview${forceRefresh ? "?forceRefresh=true" : ""}`, "");
      setOverview(nextOverview);
      setStatus(nextOverview.live ? "新闻流已更新。" : "部分数据源暂时不可用，当前显示缓存结果。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "加载新闻流失败");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadOverview();
  }, []);

  useEffect(() => {
    const markets: MarketKey[] = marketFilter === "all" ? ["a_share", "crypto"] : [marketFilter];
    void Promise.all(
      markets.map(async (market) => {
        const payload = await authorizedFetch<ArtifactPayload>(`${PLATFORM_API_BASE}/intelligence/artifacts/${market}`, "");
        return [market, payload] as const;
      }),
    )
      .then((items) => {
        setArtifacts((current) => {
          const next = { ...current };
          for (const [market, payload] of items) next[market] = payload;
          return next;
        });
      })
      .catch(() => {});
  }, [marketFilter, overview?.generatedAt]);

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const marketParam = marketFilter === "all" ? "" : `&market=${marketFilter}`;
      const payload = await authorizedFetch<SearchPayload>(`${PLATFORM_API_BASE}/intelligence/search?q=${encodeURIComponent(query)}${marketParam}&limit=12`, "");
      setSearchResults(payload.items || []);
      setStatus(`已检索 “${query}”`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "新闻检索失败");
    } finally {
      setSearching(false);
    }
  };

  const watchlistOptions = useMemo<WatchlistOption[]>(() => {
    const dedup = new Map<string, WatchlistOption>();
    for (const position of portfolio.data?.positions || []) {
      const key = `${position.market}:${position.symbol}`;
      dedup.set(key, {
        key,
        symbol: position.symbol,
        market: position.market,
        label: position.label || position.symbol,
        aliases: [position.symbol, position.label || position.symbol].filter(Boolean),
      });
    }
    return Array.from(dedup.values()).sort((left, right) => left.label.localeCompare(right.label));
  }, [portfolio.data?.positions]);

  const watchlistMap = useMemo(() => new Map(watchlistOptions.map((item) => [item.key, item])), [watchlistOptions]);

  const feedItems = useMemo<NewsFeedItem[]>(() => {
    const eventRows = (marketFilter === "all" ? ["a_share", "crypto"] : [marketFilter]).flatMap((market) => artifacts[market]?.newsEvents || []);
    const mappedEvents: NewsFeedItem[] = eventRows.map((event) => {
      const source = (event.sourceList[0] || event.sources[0] || "系统聚合").trim();
      const assets = event.assets.map((asset) => ({ symbol: asset.symbol, label: asset.label }));
      return {
        id: `event:${event.eventId}`,
        kind: "event",
        market: event.market,
        title: event.title,
        source,
        publishedAt: event.publishTime,
        summary: event.summary,
        summaryLines: event.summaryLines.length ? event.summaryLines : [event.summary],
        url: event.headlines[0]?.url,
        tags: event.tags || [],
        category: event.eventType,
        categoryLabel: event.eventTypeLabel,
        sentiment: event.sentiment,
        sentimentLabel: event.sentimentLabel,
        assets,
        importanceScore: event.importanceScore,
        freshness: event.freshness,
        providerGroup: normalizeProvider(source),
        executionLabel: event.execution.label,
        executionReason: event.execution.reason,
        commodities: extractCommodities(event.title, event.summary, event.tags || [], assets),
      };
    });

    const mappedHeadlines: NewsFeedItem[] = (overview?.headlines || []).map((headline) => {
      const assets: Array<{ symbol: string; label: string }> = [];
      return {
        id: `headline:${headline.id}`,
        kind: "headline",
        market: headline.market,
        title: headline.title,
        source: headline.source || "新闻源",
        publishedAt: headline.publishedAt,
        summary: headline.summary,
        summaryLines: [headline.summary || headline.title],
        url: headline.url,
        tags: headline.tags || [],
        category: "headline",
        categoryLabel: "快讯",
        assets,
        importanceScore: 40,
        providerGroup: normalizeProvider(headline.source || ""),
        commodities: extractCommodities(headline.title, headline.summary, headline.tags || [], assets),
      };
    });

    const mappedSearch: NewsFeedItem[] = searchResults.map((item) => {
      const assets: Array<{ symbol: string; label: string }> = [];
      const source = item.source || item.sources?.[0] || "搜索结果";
      return {
        id: `search:${item.kind}:${item.id}`,
        kind: "search",
        market: item.market,
        title: item.title,
        source,
        publishedAt: item.publishedAt,
        summary: item.summary,
        summaryLines: [item.summary],
        url: item.url,
        tags: item.tags || [],
        category: item.kind,
        categoryLabel: item.kind === "event" ? "事件" : "新闻",
        assets,
        importanceScore: 60,
        providerGroup: normalizeProvider(source),
        commodities: extractCommodities(item.title, item.summary, item.tags || [], assets),
      };
    });

    const merged = [...mappedSearch, ...mappedEvents, ...mappedHeadlines];
    return merged
      .filter((item) => (marketFilter === "all" ? true : item.market === marketFilter))
      .filter((item) => (providerFilter === "all" ? true : item.providerGroup === providerFilter))
      .filter((item) => (sentimentFilter === "all" ? true : item.sentiment === sentimentFilter))
      .filter((item) => (categoryFilter === "all" ? true : item.category === categoryFilter))
      .filter((item) => (commodityFilter === "all" ? true : item.commodities.includes(commodityFilter)))
      .filter((item) => {
        if (watchlistFilter === "all") return true;
        const watchlist = watchlistMap.get(watchlistFilter);
        return watchlist ? matchesWatchlist(item, watchlist) : true;
      })
      .sort((left, right) => (right.importanceScore !== left.importanceScore ? right.importanceScore - left.importanceScore : right.publishedAt - left.publishedAt));
  }, [artifacts, categoryFilter, commodityFilter, marketFilter, overview?.headlines, providerFilter, searchResults, sentimentFilter, watchlistFilter, watchlistMap]);

  useEffect(() => {
    if (!feedItems.length) {
      setSelectedId("");
      return;
    }
    if (!selectedId || !feedItems.some((item) => item.id === selectedId)) {
      setSelectedId(feedItems[0].id);
    }
  }, [feedItems, selectedId]);

  const selectedItem = feedItems.find((item) => item.id === selectedId) || null;

  const categoryOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const item of [...feedItems]) values.set(item.category, item.categoryLabel);
    return Array.from(values.entries()).map(([value, label]) => ({ value, label }));
  }, [feedItems]);

  const commodityOptions = useMemo(() => {
    const values = new Set<string>();
    for (const item of [...feedItems]) {
      for (const commodity of item.commodities) values.add(commodity);
    }
    return Array.from(values).sort().map((value) => ({
      value,
      label: value,
      hint: COMMODITY_LIBRARY.find((item) => item.code === value)?.aliases.slice(1, 3).join(" / "),
    }));
  }, [feedItems]);

  const watchlistLabel = watchlistFilter === "all" ? "自选表" : watchlistMap.get(watchlistFilter)?.label || "自选表";
  const providerLabel =
    providerFilter === "all" ? "提供商" : providerFilter === "reuters" ? "Reuters" : providerFilter === "gelonghui" ? "Gelonghui" : "提供商";
  const commodityLabel = commodityFilter === "all" ? "商品" : commodityFilter;
  const categoryLabel = categoryFilter === "all" ? "板块" : categoryOptions.find((item) => item.value === categoryFilter)?.label || "板块";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-sm text-zinc-500">新闻流</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-50">完整新闻流</h1>
          <p className="mt-2 text-sm text-zinc-500">按时间流查看 A 股和加密相关新闻，自选表筛你自己的股票和代币，右侧看详情。</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{overview ? `${overview.summary.liveSources}/${overview.summary.totalSources} 在线源` : "新闻源"}</Badge>
          <Button variant="outline" onClick={() => void loadOverview(true)} disabled={refreshing}>
            {refreshing ? "刷新中..." : "刷新新闻流"}
          </Button>
        </div>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85 p-4">
        <div className="flex flex-wrap gap-2">
          <FilterMenu
            label="自选表"
            valueLabel={watchlistLabel}
            open={openMenu === "watchlist"}
            onToggle={() => setOpenMenu((current) => (current === "watchlist" ? null : "watchlist"))}
            onClose={() => setOpenMenu(null)}
            selectedValue={watchlistFilter}
            onSelect={setWatchlistFilter}
            options={[
              { value: "all", label: "全部自选", hint: "根据你的持仓和自选标的过滤新闻" },
              ...watchlistOptions.map((item) => ({
                value: item.key,
                label: item.label,
                hint: `${item.market === "a_share" ? "A股" : "加密"} · ${item.symbol}`,
              })),
            ]}
            minWidthClass="min-w-[150px]"
          />

          <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/35 p-1">
            {[
              { id: "all", label: "市场" },
              { id: "a_share", label: "A股" },
              { id: "crypto", label: "加密" },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setMarketFilter(item.id as "all" | MarketKey)}
                className={`rounded-lg px-4 py-2 text-sm transition ${marketFilter === item.id ? "bg-zinc-100 text-zinc-950" : "text-zinc-300 hover:text-zinc-50"}`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <FilterMenu
            label="板块"
            valueLabel={categoryLabel}
            open={openMenu === "category"}
            onToggle={() => setOpenMenu((current) => (current === "category" ? null : "category"))}
            onClose={() => setOpenMenu(null)}
            selectedValue={categoryFilter}
            onSelect={setCategoryFilter}
            options={[{ value: "all", label: "全部板块" }, ...categoryOptions]}
          />

          <FilterMenu
            label="商品"
            valueLabel={commodityLabel}
            open={openMenu === "commodity"}
            onToggle={() => setOpenMenu((current) => (current === "commodity" ? null : "commodity"))}
            onClose={() => setOpenMenu(null)}
            selectedValue={commodityFilter}
            onSelect={setCommodityFilter}
            options={[{ value: "all", label: "全部商品" }, ...commodityOptions]}
          />

          <FilterMenu
            label="提供商"
            valueLabel={providerLabel}
            open={openMenu === "provider"}
            onToggle={() => setOpenMenu((current) => (current === "provider" ? null : "provider"))}
            onClose={() => setOpenMenu(null)}
            selectedValue={providerFilter}
            onSelect={(value) => setProviderFilter(value as ProviderKey)}
            options={[
              { value: "all", label: "全部提供商" },
              { value: "reuters", label: "Reuters" },
              { value: "gelonghui", label: "Gelonghui" },
            ]}
          />

          <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/35 p-1">
            {[
              { id: "all", label: "倾向" },
              { id: "bullish", label: "利多" },
              { id: "bearish", label: "利空" },
              { id: "neutral", label: "中性" },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSentimentFilter(item.id as SentimentKey)}
                className={`rounded-lg px-4 py-2 text-sm transition ${sentimentFilter === item.id ? "bg-zinc-100 text-zinc-950" : "text-zinc-300 hover:text-zinc-50"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSearch();
            }}
            placeholder="搜索公司、股票、代币、商品或事件"
            className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/35 px-4 py-2 text-sm text-white outline-none focus:border-zinc-600"
          />
          <Button onClick={() => void handleSearch()} disabled={searching}>
            {searching ? "检索中..." : "检索"}
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-0 overflow-hidden rounded-[28px] border border-zinc-800 bg-zinc-950/85 xl:grid-cols-[1.45fr_0.95fr]">
        <div className="border-r border-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
            <div className="text-sm font-medium text-zinc-200">{feedItems.length} 条新闻</div>
            <div className="text-xs text-zinc-500">{overview?.generatedAt ? formatDateTime(overview.generatedAt) : status}</div>
          </div>
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
            {feedItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={`w-full border-b border-zinc-800 px-5 py-4 text-left transition ${selectedId === item.id ? "bg-zinc-100/8" : "hover:bg-zinc-900/55"}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <Badge variant={providerTone(item.source)}>{item.source || "新闻源"}</Badge>
                  <span>{formatRelativeTime(item.publishedAt)}</span>
                  <span>·</span>
                  <span>{item.market === "a_share" ? "A股" : "加密"}</span>
                  <span>·</span>
                  <span>{item.categoryLabel}</span>
                </div>
                <div className="mt-3 text-xl leading-8 text-zinc-50">{item.title}</div>
                <div className="mt-3 line-clamp-2 text-sm leading-6 text-zinc-400">{item.summary}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.sentimentLabel ? <Badge variant={sentimentTone(item.sentiment)}>{item.sentimentLabel}</Badge> : null}
                  {item.executionLabel ? <Badge variant="outline">{item.executionLabel}</Badge> : null}
                  {item.commodities.slice(0, 2).map((commodity) => (
                    <Badge key={`${item.id}-${commodity}`} variant="outline">
                      {commodity}
                    </Badge>
                  ))}
                  {item.assets.slice(0, 3).map((asset) => (
                    <Badge key={`${item.id}-${asset.symbol}`} variant="default">
                      {asset.label}
                    </Badge>
                  ))}
                </div>
              </button>
            ))}
            {feedItems.length === 0 ? <div className="px-5 py-10 text-sm text-zinc-500">当前筛选条件下没有新闻，试试切换市场、自选表、商品或提供商。</div> : null}
          </div>
        </div>

        <div className="min-h-[720px] bg-zinc-950/95">
          {selectedItem ? (
            <div className="sticky top-0 space-y-6 px-8 py-8">
              <div className="flex items-center justify-between gap-3">
                <Badge variant={providerTone(selectedItem.source)}>{selectedItem.source || "新闻源"}</Badge>
                {selectedItem.url ? (
                  <a
                    href={selectedItem.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-zinc-800 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-700 hover:text-zinc-100"
                  >
                    原文
                  </a>
                ) : null}
              </div>

              <div>
                <h2 className="text-4xl font-semibold leading-[1.2] tracking-tight text-zinc-50">{selectedItem.title}</h2>
                <div className="mt-4 text-sm text-zinc-500">
                  {formatDateTime(selectedItem.publishedAt)} · {selectedItem.market === "a_share" ? "A股市场" : "加密市场"} · {selectedItem.categoryLabel}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {selectedItem.sentimentLabel ? <Badge variant={sentimentTone(selectedItem.sentiment)}>{selectedItem.sentimentLabel}</Badge> : null}
                {selectedItem.executionLabel ? <Badge variant="outline">{selectedItem.executionLabel}</Badge> : null}
                {selectedItem.commodities.map((commodity) => (
                  <Badge key={`${selectedItem.id}-${commodity}`} variant="outline">
                    {commodity}
                  </Badge>
                ))}
                {selectedItem.assets.map((asset) => (
                  <Badge key={`${selectedItem.id}-${asset.symbol}`} variant="default">
                    {asset.label}
                  </Badge>
                ))}
              </div>

              <div className="space-y-3 text-[17px] leading-8 text-zinc-200">
                {selectedItem.summaryLines.map((line, index) => (
                  <p key={`${selectedItem.id}-${index}`}>{line}</p>
                ))}
              </div>

              {selectedItem.executionReason ? (
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/55 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">规则判断</div>
                  <div className="mt-3 text-sm leading-7 text-zinc-300">{selectedItem.executionReason}</div>
                </div>
              ) : null}

              {selectedItem.tags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {selectedItem.tags.map((tag) => (
                    <Badge key={`${selectedItem.id}-${tag}`} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {selectedItem.url ? (
                <a
                  href={selectedItem.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-full items-center justify-center rounded-2xl border border-zinc-700 px-4 py-4 text-base text-zinc-100 transition hover:border-zinc-500 hover:bg-zinc-900"
                >
                  阅读更多
                </a>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-sm text-zinc-500">从左侧选择一条新闻查看详情。</div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
