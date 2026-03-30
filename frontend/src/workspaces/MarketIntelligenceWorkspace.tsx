import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "../components/common/ui";
import { authorizedFetch, formatDateTime, PLATFORM_API_BASE } from "../lib/platform-client";

type MarketKey = "a_share" | "crypto";
type Tone = "normal" | "attention";

type Tile = { symbol: string; label: string; last: number; changePct: number; commentary: string };
type Theme = { id: string; label: string; score: number; summary: string; keywords: string[] };
type Headline = { id: string; market: MarketKey; title: string; source: string; publishedAt: number; url: string; summary: string; tags: string[] };
type WatchItem = { symbol: string; label: string; signal: string; reason: string; changePct: number; price?: number };
type PulseItem = { symbol: string; label: string; signal: string; reason: string; changePct: number };
type EventItem = { id: string; exchange: string; title: string; summary: string; severity: Tone; publishedAt: number };
type NewsGroup = { groupId: string; label: string; count: number; summary: string; items: Headline[] };

type Market = {
  market: MarketKey;
  label: string;
  generatedAt: number;
  overview: { headline: string; mood: string; breadth: string; commentary: string; verdict: string };
  tiles: Tile[];
  themes: Theme[];
  watchlist: WatchItem[];
  pulse: PulseItem[];
  events: EventItem[];
  headlines: Headline[];
  newsGroups: NewsGroup[];
};

type Overview = {
  generatedAt: number;
  live: boolean;
  summary: { headline: string; liveSources: number; totalSources: number; topTheme: string; riskMode?: { label: string; hint: string; reasons: string } };
  markets: Market[];
  topThemes: Theme[];
  headlines: Headline[];
};

type ArtifactDigest = {
  id: string;
  market: MarketKey;
  marketLabel: string;
  kind: string;
  mode?: "llm" | "system";
  label: string;
  summary: string;
  focus?: string;
  risks?: string;
  action?: string;
  confidence?: string;
  count: number;
  generatedAt: number;
};

type ArtifactEvent = {
  id: string;
  eventId: string;
  market: MarketKey;
  title: string;
  label: string;
  summary: string;
  summaryLines: string[];
  eventType: string;
  eventTypeLabel: string;
  sentiment: "bullish" | "bearish" | "neutral";
  sentimentLabel: string;
  assets: Array<{ kind: string; symbol: string; label: string }>;
  sectorOrTheme?: string;
  sourceList: string[];
  publishTime: number;
  eventTime: number;
  confidence: "low" | "medium" | "high";
  importanceScore: number;
  worthTracking: boolean;
  observationState: "observe" | "track" | "watch";
  novelty: { label: "new_signal" | "incremental" | "known_story"; title: string; summary: string; score: number };
  similarEvents: Array<{ id: string; title: string; sentimentLabel: string; publishedAt: number; score: number }>;
  execution: { state: "observe" | "track" | "actionable"; label: string; reason: string };
  count: number;
  tags: string[];
  sources: string[];
  publishedAt: number;
  freshness: "new" | "tracked";
  headlines: Array<{ id: string; title: string; source: string; publishedAt: number; url?: string }>;
};

type ArtifactPayload = { market: MarketKey; generatedAt: number; newsEvents: ArtifactEvent[]; llmDigests?: ArtifactDigest[]; brief?: BriefCard };
type BriefSection = { id: string; title: string; content: string };
type BriefCard = { market: MarketKey; label: string; generatedAt: number; headline: string; summary: string; sections: BriefSection[] };
type BriefPayload = { market: string; generatedAt: number; briefs: BriefCard[] };
type SearchResult = { kind: "news" | "event"; market: MarketKey; id: string; title: string; summary: string; tags: string[]; source?: string; sources?: string[]; publishedAt: number; url?: string; count?: number; score: number; searchMode?: string };
type SearchPayload = { query: string; market: string; mode?: string; items: SearchResult[] };

function changeTone(value: number) {
  if (value > 0) return "text-rose-400";
  if (value < 0) return "text-emerald-400";
  return "text-zinc-300";
}

function sentimentVariant(value: ArtifactEvent["sentiment"]) {
  if (value === "bullish") return "success";
  if (value === "bearish") return "warning";
  return "outline";
}

function observationStateLabel(value: ArtifactEvent["observationState"]) {
  if (value === "watch") return "进入观察池";
  if (value === "track") return "继续跟踪";
  return "先观察";
}

function confidenceLabel(value: ArtifactEvent["confidence"]) {
  if (value === "high") return "高";
  if (value === "medium") return "中";
  return "低";
}

function executionVariant(value: ArtifactEvent["execution"]["state"]) {
  if (value === "actionable") return "success";
  if (value === "track") return "warning";
  return "outline";
}

function formatCompact(value: number, digits = 2) {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function MarketIntelligenceWorkspace() {
  const EVENTS_PER_PAGE = 2;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [status, setStatus] = useState("正在加载市场情报...");
  const [refreshing, setRefreshing] = useState(false);
  const [marketFilter, setMarketFilter] = useState<"all" | MarketKey>("all");
  const [eventSentimentFilter, setEventSentimentFilter] = useState<"all" | "bullish" | "bearish" | "neutral">("all");
  const [eventTrackingFilter, setEventTrackingFilter] = useState<"all" | "worth_tracking" | "watch">("all");
  const [eventPage, setEventPage] = useState(1);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactPayload>>({});
  const [briefs, setBriefs] = useState<BriefCard[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const loadOverview = async (forceRefresh = false) => {
    setRefreshing(true);
    try {
      const nextOverview = await authorizedFetch<Overview>(`${PLATFORM_API_BASE}/intelligence/overview${forceRefresh ? "?forceRefresh=true" : ""}`, "");
      setOverview(nextOverview);
      setStatus(nextOverview.live ? "市场情报已更新。" : "部分数据源暂时不可用，当前显示缓存结果。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "加载市场情报失败");
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
      })
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

  useEffect(() => {
    const marketParam = marketFilter === "all" ? "" : `?market=${marketFilter}`;
    void authorizedFetch<BriefPayload>(`${PLATFORM_API_BASE}/intelligence/brief${marketParam}`, "").then((payload) => setBriefs(payload.briefs || [])).catch(() => {});
  }, [marketFilter, overview?.generatedAt]);

  const visibleMarkets = useMemo(() => {
    if (!overview) return [];
    return marketFilter === "all" ? overview.markets : overview.markets.filter((item) => item.market === marketFilter);
  }, [marketFilter, overview]);

  const filteredEvents = useMemo(() => {
    const markets: MarketKey[] = marketFilter === "all" ? ["a_share", "crypto"] : [marketFilter];
    const rows = markets.flatMap((market) => artifacts[market]?.newsEvents || []);
    return [...rows]
      .filter((item) => (eventSentimentFilter === "all" ? true : item.sentiment === eventSentimentFilter))
      .filter((item) => {
        if (eventTrackingFilter === "worth_tracking") return item.worthTracking;
        if (eventTrackingFilter === "watch") return item.observationState === "watch";
        return true;
      })
      .sort((left, right) => (left.importanceScore !== right.importanceScore ? right.importanceScore - left.importanceScore : right.publishTime - left.publishTime));
  }, [artifacts, eventSentimentFilter, eventTrackingFilter, marketFilter]);

  const totalEventPages = Math.max(1, Math.ceil(filteredEvents.length / EVENTS_PER_PAGE));
  const visibleEvents = useMemo(() => {
    const start = (eventPage - 1) * EVENTS_PER_PAGE;
    return filteredEvents.slice(start, start + EVENTS_PER_PAGE);
  }, [eventPage, filteredEvents]);

  useEffect(() => {
    setEventPage(1);
  }, [marketFilter, eventSentimentFilter, eventTrackingFilter]);

  useEffect(() => {
    if (eventPage > totalEventPages) setEventPage(totalEventPages);
  }, [eventPage, totalEventPages]);

  const visibleDigests = useMemo(() => {
    const markets: MarketKey[] = marketFilter === "all" ? ["a_share", "crypto"] : [marketFilter];
    const rows = markets.flatMap((market) => artifacts[market]?.llmDigests || []);
    return [...rows].sort((left, right) => ((left.mode === "llm") !== (right.mode === "llm") ? (left.mode === "llm" ? -1 : 1) : right.generatedAt - left.generatedAt)).slice(0, marketFilter === "all" ? 6 : 4);
  }, [artifacts, marketFilter]);

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const marketParam = marketFilter === "all" ? "" : `&market=${marketFilter}`;
      const payload = await authorizedFetch<SearchPayload>(`${PLATFORM_API_BASE}/intelligence/search?q=${encodeURIComponent(query)}${marketParam}&limit=10`, "");
      setSearchResults(payload.items || []);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "新闻检索失败");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">市场情报</h1>
          <p className="mt-1 text-sm text-zinc-500">把新闻从信息流整理成事件卡片，先服务你的观察和跟踪决策。</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-1">
            {[
              { id: "all", label: "全部" },
              { id: "a_share", label: "A股" },
              { id: "crypto", label: "加密" },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setMarketFilter(item.id as "all" | MarketKey)}
                className={`rounded-lg px-3 py-1.5 text-sm transition ${marketFilter === item.id ? "bg-zinc-100 text-zinc-950" : "text-zinc-400 hover:text-zinc-100"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={() => void loadOverview(true)} disabled={refreshing}>
            {refreshing ? "刷新中..." : "刷新"}
          </Button>
        </div>
      </div>

      {marketFilter === "all" ? (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <Card className="border-zinc-800 bg-zinc-950/85 p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">在线源</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-50">{overview ? `${overview.summary.liveSources}/${overview.summary.totalSources}` : "--"}</div>
            <div className="mt-2 text-sm text-zinc-500">行情、新闻、事件源的当前可用状态。</div>
          </Card>

            <Card className="border-zinc-800 bg-zinc-950/85 p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">当前主线</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-50">{overview?.summary.topTheme || "--"}</div>
              <div className="mt-2 text-sm text-zinc-500">{overview?.summary.headline || "等待最新市场概览。"}</div>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/85 p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">风险偏好</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-50">{overview?.summary.riskMode?.label || "--"}</div>
              <div className="mt-2 text-sm text-zinc-500">{overview?.summary.riskMode?.reasons || "等待最新结论。"}</div>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/85 p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">更新时间</div>
              <div className="mt-2 text-lg font-semibold text-zinc-50">{overview?.generatedAt ? formatDateTime(overview.generatedAt) : "--"}</div>
              <div className="mt-2 text-sm text-zinc-500">事件卡片和摘要都会跟随这一轮刷新更新。</div>
            </Card>
          </div>

          <Card className="border-zinc-800 bg-zinc-950/85 p-6">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">市场简报</h2>
              <p className="mt-1 text-sm text-zinc-500">先快速看市场概览，再进入事件层做判断。</p>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              {briefs.map((brief) => (
                <div key={brief.market} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className="font-medium text-zinc-100">{brief.label}</div>
                      <Badge variant={brief.market === "a_share" ? "default" : "success"}>{brief.market === "a_share" ? "A股" : "加密"}</Badge>
                    </div>
                    <div className="text-xs text-zinc-500">{formatDateTime(brief.generatedAt)}</div>
                  </div>
                  <div className="mt-3 text-base font-medium text-zinc-200">{brief.headline}</div>
                  <div className="mt-2 text-sm text-zinc-400">{brief.summary}</div>
                  <div className="mt-4 space-y-3">
                    {brief.sections.map((section) => (
                      <div key={section.id} className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                        <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">{section.title}</div>
                        <div className="mt-1 text-sm text-zinc-300">{section.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {briefs.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-zinc-500">当前还没有可用简报，刷新市场情报后会在这里出现。</div> : null}
            </div>
          </Card>

          <Card className="border-zinc-800 bg-zinc-950/85 p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">事件卡片</h2>
                <p className="mt-1 text-sm text-zinc-500">把新闻标准化成事件标题、三行摘要、分类、倾向、影响标的和来源。</p>
              </div>
              <Badge variant="outline">全部市场</Badge>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {[
                { id: "all", label: "全部倾向" },
                { id: "bullish", label: "利多" },
                { id: "bearish", label: "利空" },
                { id: "neutral", label: "中性" },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => setEventSentimentFilter(item.id as "all" | "bullish" | "bearish" | "neutral")}
                  className={`rounded-full border px-3 py-1 text-xs transition ${eventSentimentFilter === item.id ? "border-zinc-100 bg-zinc-100 text-zinc-950" : "border-zinc-700 bg-zinc-900/30 text-zinc-400 hover:text-zinc-100"}`}
                >
                  {item.label}
                </button>
              ))}
              {[
                { id: "all", label: "全部状态" },
                { id: "worth_tracking", label: "值得跟踪" },
                { id: "watch", label: "进入观察池" },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => setEventTrackingFilter(item.id as "all" | "worth_tracking" | "watch")}
                  className={`rounded-full border px-3 py-1 text-xs transition ${eventTrackingFilter === item.id ? "border-cyan-300 bg-cyan-100 text-cyan-950" : "border-zinc-700 bg-zinc-900/30 text-zinc-400 hover:text-zinc-100"}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/25 px-4 py-3 text-sm text-zinc-400">
              <div>
                当前第 {totalEventPages === 0 ? 0 : eventPage} / {totalEventPages} 页 · 共 {filteredEvents.length} 张事件卡片
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setEventPage((current) => Math.max(1, current - 1))} disabled={eventPage <= 1}>
                  上一页
                </Button>
                <Button variant="outline" onClick={() => setEventPage((current) => Math.min(totalEventPages, current + 1))} disabled={eventPage >= totalEventPages}>
                  下一页
                </Button>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-3">
                {visibleEvents.map((event) => (
                  <div key={event.eventId} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-zinc-100">{event.title}</div>
                        <Badge variant="outline">{event.eventTypeLabel}</Badge>
                        <Badge variant={sentimentVariant(event.sentiment)}>{event.sentimentLabel}</Badge>
                        <Badge variant={executionVariant(event.execution.state)}>{event.execution.label}</Badge>
                        <Badge variant={event.freshness === "new" ? "warning" : "outline"}>{event.freshness === "new" ? "新增" : "跟踪中"}</Badge>
                      </div>
                      <div className="text-right text-xs text-zinc-500">
                        <div>{formatDateTime(event.publishTime)}</div>
                        <div className="mt-1">重要度 {event.importanceScore}</div>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {event.summaryLines.map((line, index) => (
                        <div key={`${event.id}-${index}`} className="text-sm text-zinc-300">
                          {line}
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {event.assets.map((asset) => (
                        <Badge key={`${event.id}-${asset.symbol}`} variant="default">
                          {asset.label}
                        </Badge>
                      ))}
                    </div>
                    <div className="mt-3 text-xs text-zinc-500">
                      处理状态 {observationStateLabel(event.observationState)} · 置信度 {confidenceLabel(event.confidence)} · 来源{" "}
                      {(event.sourceList.length ? event.sourceList : event.sources).join(" / ") || "--"}
                    </div>
                    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs uppercase tracking-[0.16em] text-zinc-500">规则动作</span>
                        <Badge variant={executionVariant(event.execution.state)}>{event.execution.label}</Badge>
                      </div>
                      <div className="mt-2 text-sm text-zinc-300">{event.execution.reason}</div>
                    </div>
                    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs uppercase tracking-[0.16em] text-zinc-500">新旧判断</span>
                        <Badge variant={event.novelty.label === "new_signal" ? "success" : event.novelty.label === "known_story" ? "warning" : "outline"}>
                          {event.novelty.title}
                        </Badge>
                      </div>
                      <div className="mt-2 text-sm text-zinc-300">{event.novelty.summary}</div>
                    </div>
                    {event.similarEvents.length > 0 ? (
                      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                        <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">历史相似事件</div>
                        <div className="mt-2 space-y-2">
                          {event.similarEvents.map((match) => (
                            <div key={`${event.id}-${match.id}`} className="flex items-center justify-between gap-3 text-sm text-zinc-300">
                              <span className="truncate">{match.title}</span>
                              <span className="shrink-0 text-xs text-zinc-500">
                                {match.sentimentLabel || "中性"} · {formatDateTime(match.publishedAt)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
                {visibleEvents.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 px-4 py-3 text-sm text-zinc-500">当前还没有事件卡片，刷新一次市场情报后会在这里出现。</div> : null}
              </div>
              <div className="space-y-4">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                  <div className="text-sm font-medium text-zinc-100">LLM 新闻分析</div>
                  <div className="mt-3 space-y-3">
                    {visibleDigests.slice(0, 3).map((digest) => (
                      <div key={digest.id} className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-zinc-200">{digest.label}</span>
                          <Badge variant={digest.mode === "llm" ? "success" : "outline"}>{digest.mode === "llm" ? "LLM" : "系统"}</Badge>
                        </div>
                        <div className="mt-2 text-sm text-zinc-400">{digest.summary}</div>
                      </div>
                    ))}
                    {visibleDigests.length === 0 ? <div className="text-sm text-zinc-500">当前还没有分析结果。</div> : null}
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                  <div className="text-sm font-medium text-zinc-100">新闻检索</div>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleSearch();
                      }}
                      placeholder="搜索主题、事件、公司、币种"
                      className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
                    />
                    <Button onClick={() => void handleSearch()} disabled={searching}>
                      {searching ? "检索中..." : "检索"}
                    </Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {searchResults.slice(0, 4).map((item) => (
                      <div key={`${item.kind}-${item.id}`} className="rounded-lg border border-zinc-800 bg-zinc-950/55 px-3 py-2">
                        <div className="text-sm text-zinc-200">{item.title}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {item.kind === "event" ? "事件" : item.source || "新闻源"} · {formatDateTime(item.publishedAt)}
                        </div>
                      </div>
                    ))}
                    {searchQuery.trim() && searchResults.length === 0 && !searching ? <div className="text-sm text-zinc-500">当前没有召回结果。</div> : null}
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </>
      ) : null}

      {marketFilter !== "all" ? (
        <div className="space-y-6">
          {visibleMarkets.map((market) => (
            <Card key={market.market} className="border-zinc-800 bg-zinc-950/85 p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-zinc-100">{market.label}</h2>
                  <Badge variant="outline">{market.overview.mood}</Badge>
                </div>
                <p className="mt-1 text-sm text-zinc-400">{market.overview.headline}</p>
                <p className="mt-2 text-sm text-zinc-500">{market.overview.commentary}</p>
                <p className="mt-2 text-sm text-zinc-300">{market.overview.verdict}</p>
              </div>
              <div className="text-right text-sm text-zinc-500">
                <div>{market.overview.breadth}</div>
                <div className="mt-1">{formatDateTime(market.generatedAt)}</div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-4">
              {market.tiles.map((tile) => (
                <div key={tile.symbol} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-zinc-100">{tile.label}</div>
                      <div className="mt-1 text-xs text-zinc-500">{tile.symbol}</div>
                    </div>
                    <div className={`text-sm font-medium ${changeTone(tile.changePct)}`}>{tile.changePct.toFixed(2)}%</div>
                  </div>
                  <div className="mt-3 text-2xl font-semibold text-zinc-50">{formatCompact(tile.last)}</div>
                  <div className="mt-2 text-sm text-zinc-400">{tile.commentary}</div>
                </div>
              ))}
            </div>

            <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
              <div>
                <h3 className="text-base font-semibold text-zinc-100">主题聚类</h3>
                <div className="mt-3 space-y-3">
                  {market.themes.slice(0, 4).map((theme) => (
                    <div key={theme.id} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-zinc-100">{theme.label}</div>
                        <Badge variant="default">热度 {theme.score}</Badge>
                      </div>
                      <div className="mt-2 text-sm text-zinc-400">{theme.summary}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="text-base font-semibold text-zinc-100">观察清单</h3>
                <div className="mt-3 space-y-3">
                  {market.watchlist.slice(0, 5).map((item) => (
                    <div key={`${market.market}-${item.symbol}`} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium text-zinc-100">{item.label}</div>
                          <div className="mt-1 text-xs text-zinc-500">{item.symbol}</div>
                        </div>
                        <div className={`text-sm font-medium ${changeTone(item.changePct)}`}>{item.changePct.toFixed(2)}%</div>
                      </div>
                      <div className="mt-3 text-sm text-zinc-200">{item.signal}</div>
                      <div className="mt-1 text-sm text-zinc-500">{item.reason}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {market.events.length > 0 ? (
              <div className="mt-6">
                <h3 className="text-base font-semibold text-zinc-100">交易所事件</h3>
                <div className="mt-3 space-y-3">
                  {market.events.slice(0, 4).map((event) => (
                    <div key={event.id} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-zinc-100">
                          {event.exchange} · {event.title}
                        </div>
                        <Badge variant={event.severity === "normal" ? "success" : "warning"}>{event.severity === "normal" ? "正常" : "注意"}</Badge>
                      </div>
                      <div className="mt-2 text-sm text-zinc-400">{event.summary}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {market.pulse.length > 0 ? (
              <div className="mt-6">
                <h3 className="text-base font-semibold text-zinc-100">脉冲板</h3>
                <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-4">
                  {market.pulse.slice(0, 4).map((item) => (
                    <div key={`${market.market}-pulse-${item.symbol}`} className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-zinc-100">{item.label}</div>
                        <div className={`text-sm font-medium ${changeTone(item.changePct)}`}>{item.changePct.toFixed(2)}%</div>
                      </div>
                      <div className="mt-3 text-sm text-zinc-200">{item.signal}</div>
                      <div className="mt-1 text-sm text-zinc-500">{item.reason}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            </Card>
          ))}
        </div>
      ) : null}

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
