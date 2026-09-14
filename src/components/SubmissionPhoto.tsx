"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/Modal";

// Фото из обращения мини-аппа: миниатюры на карточке доски и в окне тикета,
// по клику — просмотр поверх страницы.
//
// Открывается не в новой вкладке: вкладку не закрыть по Esc, и агент терял
// место на доске ради одного взгляда на скриншот. Модалка общая (Modal.tsx):
// Esc, клик по фону, возврат фокуса, учёт вложенности.
//
// Если маршрут фото не отдал картинку (Telegram недоступен, file_id от
// другого бота), вместо значка битой картинки — понятная ссылка; причина —
// в логах сервера строкой [photo].
export function SubmissionPhoto({ issueId, count = 1 }: { issueId: string; count?: number }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [failed, setFailed] = useState<number[]>([]);

  const total = Math.max(1, count);
  const indexes = Array.from({ length: total }, (_, i) => i);
  const src = (index: number) => `/api/issues/${issueId}/photo?i=${index}`;
  const markFailed = (index: number) =>
    setFailed((prev) => (prev.includes(index) ? prev : [...prev, index]));

  // Стрелками листать привычнее, чем целиться в кнопки, — но только когда
  // фото несколько и просмотр открыт.
  useEffect(() => {
    if (openIndex === null || total < 2) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setOpenIndex((current) => {
        if (current === null) return current;
        const step = e.key === "ArrowRight" ? 1 : -1;
        return (current + step + total) % total;
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openIndex, total]);

  return (
    <>
      <div className="mt-1 flex flex-wrap items-start gap-1.5">
        {indexes.map((index) =>
          failed.includes(index) ? (
            <a
              key={index}
              href={src(index)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-accent-600 hover:underline"
            >
              📷 Фото {total > 1 ? index + 1 : ""} не загрузилось — открыть
            </a>
          ) : (
            <button
              key={index}
              type="button"
              title="Открыть фото"
              onClick={(e) => {
                e.stopPropagation();
                setOpenIndex(index);
              }}
              className="block cursor-zoom-in"
            >
              {/* Не next/image: фото отдаёт маршрут за сессией агента, а
                  оптимизатор Next ходит за картинкой без куки и получил бы
                  редирект на /login (proxy.ts). */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src(index)}
                alt={total > 1 ? `Фото ${index + 1} из обращения` : "Фото из обращения"}
                loading="lazy"
                onError={() => markFailed(index)}
                className="max-h-28 rounded border border-slate-200"
              />
            </button>
          )
        )}
      </div>

      {/* Портал в body обязателен: карточка тикета и колонка доски создают
          свой контекст (трансформации, прокрутка), и внутри них подложка
          fixed считается не от окна, а от карточки — она не покрывала бы
          экран, и клик мимо фото не закрывал бы окно. */}
      {openIndex !== null &&
        createPortal(
          <Modal onClose={() => setOpenIndex(null)} size="xl">
            {/* Карточка тикета перетаскиваемая — гасим события, чтобы клик по
                фото не начал драг и не закрыл ничего лишнего. */}
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="mx-auto w-fit max-w-full rounded-xl bg-white p-2 shadow-xl"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src(openIndex)}
                alt={total > 1 ? `Фото ${openIndex + 1} из обращения` : "Фото из обращения"}
                className="mx-auto max-h-[80vh] w-auto rounded-lg"
              />
              <div className="flex items-center justify-between gap-3 px-1 pt-2 text-xs">
                <a
                  href={src(openIndex)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-600 hover:underline"
                >
                  Открыть оригинал в новой вкладке
                </a>
                <div className="flex items-center gap-2">
                  {total > 1 && (
                    <>
                      <button
                        type="button"
                        title="Предыдущее фото (←)"
                        onClick={() => setOpenIndex((i) => ((i ?? 0) - 1 + total) % total)}
                        className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                      >
                        ‹
                      </button>
                      <span className="tabular-nums text-slate-500">
                        {openIndex + 1} / {total}
                      </span>
                      <button
                        type="button"
                        title="Следующее фото (→)"
                        onClick={() => setOpenIndex((i) => ((i ?? 0) + 1) % total)}
                        className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                      >
                        ›
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpenIndex(null)}
                    className="rounded px-2 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                  >
                    Закрыть (Esc)
                  </button>
                </div>
              </div>
            </div>
          </Modal>,
          document.body
        )}
    </>
  );
}
