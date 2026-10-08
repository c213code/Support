import { SupportUnavailable } from "@/components/SupportPageHeader";
import { AppShell } from "@/components/AppShell";
import { ResetUntResultTool } from "@/components/ResetUntResultTool";
import { platformEnabled } from "@/lib/platform";

// Обнуление результата деңгейлік теста (ДТ) в основной платформе JUZ40.
// Тот же тогл, что у смены почты (PLATFORM_*) — один и тот же service-аккаунт
// платформы обслуживает оба инструмента.
export default function ResetUntResultPage() {
  const enabled = platformEnabled();

  return (
    <AppShell>
      {enabled ? (
        <ResetUntResultTool />
      ) : (
        <SupportUnavailable title="Обнуление результата ДТ" />
      )}
    </AppShell>
  );
}
