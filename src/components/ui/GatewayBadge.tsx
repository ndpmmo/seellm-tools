'use client';
import React from 'react';
import { Globe, Clock, AlertTriangle } from 'lucide-react';

type GatewayStatus = 'active' | 'revoked' | 'pending_push' | null;

interface GatewayBadgeProps {
  gatewayStatus: GatewayStatus;
  className?: string;
}

export function GatewayBadge({ gatewayStatus, className = '' }: GatewayBadgeProps) {
  if (gatewayStatus === null) {
    return (
      <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20 ${className}`}>
        <div className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        Chưa deploy
      </div>
    );
  }

  if (gatewayStatus === 'pending_push') {
    return (
      <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 ${className}`}>
        <Clock size={10} className="animate-pulse" />
        Đang đồng bộ
      </div>
    );
  }

  if (gatewayStatus === 'active') {
    return (
      <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 ${className}`}>
        <Globe size={10} />
        Trên Gateway
      </div>
    );
  }

  if (gatewayStatus === 'revoked') {
    return (
      <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 ${className}`}>
        <AlertTriangle size={10} />
        Đã thu hồi
      </div>
    );
  }

  return null;
}