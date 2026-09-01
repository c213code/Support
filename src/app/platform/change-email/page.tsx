import { AppShell } from "@/components/AppShell";
import { ChangeEmailTool } from "@/components/ChangeEmailTool";
import { platformEnabled } from "@/lib/platform";

// Смена почты ученику в основной платформе JUZ40 (api.juz40-edu.kz).
// Страница видна, только когда инструмент настроен (заданы PLATFORM_* env);
// на проде выключена, пока их не пропишут — так фича катится выключенной.
export default function ChangeEmailPage() {
  const enabled = platformEnabled();

  return (
    <AppShell>
      {enabled ? (
        <ChangeEmailTool />
      ) : (
        <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-slate-600">
            <h1 className="mb-2 text-lg font-semibold text-slate-900">
              Смена почты ученику
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
