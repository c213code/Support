"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

type Position = { x: number; y: number };

// Keep identity across columns: only new or moved cards animate, not polling.
export function useAnimatedList(revision: unknown, view: string) {
  const ref = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, Position>());
  const animations = useRef(new Set<Animation>());

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cancel = () => {
      animations.current.forEach((animation) => animation.cancel());
      animations.current.clear();
    };
    const onChange = () => { if (media.matches) cancel(); };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
      cancel();
    };
  }, []);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    animations.current.forEach((animation) => animation.cancel());
    animations.current.clear();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, Position>();
    // Read all layout before starting animations to avoid repeated layout work.
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-motion-key]"))
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { node, key: node.dataset.motionKey!, x: rect.left + window.scrollX, y: rect.top + window.scrollY };
      });
    for (const { node, key, x, y } of cards) {
      next.set(key, { x, y });
      if (reduced || typeof node.animate !== "function") continue;
      const old = positions.current.get(key);
      const dx = old ? old.x - x : 0;
      const dy = old ? old.y - y : 6;
      if (old && Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const animation = node.animate(
        old
          ? [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }]
          : [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: old ? 260 : 200, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
      animations.current.add(animation);
      animation.onfinish = () => animations.current.delete(animation);
    }
    positions.current = next;
  }, [revision, view]);

  return ref;
}
