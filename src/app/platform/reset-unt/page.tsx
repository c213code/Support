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
        <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-slate-600">
            <h1 className="mb-2 text-lg font-semibold text-slate-900">
              Обнуление результата ДТ
            </h1>
            <p className="text-sm">
              Инструмент не настроен на сервере. Задай переменные окружения{" "}
              <code className="rounded bg-slate-100 px-1">PLATFORM_API_URL</code>,{" "}
              <code className="rounded bg-slate-100 px-1">
                PLATFORM_SERVICE_USERNAME
              </code>{" "}
              и{" "}
              <code className="rounded bg-slate-100 px-1">
                PLATFORM_SERVICE_PASSWORD
              </code>{" "}
              и передеплой.
            </p>
          </div>
        </div>
      )}
    </AppShell>
  );
}
