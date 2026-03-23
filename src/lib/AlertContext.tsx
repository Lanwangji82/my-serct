import React, { createContext, useContext, useState, ReactNode } from 'react';

export type AlertType = 'info' | 'warning' | 'success' | 'error';

export interface Alert {
  id: string;
  type: AlertType;
  title: string;
  message: string;
  time: Date;
  read: boolean;
}

interface AlertContextType {
  alerts: Alert[];
  unreadCount: number;
  addAlert: (alert: Omit<Alert, 'id' | 'time' | 'read'>) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
}

const AlertContext = createContext<AlertContextType | undefined>(undefined);

export function AlertProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const addAlert = (alert: Omit<Alert, 'id' | 'time' | 'read'>) => {
    const newAlert: Alert = {
      ...alert,
      id: Math.random().toString(36).substring(2, 9),
      time: new Date(),
      read: false,
    };
    setAlerts(prev => [newAlert, ...prev].slice(0, 50)); // keep last 50
  };

  const markAsRead = (id: string) => {
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, read: true } : a));
  };

  const markAllAsRead = () => {
    setAlerts(prev => prev.map(a => ({ ...a, read: true })));
  };

  const unreadCount = alerts.filter(a => !a.read).length;

  return (
    <AlertContext.Provider value={{ alerts, unreadCount, addAlert, markAsRead, markAllAsRead }}>
      {children}
    </AlertContext.Provider>
  );
}

export const useAlerts = () => {
  const context = useContext(AlertContext);
  if (!context) throw new Error('useAlerts must be used within AlertProvider');
  return context;
};
