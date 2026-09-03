import { AppShell } from "@/components/AppShell";
import { LogsExplorer } from "@/components/LogsExplorer";
import { logsServiceEnabled } from "@/lib/logsClient";

// Просмотр логов Elasticsearch через отдельный сервис juz40-vpn-logs (держит
// корпоративный VPN — сам Support к нему не подключается). Видна только
// когда настроен (заданы LOGS_SERVICE_* env) — как и "Смена почты" рядом.
export default function LogsPage() {
  const enabled = logsServiceEnabled();

  return (
    <AppShell>
      {enabled ? (
        <LogsExplorer />
      ) : (
        <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-slate-600">
            <h1 className="mb-2 text-lg font-semibold text-slate-900">Логи</h1>
            <p className="text-sm">
              Инструмент не настроен на сервере. Задай переменные окружения{" "}
              <code className="rounded bg-slate-100 px-1">LOGS_SERVICE_URL</code>{" "}
              и{" "}
              <code className="rounded bg-slate-100 px-1">LOGS_SERVICE_TOKEN</code>{" "}
              (адрес и токен сервиса juz40-vpn-logs) и передеплой.
            </p>
          </div>
        </div>
      )}
    </AppShell>
  );
}
