import type { ReactNode } from "react";

export function SupportPageHeader({ title, description, children }: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="support-surface mb-5 flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="mb-2 text-xs font-medium text-slate-400">JUZ40 · Поддержка</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-800">{title}</h1>
        {description && <p className="mt-2 text-sm leading-relaxed text-slate-500">{description}</p>}
      </div>
      {children}
    </header>
  );
}

export function SupportUnavailable({ title }: { title: string }) {
  return (
    <div className="support-page max-w-3xl">
      <SupportPageHeader title={title} />
      <div className="support-surface text-sm leading-relaxed text-slate-500">
        Инструмент пока недоступен. Обратитесь к администратору, чтобы подключить его.
      </div>
    </div>
  );
}
