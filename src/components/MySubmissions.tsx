"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { STATUS_KK } from "@/lib/statusKk";
import type { IssueStatus } from "@/lib/status";
import {
  currentInitData,
  haptic,
  type MiniAppEnv,
  type MySubmission,
} from "@/lib/miniappClient";
import styles from "./SubmissionForm.module.css";

// «Менің өтініштерім»: обращения куратора за 30 дней — статус, история смен,
// ответ дежурного у решённых и свои фото. Данные — POST /api/miniapp/mine.

// Список перезапрашиваем при возврате на вкладку, если он старше этого:
// переключился туда-обратно за секунду — лишний запрос ни к чему.
const STALE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

// Цвет метки статуса. Свои цвета только у «решено» и «в другой команде» —
// остальное в цветах темы Telegram.
const STATUS_TONE: Record<IssueStatus, string> = {
  SENT: "var(--hint)",
  IN_PROGRESS: "var(--accent)",
  PENDING: "var(--accent)",
  ESCALATED: "#e8890c",
  RESOLVED: "#31a24c",
};

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

const MONTHS_KK = ["қаң", "ақп", "нау", "сәу", "мам", "мау", "шіл", "там", "қыр", "қаз", "қар", "жел"];

// Время — по Алматы, как на доске поддержки. Месяц подставляем сами: локали
// kk-KZ в браузерах часто нет названий месяцев, и Chrome выводит «M09 13».
function formatWhen(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "Asia/Almaty",
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value])
  );
  return `${parts.day} ${MONTHS_KK[Number(parts.month) - 1]}, ${parts.hour}:${parts.minute}`;
}

function StatusBadge({ status }: { status: IssueStatus }) {
  const meta = STATUS_KK[status];
  return (
    <span className={styles.statusBadge} style={{ "--tone": STATUS_TONE[status] } as CSSProperties}>
      {meta.emoji} {meta.label}
    </span>
  );
}

export function MySubmissions({
  env,
  active,
  onNew,
}: {
  env: MiniAppEnv;
  active: boolean;
  onNew: () => void;
}) {
  const [items, setItems] = useState<MySubmission[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const loadedAtRef = useRef(0);
  const inFlightRef = useRef(false);

  async function load() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/miniapp/mine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: currentInitData() }),
        signal: timeoutSignal(),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data?.items)) {
        setError(data?.error ?? `Тізім жүктелмеді (қате ${res.status}) — жаңартып көріңіз`);
        return;
      }
      setItems(data.items);
      loadedAtRef.current = Date.now();
    } catch {
      setError("Байланыс жоқ — интернетті тексеріп, жаңартыңыз");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }

  // Грузим, когда вкладка открыта и скрипт Telegram уже решил, откуда мы
  // открыты: без подписи сервер всё равно откажет. setState — вне
  // синхронного тела эффекта, как и в форме.
  useEffect(() => {
    if (!active || env === "loading" || env === "browser") return;
    if (Date.now() - loadedAtRef.current < STALE_MS) return;
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [active, env]);

  function refresh() {
    haptic("tap");
    load();
  }

  if (env === "browser") {
    return (
      <p className={styles.notice}>
        Өтініштер тізімі Telegram-нан ашылғанда ғана көрінеді. Боттағы «Өтініш» батырмасын
        басыңыз.
      </p>
    );
  }

  const openCount = items?.filter((item) => item.status !== "RESOLVED").length ?? 0;

  return (
    <>
      <div className={styles.listHeader}>
        <p className={styles.subtitle}>
          {items === null
            ? "Соңғы 30 күн"
            : items.length === 0
              ? "Соңғы 30 күнде өтініш жоқ"
              : openCount > 0
                ? `Соңғы 30 күн · шешілмеген: ${openCount}`
                : "Соңғы 30 күн · бәрі шешілді"}
        </p>
        <button
          type="button"
          className={styles.linkButton}
          onClick={refresh}
          disabled={loading}
        >
          {loading ? "Жүктелуде…" : "Жаңарту"}
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {items === null && loading && (
        <div className={`${styles.list} ${styles.section}`} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.skeletonRow} />
          ))}
        </div>
      )}

      {items?.length === 0 && (
        <div className={styles.empty}>
          <p className={styles.successText}>
            Мұнда форма арқылы жіберген өтініштеріңіз және олардың күйі көрінеді.
          </p>
          <button type="button" className={styles.primaryButton} onClick={onNew}>
            Өтініш жіберу
          </button>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className={`${styles.list} ${styles.section} ${styles.submissionList}`}>
          {items.map((item) => (
            <SubmissionItem
              key={item.id}
              item={item}
              open={openId === item.id}
              onToggle={() => {
                haptic("select");
                setOpenId((current) => (current === item.id ? null : item.id));
              }}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function SubmissionItem({
  item,
  open,
  onToggle,
}: {
  item: MySubmission;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = `submission-${item.id}`;
  return (
    <li className={styles.submissionItem}>
      <button
        type="button"
        className={styles.submissionHead}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className={styles.submissionMeta}>
          <span>
            {item.groupEmoji} {item.groupName}
          </span>
          <span>{formatWhen(item.createdAt)}</span>
        </span>
        <span className={open ? styles.submissionText : styles.submissionTextClamped}>
          {item.text}
        </span>
        <StatusBadge status={item.status} />
      </button>

      {open && (
        <div id={panelId} className={styles.submissionBody}>
          {item.note && (
            <div className={styles.noteBox}>
              <span className={styles.noteLabel}>Кезекшінің жауабы</span>
              <p className={styles.noteText}>{item.note}</p>
            </div>
          )}

          <span className={styles.noteLabel}>Күй тарихы</span>
          <ol className={styles.timeline}>
            {item.history.map((step, index) => (
              <li
                key={`${step.at}-${index}`}
                className={styles.timelineStep}
                style={{ "--tone": STATUS_TONE[step.status] } as CSSProperties}
              >
                <span>
                  {STATUS_KK[step.status].emoji} {STATUS_KK[step.status].label}
                </span>
                <span className={styles.timelineTime}>{formatWhen(step.at)}</span>
              </li>
            ))}
          </ol>

          <SubmissionPhotos submissionId={item.id} count={item.photoCount} />
        </div>
      )}
    </li>
  );
}

type PhotoSlot = { state: "loading" } | { state: "ready"; url: string } | { state: "failed" };

// Свои фото из обращения. Грузятся, только когда обращение раскрыли:
// каждое идёт через наш сервер из Telegram, и тянуть их для всего списка
// разом — лишний трафик на телефоне куратора.
//
// Маршрут фото — POST (подпись Telegram не должна попадать в адрес), поэтому
// <img src> на него не поставить: берём байты запросом и показываем blob.
function SubmissionPhotos({ submissionId, count }: { submissionId: string; count: number }) {
  const [slots, setSlots] = useState<PhotoSlot[]>(() =>
    Array.from({ length: count }, () => ({ state: "loading" }))
  );
  const [viewer, setViewer] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];

    async function fetchOne(index: number): Promise<PhotoSlot> {
      try {
        const res = await fetch("/api/miniapp/photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: currentInitData(), submissionId, index }),
          signal: timeoutSignal(),
        });
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !type.startsWith("image/")) return { state: "failed" };
        const url = URL.createObjectURL(await res.blob());
        urls.push(url);
        return { state: "ready", url };
      } catch {
        return { state: "failed" };
      }
    }

    Array.from({ length: count }, (_, index) =>
      fetchOne(index).then((slot) => {
        if (cancelled) return;
        setSlots((prev) => prev.map((s, i) => (i === index ? slot : s)));
      })
    );

    // Закрыли обращение — отпускаем картинки из памяти телефона.
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [submissionId, count]);

  // Просмотр закрывается и кнопкой «Назад» на клавиатуре (Esc).
  useEffect(() => {
    if (!viewer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewer(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewer]);

  return (
    <>
      <span className={styles.noteLabel}>Скриншоттар</span>
      <div className={styles.photoRow}>
        {slots.map((slot, index) =>
          slot.state === "ready" ? (
            <button
              key={index}
              type="button"
              className={styles.photoOpen}
              onClick={() => setViewer(slot.url)}
              aria-label={`${index + 1}-суретті ашу`}
            >
              {/* blob: из ответа сервера — next/image тут не к месту. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={slot.url} alt="" className={styles.photoThumb} />
            </button>
          ) : (
            <span
              key={index}
              className={`${styles.photoThumb} ${styles.photoPlaceholder}`}
              aria-label={slot.state === "failed" ? "Сурет жүктелмеді" : "Сурет жүктелуде"}
            >
              {slot.state === "failed" ? "!" : ""}
            </span>
          )
        )}
      </div>
      {slots.some((slot) => slot.state === "failed") && (
        <p className={styles.footer}>Кейбір суреттер жүктелмеді — кейінірек қайта ашыңыз</p>
      )}

      {viewer && (
        <div
          className={styles.viewer}
          role="dialog"
          aria-modal="true"
          aria-label="Скриншот"
          onClick={() => setViewer(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewer} alt="Скриншот" className={styles.viewerImage} />
          <button type="button" className={styles.viewerClose} autoFocus>
            Жабу
          </button>
        </div>
      )}
    </>
  );
}
