"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/Modal";

// Превью фото из обращения мини-аппа на карточке доски.
//
// Открывается поверх доски, а не в новой вкладке: вкладку не закрыть по Esc,
// и агент терял место на доске ради одного взгляда на скриншот. Модалка —
// общая (см. Modal.tsx): Esc, клик по фону, возврат фокуса.
//
// Если маршрут фото не отдал картинку (Telegram недоступен, file_id от
// другого бота), вместо значка битой картинки — понятная ссылка; причина —
// в логах сервера строкой [photo].
export function SubmissionPhoto({ issueId }: { issueId: string }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const src = `/api/issues/${issueId}/photo`;

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="mt-1 block text-accent-600 hover:underline"
      >
        📷 Фото не загрузилось — открыть
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        title="Открыть фото"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="mt-1 block cursor-zoom-in"
      >
        {/* Не next/image: фото отдаёт маршрут за сессией агента, а оптимизатор
            Next ходит за картинкой без куки и получил бы редирект на /login
            (proxy.ts). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Фото из обращения"
          loading="lazy"
          onError={() => setFailed(true)}
          className="max-h-28 rounded border border-slate-200"
        />
      </button>

      {/* Портал в body обязателен: карточка тикета и колонка доски создают
          свой контекст (трансформации, прокрутка), и внутри них подложка
          fixed считается не от окна, а от карточки — она не покрывала бы
          экран, и клик мимо фото не закрывал бы окно. */}
      {open &&
        createPortal(
        <Modal onClose={() => setOpen(false)} size="xl">
          {/* Карточка тикета перетаскиваемая — гасим события, чтобы клик по
              фото не начал драг и не закрыл ничего лишнего. */}
          <div
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="mx-auto w-fit max-w-full rounded-xl bg-white p-2 shadow-xl"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt="Фото из обращения"
              className="mx-auto max-h-[80vh] w-auto rounded-lg"
            />
            <div className="flex items-center justify-between px-1 pt-2 text-xs">
              <a
                href={src}
                target="_blank"
                rel="noreferrer"
                className="text-accent-600 hover:underline"
              >
                Открыть оригинал в новой вкладке
              </a>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                Закрыть (Esc)
              </button>
            </div>
          </div>
        </Modal>,
          document.body
        )}
    </>
  );
}
