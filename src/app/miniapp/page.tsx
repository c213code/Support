import type { Metadata } from "next";
import { SubmissionForm } from "@/components/SubmissionForm";
import { submissionFormEnabled } from "@/lib/miniapp";

export const metadata: Metadata = {
  title: "Обращение в поддержку",
};

// Мини-апп Telegram: форма обращения для кураторов. Открывается кнопкой в
// боте (/start), без входа агента (см. proxy.ts) и без меню сайта — внутри
// Telegram это отдельный экран, а не часть рабочего места.
export default function MiniAppPage() {
  if (!submissionFormEnabled()) {
    return (
      <main className="mx-auto max-w-md px-4 py-10 text-center text-sm text-slate-500">
        Форма обращений пока выключена.
      </main>
    );
  }
  return <SubmissionForm />;
}
