"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Стопка открытых модалок. Модалка в модалке уже бывает (просмотр фото
// поверх формы тикета), и без стопки Escape закрывал бы обе разом: обработчик
// висит на window у каждой, и одно нажатие доходило до всех. Escape слушает
// только верхняя.
const openModals: symbol[] = [];

// Общая обёртка для всех модалок. Раньше каждая (ResolveDialog,
// EscalateDialog, объединение дублей, форма тикета) заново городила свой
// оверлей — и все одинаково не умели три вещи, которые для модалки не
// опциональны: не пускать таб за пределы окна, не давать фону скроллиться
// под ней и возвращать фокус туда, откуда её открыли.
export function Modal({
  onClose,
  children,
  labelledBy,
  size = "md",
}: {
  onClose: () => void;
  children: React.ReactNode;
  labelledBy?: string;
  size?: "md" | "lg" | "xl";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Метка этой модалки в стопке — по ней понимаем, верхняя ли она.
  const idRef = useRef<symbol>(Symbol("modal"));

  useEffect(() => {
    const id = idRef.current;
    openModals.push(id);
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    // Скролл фона под открытой модалкой — классический баг «прокрутил
    // страницу под окном и потерял место»: фиксируем body, компенсируя
    // ширину полосы прокрутки, чтобы вёрстка не дёргалась.
    const { body } = document;
    const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    body.style.overflow = "hidden";
    if (scrollBarWidth > 0) body.style.paddingRight = `${scrollBarWidth}px`;

    return () => {
      const index = openModals.lastIndexOf(id);
      if (index >= 0) openModals.splice(index, 1);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
      restoreFocusRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Клавиши слушает только верхняя модалка: иначе Escape в просмотре фото
      // закрыл бы и форму тикета под ним вместе с набранным текстом, а
      // ловушка таба нижней утаскивала бы фокус из верхней.
      if (openModals[openModals.length - 1] !== idRef.current) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      // Заворачиваем таб по кругу внутри модалки — иначе фокус уходит на
      // кнопки доски за оверлеем, которые визуально недоступны.
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="j40-fade-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16 backdrop-blur-[2px] sm:pt-24"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`j40-pop-in w-full ${size === "xl" ? "max-w-5xl" : size === "lg" ? "max-w-lg" : "max-w-md"}`}
      >
        {children}
      </div>
    </div>
  );
}
