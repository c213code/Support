"use client";

import { useState } from "react";

// Превью фото из обращения мини-аппа на карточке доски. Если маршрут фото не
// отдал картинку (Telegram недоступен, file_id от другого бота), вместо значка
// битой картинки — понятная ссылка; причина — в логах сервера строкой [photo].
export function SubmissionPhoto({ issueId }: { issueId: string }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/issues/${issueId}/photo`;

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Открыть фото целиком"
      className={failed ? "mt-1 block text-accent-600 hover:underline" : undefined}
    >
      {failed ? (
        "📷 Фото не загрузилось — открыть"
      ) : (
        // Не next/image: фото отдаёт маршрут за сессией агента, а оптимизатор
        // Next ходит за картинкой без куки и получил бы редирект на /login
        // (proxy.ts).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="Фото из обращения"
          loading="lazy"
          onError={() => setFailed(true)}
          className="mt-1 max-h-28 rounded border border-slate-200"
        />
      )}
    </a>
  );
}
