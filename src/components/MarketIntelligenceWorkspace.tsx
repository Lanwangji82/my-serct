import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "./ui";
import { authorizedFetch, formatDateTime, PLATFORM_API_BASE } from "../lib/platform-client";

type Tone = "normal" | "attention";
type MarketKey = "a_share" | "crypto";

type Tile = { symbol: string; label: string; last: number; changePct: number; commentary: string; quoteVolume?: number; trend?: number[]; trendLabel?: string };
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
type SourceItem = { sourceId: string; label: string; ok: boolean; detail: string; updatedAt: number };
type Overview = {
  generatedAt: number;
  live: boolean;
  summary: { headline: string; liveSources: number; totalSources: number; topTheme: string; riskMode?: { label: string; hint: string; reasons: string } };
  sources: SourceItem[];
  markets: Market[];
  topThemes: Theme[];
  headlines: Headline[];
};

function changeTone(value: number) {
  if (value > 0) return "text-rose-400";
  if (value < 0) return "text-emerald-400";
  return "text-zinc-300";
}

function sparkTone(value: number) {
  if (value > 0) return "#fb7185";
  if (value < 0) return "#34d399";
  return "#a1a1aa";
}

function formatCompact(value: number, digits = 2) {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function Sparkline({ points, tone }: { points?: number[]; tone: string }) {
  if (!points || points.length < 2) return <div className="h-16 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50" />;
  const width = 220;
  const height = 64;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1);
  const path = points.map((value, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 6) - 3;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`} className="h-16 w-full rounded-lg border border-zinc-800 bg-zinc-950/70"><path d={path} fill="none" stroke={tone} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function MarketIntelligenceWorkspace() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [status, setStatus] = useState("正在加载 A股 与加密市场情报...");
  const [refreshing, setRefreshing] = useState(false);
  const [marketFilter, setMarketFilter] = useState<"all" | MarketKey>("all");

  const load = async (forceRefresh = false) => {
    setRefreshing(true);
    try {
      const nextOverview = await authorizedFetch<Overview>(`${PLATFORM_API_BASE}/intelligence/overview${forceRefresh ? "?forceRefresh=true" : ""}`, "");
      setOverview(nextOverview);
      setStatus(nextOverview.live ? "市场情报已更新。" : "部分数据源暂不可用，当前显示回退内容。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "加载市场情报失败");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const visibleMarkets = useMemo(() => {
    if (!overview) return [];
    return marketFilter === "all" ? overview.markets : overview.markets.filter((item) => item.market === marketFilter);
  }, [marketFilter, overview]);

  const visibleHeadlines = useMemo(() => {
    if (!overview) return [];
    return marketFilter === "all" ? overview.headlines : overview.headlines.filter((item) => item.market === marketFilter);
  }, [marketFilter, overview]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">市场情报</h1>
          <p className="mt-1 text-sm text-zinc-500">把 A股 与加密放进同一个情报工作区，统一看盘面、新闻聚合、主题、事件和观察清单。</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-1">
            {[{ id: "all", label: "全部" }, { id: "a_share", label: "A股" }, { id: "crypto", label: "加密" }].map((item) => (
              <button key={item.id} onClick={() => setMarketFilter(item.id as "all" | MarketKey)} className={`rounded-lg px-3 py-1.5 text-sm transition ${marketFilter === item.id ? "bg-zinc-100 text-zinc-950" : "text-zinc-400 hover:text-zinc-100"}`}>{item.label}</button>
            ))}
          </div>
          <Button variant="outline" onClick={() => void load(true)} disabled={refreshing}>{refreshing ? "刷新中..." : "刷新"}</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="border-zinc-800 bg-zinc-950/85 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">在线源</div><div className="mt-2 text-2xl font-semibold text-zinc-50">{overview ? `${overview.summary.liveSources}/${overview.summary.totalSources}` : "--"}</div><div className="mt-2 text-sm text-zinc-500">行情、新闻聚合、交易所事件与观察信号。</div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">当前主线</div><div className="mt-2 text-2xl font-semibold text-zinc-50">{overview?.summary.topTheme || "--"}</div><div className="mt-2 text-sm text-zinc-500">当前热度最高的跨市场主题。</div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">风险偏好</div><div className="mt-2 text-2xl font-semibold text-zinc-50">{overview?.summary.riskMode?.label || "--"}</div><div className="mt-2 text-sm text-zinc-500">{overview?.summary.riskMode?.reasons || "等待市场结论。"}</div></Card>
        <Card className="border-zinc-800 bg-zinc-950/85 p-5"><div className="text-xs uppercase tracking-[0.18em] text-zinc-500">更新时间</div><div className="mt-2 text-lg font-semibold text-zinc-50">{overview?.generatedAt ? formatDateTime(overview.generatedAt) : "--"}</div><div className="mt-2 text-sm text-zinc-500">需要最新一轮数据时可以手动刷新。</div></Card>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85 p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">总览</h2>
            <p className="mt-1 text-sm text-zinc-500">{overview?.summary.headline || "正在准备摘要..."}</p>
            {overview?.summary.riskMode ? <p className="mt-2 text-sm text-zinc-400">{overview.summary.riskMode.hint}</p> : null}
          </div>
          <Badge variant={overview?.live ? "success" : "warning"}>{overview?.live ? "在线" : "回退"}</Badge>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-4">
          {(overview?.sources || []).map((source) => (
            <div key={source.sourceId} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center justify-between gap-3"><div className="text-sm font-medium text-zinc-100">{source.label}</div><Badge variant={source.ok ? "success" : "warning"}>{source.ok ? "正常" : "回退"}</Badge></div>
              <div className="mt-2 text-sm text-zinc-400">{source.detail}</div>
              <div className="mt-2 text-xs text-zinc-500">{formatDateTime(source.updatedAt)}</div>
            </div>
          ))}
        </div>
      </Card>

      {(overview?.topThemes || []).length > 0 ? (
        <Card className="border-zinc-800 bg-zinc-950/85 p-6">
          <h2 className="text-lg font-semibold text-zinc-100">跨市场主题</h2>
          <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-4">
            {overview?.topThemes.slice(0, 8).map((theme) => (
              <div key={theme.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-center justify-between gap-3"><div className="font-medium text-zinc-100">{theme.label}</div><Badge variant="default">热度 {theme.score}</Badge></div>
                <div className="mt-2 text-sm text-zinc-400">{theme.summary}</div>
                <div className="mt-3 flex flex-wrap gap-2">{theme.keywords.slice(0, 4).map((keyword) => <Badge key={keyword} variant="outline">{keyword}</Badge>)}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="space-y-6">
        {visibleMarkets.map((market) => (
          <Card key={market.market} className="border-zinc-800 bg-zinc-950/85 p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2"><h2 className="text-lg font-semibold text-zinc-100">{market.label}</h2><Badge variant="default">{market.overview.mood}</Badge></div>
                <p className="mt-1 text-sm text-zinc-400">{market.overview.headline}</p>
                <p className="mt-2 text-sm text-zinc-500">{market.overview.commentary}</p>
                <p className="mt-2 text-sm text-zinc-300">{market.overview.verdict}</p>
              </div>
              <div className="text-right text-sm text-zinc-500"><div>{market.overview.breadth}</div><div className="mt-1">{formatDateTime(market.generatedAt)}</div></div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-4">
              {market.tiles.map((tile) => (
                <div key={tile.symbol} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between gap-3"><div><div className="font-medium text-zinc-100">{tile.label}</div><div className="mt-1 text-xs text-zinc-500">{tile.symbol}</div></div><div className={`text-sm font-medium ${changeTone(tile.changePct)}`}>{tile.changePct.toFixed(2)}%</div></div>
                  <div className="mt-3 text-2xl font-semibold text-zinc-50">{formatCompact(tile.last)}</div>
                  <div className="mt-2 text-xs text-zinc-500">{tile.trendLabel || "趋势"}</div>
                  <div className="mt-2"><Sparkline points={tile.trend} tone={sparkTone(tile.changePct)} /></div>
                  {typeof tile.quoteVolume === "number" ? <div className="mt-2 text-xs text-zinc-500">24h成交额 {formatCompact(tile.quoteVolume / 1_000_000_000, 2)}B</div> : null}
                  <div className="mt-2 text-sm text-zinc-400">{tile.commentary}</div>
                </div>
              ))}
            </div>

            <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[0.92fr_1.08fr]">
              <div className="space-y-4">
                <div><h3 className="text-base font-semibold text-zinc-100">主题聚类</h3><p className="mt-1 text-sm text-zinc-500">把新闻标签聚合成更容易阅读的市场叙事。</p></div>
                <div className="space-y-3">{market.themes.map((theme) => <div key={theme.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="flex items-center justify-between gap-3"><div className="font-medium text-zinc-100">{theme.label}</div><Badge variant="default">热度 {theme.score}</Badge></div><div className="mt-2 text-sm text-zinc-400">{theme.summary}</div><div className="mt-3 flex flex-wrap gap-2">{theme.keywords.slice(0, 4).map((keyword) => <Badge key={keyword} variant="outline">{keyword}</Badge>)}</div></div>)}</div>
              </div>
              <div className="space-y-4">
                <div><h3 className="text-base font-semibold text-zinc-100">观察清单</h3><p className="mt-1 text-sm text-zinc-500">把下一步最值得继续盯的标的先拉成短名单。</p></div>
                <div className="space-y-3">{market.watchlist.map((item) => <div key={`${market.market}-${item.symbol}`} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="flex items-center justify-between gap-3"><div><div className="font-medium text-zinc-100">{item.label}</div><div className="mt-1 text-xs text-zinc-500">{item.symbol}</div></div><div className="text-right"><div className={`text-sm font-medium ${changeTone(item.changePct)}`}>{item.changePct.toFixed(2)}%</div>{typeof item.price === "number" && item.price > 0 ? <div className="mt-1 text-xs text-zinc-500">{formatCompact(item.price)}</div> : null}</div></div><div className="mt-3 text-sm text-zinc-200">{item.signal}</div><div className="mt-1 text-sm text-zinc-500">{item.reason}</div></div>)}</div>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              <div><h3 className="text-base font-semibold text-zinc-100">新闻聚合</h3><p className="mt-1 text-sm text-zinc-500">参考 StockAgent 的思路，把新闻按主题分组，而不是只给一条平铺的信息流。</p></div>
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                {market.newsGroups.map((group) => (
                  <div key={`${market.market}-${group.groupId}`} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                    <div className="flex items-center justify-between gap-3"><div className="font-medium text-zinc-100">{group.label}</div><Badge variant="default">{group.count} 条</Badge></div>
                    <div className="mt-2 text-sm text-zinc-400">{group.summary}</div>
                    <div className="mt-3 space-y-2">
                      {group.items.slice(0, 3).map((headline) => <div key={headline.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-300">{headline.title}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {market.pulse.length > 0 ? <div className="mt-6 space-y-4"><div><h3 className="text-base font-semibold text-zinc-100">脉冲板</h3><p className="mt-1 text-sm text-zinc-500">用 ETF 和主题代理快速判断板块宽度与轮动方向。</p></div><div className="grid grid-cols-1 gap-3 xl:grid-cols-4">{market.pulse.map((item) => <div key={`${market.market}-pulse-${item.symbol}`} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="flex items-center justify-between gap-3"><div className="font-medium text-zinc-100">{item.label}</div><div className={`text-sm font-medium ${changeTone(item.changePct)}`}>{item.changePct.toFixed(2)}%</div></div><div className="mt-3 text-sm text-zinc-200">{item.signal}</div><div className="mt-1 text-sm text-zinc-500">{item.reason}</div></div>)}</div></div> : null}

            {market.events.length > 0 ? <div className="mt-6 space-y-4"><div><h3 className="text-base font-semibold text-zinc-100">交易所事件</h3><p className="mt-1 text-sm text-zinc-500">用于观察会影响执行风险的状态信号和公告流。</p></div><div className="space-y-3">{market.events.map((event) => <div key={event.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="flex items-center justify-between gap-3"><div className="font-medium text-zinc-100">{event.exchange} · {event.title}</div><Badge variant={event.severity === "normal" ? "success" : "warning"}>{event.severity === "normal" ? "正常" : "注意"}</Badge></div><div className="mt-2 text-sm text-zinc-400">{event.summary}</div><div className="mt-2 text-xs text-zinc-500">{formatDateTime(event.publishedAt)}</div></div>)}</div></div> : null}

            <div className="mt-6 space-y-4">
              <div><h3 className="text-base font-semibold text-zinc-100">头条流</h3><p className="mt-1 text-sm text-zinc-500">这里保留按时间排序的原始新闻流，方便你回看分组背后的具体消息。</p></div>
              <div className="space-y-3">
                {market.headlines.map((headline) => (
                  <a key={headline.id} href={headline.url || "#"} target={headline.url ? "_blank" : undefined} rel={headline.url ? "noreferrer" : undefined} className="block rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 transition hover:border-zinc-700 hover:bg-zinc-900/70">
                    <div className="flex items-start justify-between gap-4"><div><div className="font-medium text-zinc-100">{headline.title}</div><div className="mt-2 text-sm text-zinc-400">{headline.summary}</div></div><div className="shrink-0 text-right text-xs text-zinc-500"><div>{headline.source}</div><div className="mt-1">{formatDateTime(headline.publishedAt)}</div></div></div>
                    <div className="mt-3 flex flex-wrap gap-2">{headline.tags.map((tag) => <Badge key={`${headline.id}-${tag}`} variant="outline">{tag}</Badge>)}</div>
                  </a>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85 p-6">
        <div><h2 className="text-lg font-semibold text-zinc-100">统一时间线</h2><p className="mt-1 text-sm text-zinc-500">把 A股 与加密头条放进同一条时间线里，方便比较跨市场共振。</p></div>
        <div className="mt-4 space-y-3">
          {visibleHeadlines.slice(0, 12).map((headline) => <div key={`timeline-${headline.id}`} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4"><div className="flex items-center justify-between gap-3"><div className="font-medium text-zinc-100">{headline.title}</div><Badge variant={headline.market === "a_share" ? "default" : "success"}>{headline.market === "a_share" ? "A股" : "加密"}</Badge></div><div className="mt-2 text-sm text-zinc-400">{headline.source} · {formatDateTime(headline.publishedAt)}</div></div>)}
        </div>
      </Card>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-400">{status}</div>
    </div>
  );
}
