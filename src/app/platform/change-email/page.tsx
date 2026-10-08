import { SupportUnavailable } from "@/components/SupportPageHeader";
import { AppShell } from "@/components/AppShell";
import { ChangeEmailTool } from "@/components/ChangeEmailTool";
import { platformEnabled } from "@/lib/platform";

// Смена почты или номера ученику в основной платформе JUZ40 (api.juz40-edu.kz).
// Страница видна, только когда инструмент настроен (заданы PLATFORM_* env);
// на проде выключена, пока их не пропишут — так фича катится выключенной.
export default function ChangeEmailPage() {
  const enabled = platformEnabled();

  return (
    <AppShell>
      {enabled ? (
        <ChangeEmailTool />
      ) : (
        <SupportUnavailable title="Смена почты или номера ученику" />
      )}
    </AppShell>
  );
}
