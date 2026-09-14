import type { Metadata } from "next";
import { MiniApp } from "@/components/MiniApp";
import { submissionFormEnabled } from "@/lib/miniapp";

export const metadata: Metadata = {
  title: "Қолдауға өтініш",
};

// Мини-апп Telegram для кураторов (интерфейс на казахском — они пишут
// по-казахски): форма обращения и статус своих обращений. Открывается
// кнопкой в боте, без входа агента (см. proxy.ts) и без меню сайта — внутри
// Telegram это отдельный экран, а не часть рабочего места.
//
// ?tab=mine — сразу список своих обращений: так его открывает кнопка «Көру»
// в уведомлении о смене статуса (submitterNotify.ts). Вкладку выбираем на
// сервере, чтобы при открытии из уведомления не мелькала форма.
export default async function MiniAppPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  // Сначала адрес, потом переключатель: чтение searchParams делает страницу
  // динамической. В обратном порядке при сборке без env страница выходила
  // статической — навсегда с «форма өшірулі» и без выбора вкладки.
  const { tab } = await searchParams;
  if (!submissionFormEnabled()) {
    return (
      <main className="mx-auto max-w-md px-4 py-10 text-center text-sm text-slate-500">
        Өтініш формасы әзірге өшірулі.
      </main>
    );
  }
  return <MiniApp initialTab={tab === "mine" ? "mine" : "new"} />;
}
