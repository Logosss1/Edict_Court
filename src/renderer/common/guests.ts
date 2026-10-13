// 客卿 (2.1): the guest list for plan cards and task views, loaded once and again when guest settings change.
import { useEffect, useState } from 'react';
import { call } from '../api';
import { useStore } from '../store';
import type { GuestSettings, GuestStatus } from '../../shared/types';

export interface GuestInfo { guests: GuestStatus[]; settings: GuestSettings }

let cache: { key: string; p: Promise<GuestInfo> } | null = null;

export function useGuests(): GuestInfo | null {
  const key = useStore((s) => JSON.stringify(s.settings.guests ?? null));
  const [info, setInfo] = useState<GuestInfo | null>(null);
  useEffect(() => {
    if (!cache || cache.key !== key) cache = { key, p: call<GuestInfo>('guestStatuses') };
    let alive = true;
    cache.p.then((r) => alive && setInfo(r)).catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [key]);
  return info;
}

export const guestLabel = (info: GuestInfo | null, id: string) => info?.guests.find((g) => g.id === id)?.name ?? id;
