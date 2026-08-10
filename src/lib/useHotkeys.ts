"use client";

import { useEffect, useRef } from "react";

// Горячие клавиши без модификаторов. Главная тонкость — не срабатывать,
// когда человек просто печатает: "n" в описании тикета не должно открывать
// форму нового тикета, а "с" в заметке — копировать репорт.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

export function useHotkeys(map: Record<string, () => void>) {
  // Держим карту в ref, чтобы не переподписывать слушатель на каждый
  // рендер: обработчики почти всегда пересоздаются (замыкают state).
  // Обновляем её в эффекте, а не прямо в теле — запись в ref во время
  // рендера ломает конкурентный рендеринг (и справедливо ругается лinter).
  const mapRef = useRef(map);

  useEffect(() => {
    mapRef.current = map;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // Модалка открыта — она обрабатывает клавиши сама (Esc, Tab).
      if (document.querySelector('[role="dialog"]')) return;

      const handler = mapRef.current[e.key];
      if (!handler) return;
      e.preventDefault();
      handler();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
