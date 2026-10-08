import { SupportUnavailable } from "@/components/SupportPageHeader";
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
        <SupportUnavailable title="Логи" />
      )}
    </AppShell>
  );
}
