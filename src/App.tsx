import React, { useEffect, useState } from "react";
import { AppLayout } from "./components/Layout";
import {
  MarketOverview,
  ChartWidget,
  PositionsTable,
  StrategyRunner,
  DataSourcesWidget,
  DataFrequencyWidget,
  ETLJobsWidget,
  StorageArchitectureWidget,
} from "./components/Widgets";
import {
  BacktestEngineConfig,
  SimulationSettings,
  OptimizationConfig,
  ComputingResources,
  BacktestResults,
} from "./components/BacktestWidgets";
import { Card, Button, Badge } from "./components/ui";
import { LanguageProvider, useTranslation } from "./lib/i18n";
import { AlertProvider } from "./lib/AlertContext";
import { ToastContainer } from "./components/NotificationCenter";
import { GovernanceWorkspace } from "./components/GovernanceWorkspace";
import { PortfolioWorkspace } from "./components/PortfolioWorkspace";
import { ResearchWorkspace } from "./components/ResearchWorkspace";
import { StrategyWorkbench } from "./components/StrategyWorkbench";

const generateChartData = (points = 50, startPrice = 100, volatility = 2) => {
  let currentPrice = startPrice;
  return Array.from({ length: points }).map((_, i) => {
    const change = (Math.random() - 0.5) * volatility;
    currentPrice += change;
    return {
      time: `10:${i.toString().padStart(2, "0")}`,
      price: currentPrice,
    };
  });
};

const alphaCurve = generateChartData(120, 100, 1.2);
const factorExposure = generateChartData(90, 65, 1.8);
const riskBudget = generateChartData(90, 42, 1.1);

function DashboardView() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">平台总览</h1>
          <p className="mt-1 text-sm text-zinc-500">
            QuantX 现已围绕研究、数据工程、策略生命周期与风险治理进行组织。
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="success">研究就绪</Badge>
          <Badge variant="warning">交易终端已移除</Badge>
        </div>
      </div>

      <MarketOverview />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.35fr)_320px]">
        <ChartWidget title="Platform Alpha Curve" data={alphaCurve} />
        <Card className="border-zinc-800 bg-zinc-950/85">
          <div className="space-y-5 p-6">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-emerald-300/80">当前重点</div>
              <div className="mt-2 text-2xl font-semibold text-white">专业量化平台</div>
              <div className="mt-1 text-sm text-zinc-500">
                产品当前聚焦于信号研究、组合构建、策略仿真与治理控制。
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{t("strategies")}</div>
                <div className="mt-2 font-mono text-lg text-zinc-100">24 个启用中</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">研究队列</div>
                <div className="mt-2 font-mono text-lg text-zinc-100">7 个运行中</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">数据域</div>
                <div className="mt-2 font-mono text-lg text-zinc-100">18 条数据流</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">风险策略</div>
                <div className="mt-2 font-mono text-lg text-zinc-100">42 条已加载</div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DataSourcesWidget />
        <ETLJobsWidget />
      </div>
    </div>
  );
}

function DataCenterView() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t("dataCenter")}</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DataSourcesWidget />
        <DataFrequencyWidget />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ETLJobsWidget />
        <StorageArchitectureWidget />
      </div>
    </div>
  );
}

function BacktestingView() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t("backtesting")}</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <BacktestEngineConfig />
          <SimulationSettings />
          <OptimizationConfig />
        </div>
        <div className="space-y-6">
          <ComputingResources />
          <Card className="border-dashed border-zinc-700 bg-zinc-900/40">
            <div className="flex h-[240px] flex-col items-center justify-center p-6 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10">
                <svg className="h-6 w-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
              </div>
              <h3 className="mb-1 text-lg font-medium text-zinc-200">研究运行时</h3>
              <p className="max-w-sm text-sm text-zinc-500">
                在这里编译信号逻辑、组织参数扫描，并将仿真产物发布到策略库。
              </p>
              <Button variant="outline" className="mt-4">打开运行控制台</Button>
            </div>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1">
        <BacktestResults />
      </div>
    </div>
  );
}

function SettingsView() {
  const { language, setLanguage, t } = useTranslation();

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{t("settings")}</h1>
      </div>

      <Card className="border-zinc-800 bg-zinc-950/85">
        <div className="space-y-8 p-6">
          <div>
            <h3 className="mb-4 text-lg font-medium">{t("language")}</h3>
            <div className="flex gap-4">
              <Button variant={language === "en" ? "default" : "outline"} onClick={() => setLanguage("en")}>
                {t("english")}
              </Button>
              <Button variant={language === "zh" ? "default" : "outline"} onClick={() => setLanguage("zh")}>
                {t("chinese")}
              </Button>
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-6">
            <h3 className="mb-4 text-lg font-medium text-zinc-100">平台配置</h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="text-sm font-medium text-zinc-100">研究环境</div>
                <div className="mt-2 text-sm text-zinc-500">按沙盒、预发、生产分离笔记本、回测与发布流程。</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="text-sm font-medium text-zinc-100">风险策略库</div>
                <div className="mt-2 text-sm text-zinc-500">将限额、审批与控制规则作为平台的一等配置。</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="text-sm font-medium text-zinc-100">密钥与凭证</div>
                <div className="mt-2 text-sm text-zinc-500">凭证管理应由服务端密钥存储负责，而不是直接留在前端界面。</div>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="text-sm font-medium text-zinc-100">发布流程</div>
                <div className="mt-2 text-sm text-zinc-500">将研究产出纳入可审计、可控的策略发布流程。</div>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function AppContent() {
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window === "undefined") {
      return "dashboard";
    }
    return window.localStorage.getItem("quantx.activeTab") || "dashboard";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("quantx.activeTab", activeTab);
    }
  }, [activeTab]);

  return (
    <AlertProvider>
      <AppLayout activeTab={activeTab} setActiveTab={setActiveTab}>
        {activeTab === "dashboard" && <DashboardView />}
        {activeTab === "research" && <ResearchWorkspace />}
        {activeTab === "dataCenter" && <DataCenterView />}
        {activeTab === "backtesting" && <BacktestingView />}
        {activeTab === "strategies" && <StrategyWorkbench />}
        {activeTab === "portfolio" && <PortfolioWorkspace />}
        {activeTab === "governance" && <GovernanceWorkspace />}
        {activeTab === "settings" && <SettingsView />}
      </AppLayout>
      <ToastContainer />
    </AlertProvider>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}
