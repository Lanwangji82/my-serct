import React from "react";
import { Activity, LayoutDashboard, Settings, Search, User, Database, FlaskConical, Blocks, Radar, BarChart3 } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./ui";
import { useTranslation } from "../../lib/i18n";
import { NotificationCenter } from "./NotificationCenter";

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const { t } = useTranslation();
  const navItems = [
    { id: "dashboard", label: t("dashboard"), icon: LayoutDashboard },
    { id: "intelligence", label: t("marketIntelligence"), icon: Radar },
    { id: "market", label: t("marketCenter"), icon: BarChart3 },
    { id: "dataCenter", label: t("dataCenter"), icon: Database },
    { id: "backtesting", label: t("backtesting"), icon: FlaskConical },
    { id: "strategies", label: t("strategies"), icon: Blocks },
    { id: "settings", label: t("settings"), icon: Settings },
  ];

  return (
    <div className="flex h-screen w-64 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex h-16 items-center px-6 border-b border-zinc-800">
        <div className="flex items-center gap-2 text-zinc-50 font-bold text-xl tracking-tight">
          <div className="h-8 w-8 rounded bg-blue-600 flex items-center justify-center">
            <Activity className="h-5 w-5 text-white" />
          </div>
          QuantX
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-4">
        <nav className="space-y-1 px-3">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                activeTab === item.id
                  ? "bg-zinc-800 text-zinc-50"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-50"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="p-4 border-t border-zinc-800">
        <div className="flex items-center gap-3 rounded-md bg-zinc-900 p-3">
          <div className="h-8 w-8 rounded-full bg-zinc-800 flex items-center justify-center">
            <User className="h-4 w-4 text-zinc-400" />
          </div>
          <div className="flex flex-col text-left">
            <span className="text-sm font-medium text-zinc-200">{t("adminUser")}</span>
            <span className="text-xs text-zinc-500">{t("proPlan")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Header() {
  const { t } = useTranslation();
  return (
    <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950/50 px-6 backdrop-blur-sm sticky top-0 z-10">
      <div className="flex items-center gap-4 flex-1">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-9 pr-4 text-sm text-zinc-50 placeholder:text-zinc-500 focus:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          />
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-400">{t("status")}</span>
          <span className="flex items-center gap-1.5 text-emerald-500">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            {t("systemsOperational")}
          </span>
        </div>
        <div className="h-4 w-px bg-zinc-800" />
        <NotificationCenter />
      </div>
    </header>
  );
}

export function AppLayout({ children, activeTab, setActiveTab }: { children: React.ReactNode, activeTab: string, setActiveTab: (t: string) => void }) {
  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-50">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
