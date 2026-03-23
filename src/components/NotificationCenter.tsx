import React, { useState, useEffect } from 'react';
import { Bell, Check, Info, AlertTriangle, XCircle, CheckCircle2, X } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { useAlerts, Alert } from '../lib/AlertContext';
import { Button } from './ui';
import { cn } from '../lib/utils';

export function NotificationCenter() {
  const { t } = useTranslation();
  const { alerts, unreadCount, markAsRead, markAllAsRead } = useAlerts();
  const [isOpen, setIsOpen] = useState(false);

  const formatTime = (date: Date) => {
    const diff = Math.floor((new Date().getTime() - date.getTime()) / 60000);
    if (diff < 1) return t("justNow" as any);
    return `${diff}${t("minutesAgo" as any)}`;
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'info': return <Info className="h-4 w-4 text-blue-500" />;
      case 'warning': return <AlertTriangle className="h-4 w-4 text-amber-500" />;
      case 'error': return <XCircle className="h-4 w-4 text-rose-500" />;
      case 'success': return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
      default: return <Info className="h-4 w-4 text-blue-500" />;
    }
  };

  return (
    <div className="relative">
      <Button variant="ghost" size="icon" className="relative" onClick={() => setIsOpen(!isOpen)}>
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute right-2 top-2 flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
          </span>
        )}
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 rounded-lg border border-zinc-800 bg-zinc-950 shadow-lg z-50 overflow-hidden">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 bg-zinc-900/50">
              <h3 className="font-medium text-sm text-zinc-100">{t("notifications" as any)}</h3>
              {unreadCount > 0 && (
                <button 
                  onClick={markAllAsRead}
                  className="text-xs text-blue-500 hover:text-blue-400 flex items-center gap-1 transition-colors"
                >
                  <Check className="h-3 w-3" />
                  {t("markAllRead" as any)}
                </button>
              )}
            </div>
            <div className="max-h-[400px] overflow-y-auto">
              {alerts.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-zinc-500">
                  {t("noNotifications" as any)}
                </div>
              ) : (
                <div className="flex flex-col">
                  {alerts.map((alert) => (
                    <div 
                      key={alert.id} 
                      className={cn(
                        "flex gap-3 px-4 py-3 border-b border-zinc-800/50 last:border-0 transition-colors hover:bg-zinc-900/50 cursor-pointer",
                        !alert.read ? "bg-zinc-900/20" : "opacity-70"
                      )}
                      onClick={() => markAsRead(alert.id)}
                    >
                      <div className="mt-0.5 flex-shrink-0">
                        {getIcon(alert.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start mb-0.5">
                          <p className={cn("text-sm font-medium truncate pr-2", !alert.read ? "text-zinc-100" : "text-zinc-300")}>
                            {alert.title}
                          </p>
                          <span className="text-[10px] text-zinc-500 whitespace-nowrap flex-shrink-0">
                            {formatTime(alert.time)}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                          {alert.message}
                        </p>
                      </div>
                      {!alert.read && (
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function ToastContainer() {
  const { alerts, markAsRead } = useAlerts();
  const [visibleToasts, setVisibleToasts] = useState<Alert[]>([]);

  useEffect(() => {
    // Show only unread alerts that are less than 5 seconds old
    const now = new Date().getTime();
    const recentUnread = alerts.filter(a => !a.read && (now - a.time.getTime()) < 5000);
    setVisibleToasts(recentUnread);
  }, [alerts]);

  const getIcon = (type: string) => {
    switch (type) {
      case 'info': return <Info className="h-5 w-5 text-blue-500" />;
      case 'warning': return <AlertTriangle className="h-5 w-5 text-amber-500" />;
      case 'error': return <XCircle className="h-5 w-5 text-rose-500" />;
      case 'success': return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
      default: return <Info className="h-5 w-5 text-blue-500" />;
    }
  };

  if (visibleToasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {visibleToasts.map(toast => (
        <div 
          key={toast.id} 
          className="pointer-events-auto flex w-80 items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-lg animate-in slide-in-from-bottom-5 fade-in duration-300"
        >
          <div className="flex-shrink-0 mt-0.5">
            {getIcon(toast.type)}
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-zinc-100 mb-1">{toast.title}</h4>
            <p className="text-xs text-zinc-400 leading-relaxed">{toast.message}</p>
          </div>
          <button 
            onClick={() => markAsRead(toast.id)}
            className="text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
