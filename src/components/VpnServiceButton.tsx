"use client";

import { useEffect, useState } from "react";

type Status = "running" | "stopped" | "partial" | null;

// Включить/выключить сервис juz40-vpn-logs (держит корпоративный WireGuard
// на отдельной VM). Кнопка нужна ровно из-за одного ограничения: конфиг
// WireGuard пускает только один активный пир, поэтому пока сервис держит
// туннель — тот же .conf нельзя одновременно поднять на личной машине.
// "Выключить" освобождает пира, "Включить" возвращает сервис в строй.
export function VpnServiceButton({
  onError,
  onInfo,
}: {
  onError: (message: string) => void;
  onInfo: (message: string) => void;
}) {
  const [configured, setConfigured] = useState(true);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/vpn-service");
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        onError(data?.error ?? `Не удалось получить статус VPN (HTTP ${res.status})`);
        return;
      }
      setConfigured(data.configured !== false);
      setStatus(data.status ?? null);
    } catch (err) {
      onError(`Сеть недоступна: ${String(err)}`);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при монтировании; onError/onInfo — коллбэки родителя, не повод перезапрашивать статус
  }, []);

  async function toggle() {
    if (busy || status === null) return;
    const action = status === "stopped" ? "start" : "stop";
    setBusy(true);
    try {
      const res = await fetch("/api/vpn-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        onError(data?.error ?? `Не получилось (HTTP ${res.status})`);
        return;
      }
      setStatus(data.status);
      onInfo(
        action === "start"
          ? "Сервис включён — не забудь отключить тот же VPN на своей машине"
          : "Сервис выключен — VPN-пир свободен"
      );
    } catch (err) {
      onError(`Сеть недоступна: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!configured) return null;

  const label =
    status === null
      ? "🔌 VPN…"
      : status === "running"
        ? "🟢 VPN-сервис"
        : status === "partial"
          ? "🟡 VPN-сервис"
          : "⚪ VPN-сервис";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy || status === null}
      title={
        status === "stopped"
          ? "Сервис выключен — нажми, чтобы включить"
          : "Сервис держит корпоративный VPN — нажми, чтобы выключить и освободить пира для своей машины"
      }
      className="rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50 disabled:opacity-50"
    >
      {busy ? "⏳ VPN…" : label}
    </button>
  );
}
