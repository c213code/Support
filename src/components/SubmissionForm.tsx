"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Script from "next/script";
import { OFFICIAL_GROUPS } from "@/lib/groups";
import styles from "./SubmissionForm.module.css";

// Интерфейс формы — на казахском: кураторы, для которых она сделана, пишут
// по-казахски. Комментарии в коде — по-русски, как во всём проекте.

// Минимум Telegram WebApp API, которым пользуется форма
// (core.telegram.org/bots/webapps). Версии — в isVersionAtLeast ниже:
// старые клиенты Telegram части методов не знают.
type BottomButton = {
  setParams: (params: { text?: string; is_active?: boolean; is_visible?: boolean }) => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  hide: () => void;
  onClick: (callback: () => void) => void;
  offClick: (callback: () => void) => void;
};

type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
  close: () => void;
  isVersionAtLeast: (version: string) => boolean;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  enableClosingConfirmation: () => void;
  disableClosingConfirmation: () => void;
  disableVerticalSwipes: () => void;
  HapticFeedback: {
    selectionChanged: () => void;
    impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred: (type: "error" | "success" | "warning") => void;
  };
  MainButton: BottomButton;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

// Форма открыта из Telegram, только если есть подписанная initData: сам
// скрипт telegram-web-app.js создаёт WebApp и в обычном браузере.
function telegramApp(): TelegramWebApp | null {
  const app = window.Telegram?.WebApp;
  return app?.initData ? app : null;
}

// Подпись Telegram для сервера. Основной источник — скрипт Telegram; если он
// не загрузился, Telegram всё равно передаёт те же данные в адресе страницы
// (#tgWebAppData=…) — с ними отправка работает и без скрипта.
function currentInitData(): string {
  const fromScript = window.Telegram?.WebApp?.initData;
  if (fromScript) return fromScript;
  return new URLSearchParams(window.location.hash.slice(1)).get("tgWebAppData") ?? "";
}

function haptic(kind: "select" | "tap" | "success" | "warning" | "error") {
  const app = telegramApp();
  if (!app?.isVersionAtLeast("6.1")) return;
  if (kind === "select") app.HapticFeedback.selectionChanged();
  else if (kind === "tap") app.HapticFeedback.impactOccurred("light");
  else app.HapticFeedback.notificationOccurred(kind);
}

// Цвет плитки — цвет группы на доске поддержки (groupColor в
// src/lib/groups.ts), чтобы куратор видел тот же знак, которым тикет будет
// отмечен у дежурного. Значения продублированы вручную (оттенки -600 тех же
// цветов) — при смене цветов в groups.ts поправить и здесь.
const GROUP_HUE: Record<string, string> = {
  "Әдістеме & IT": "#7c3aed",
  "Сату - Платформа": "#0d9488",
  "IT & Product": "#0284c7",
  "IT + Сервис": "#ea580c",
};

// Черновик живёт на телефоне: закрыл форму случайно — текст на месте.
// Фото в черновик не кладём (десятки-сотни КБ, localStorage не для этого).
const DRAFT_KEY = "support-form-draft-v1";
// Куратор обычно пишет в одну и ту же группу — подставляем её сразу.
const LAST_GROUP_KEY = "support-form-last-group";

// Потолок фото. Не 10 МБ Telegram, а меньше лимита Vercel на тело запроса
// (4.5 МБ): больший файл платформа отбросит ещё до нашего маршрута. Сжатое
// фото весит сотни КБ — лимит касается только оригинала, который браузер
// не смог сжать. Тот же лимит проверяет сервер (POST /api/miniapp/submit).
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
// Сколько ждать ответа сервера. Самый долгий путь там — ИИ-описание плюс
// загрузка фото в Telegram (до 20 с); минута — с большим запасом.
const SUBMIT_TIMEOUT_MS = 60_000;
// Сколько ждать скрипт Telegram, прежде чем признать, что он не загрузился.
const SCRIPT_TIMEOUT_MS = 10_000;

const PHOTO_TOO_BIG = "Фото тым үлкен — экранның скриншотын жасап, соны тіркеңіз";

type Draft = {
  groupName: string;
  description: string;
  studentContact: string;
  lessonLink: string;
  submissionId: string;
};

// id этой отправки: по нему сервер узнаёт повтор (ответ потерялся, куратор
// нажал ещё раз) и не заводит второй тикет. Живёт в черновике — повтор
// узнаётся и после переоткрытия формы; новый — после успешной отправки.
function newSubmissionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Хранилище недоступно (приватный режим и т.п.) — форма работает и без
    // черновика, просто не переживёт закрытие.
  }
}

// Сжимаем фото на телефоне до отправки: скрин с камеры весит 2-4 МБ, после
// — сотни килобайт, и текст ошибки на нём остаётся читаемым. JPEG, а не
// WebP: sendPhoto в Telegram гарантированно принимает JPEG. Любой сбой —
// исключение, а не тихая подмена: решение о запасном пути принимает
// pickPhoto.
async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  // Без контекста (iOS при нехватке памяти) рисовать некуда, и получился бы
  // пустой белый JPEG — агенту это хуже честной ошибки.
  if (!ctx) {
    bitmap.close();
    throw new Error("canvas 2d недоступен");
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob вернул пустоту"))),
      "image/jpeg",
      0.82
    )
  );
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} КБ`
    : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

// Почта или телефон — подсказываем на лету, чтобы опечатку было видно до
// отправки, а не когда дежурный не найдёт ученика.
function contactKind(value: string): "empty" | "email" | "phone" | "unknown" {
  const v = value.trim();
  if (!v) return "empty";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return "email";
  const digits = v.replace(/[\s()+-]/g, "");
  if (/^\d{10,12}$/.test(digits)) return "phone";
  return "unknown";
}

// Урок можно указать двумя способами, и оба одинаково годятся: ссылкой или
// «ай-аптой» — привязкой к программе (3-ай 2-апта), по которой дежурный сам
// найдёт нужное занятие. Ссылка есть не всегда, а ай-апта — почти всегда.
function lessonKind(value: string): "empty" | "url" | "week" | "text" {
  const v = value.trim();
  if (!v) return "empty";
  if (/^https?:\/\/\S+$/i.test(v)) return "url";
  if (/\d\s*-?\s*(ай|апта)/i.test(v)) return "week";
  return "text";
}

// Картинка из буфера обмена, если она там есть.
function imageFromClipboard(event: ClipboardEvent): File | null {
  const items = Array.from(event.clipboardData?.items ?? []);
  const item = items.find((i) => i.kind === "file" && i.type.startsWith("image/"));
  return item?.getAsFile() ?? null;
}

const FIELD_IDS = {
  group: "field-group",
  description: "field-description",
  contact: "field-contact",
  link: "field-link",
  photo: "field-photo",
} as const;
type Field = keyof typeof FIELD_IDS;

function CheckIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth={size > 20 ? 2.4 : 3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.1l1.3-2h6.2l1.3 2h2.1A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function SubmissionForm() {
  // loading — скрипт Telegram ещё грузится; telegram — открыто из Telegram;
  // browser — скрипт есть, а подписи нет: открыто не из Telegram;
  // script-failed — скрипт не загрузился (бывает и внутри Telegram).
  const [env, setEnv] = useState<"loading" | "telegram" | "browser" | "script-failed">("loading");
  const [restored, setRestored] = useState(false);

  const [groupName, setGroupName] = useState("");
  const [description, setDescription] = useState("");
  const [studentContact, setStudentContact] = useState("");
  const [lessonLink, setLessonLink] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [submissionId, setSubmissionId] = useState(newSubmissionId);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ошибки полей показываем только после первой попытки отправить — не
  // встречаем человека красным текстом на пустой форме.
  const [showErrors, setShowErrors] = useState(false);
  const [sent, setSent] = useState<{ groupName: string; description: string } | null>(null);

  // Свежие версии обработчиков для подписок, которые живут дольше одного
  // рендера (MainButton, вставка из буфера), — иначе они звали бы функцию
  // со старым состоянием формы.
  const submitRef = useRef<() => void>(() => {});
  const pickPhotoRef = useRef<(file: File) => void>(() => {});
  // Синхронный замок отправки. sending из состояния не годится: нажатия
  // MainButton приходят событиями Telegram, React не успевает перерисовать
  // между двумя быстрыми тапами, и без замка ушли бы два запроса.
  const inFlightRef = useRef(false);

  function onTelegramReady() {
    const app = window.Telegram?.WebApp;
    if (!app?.initData) {
      setEnv("browser");
      return;
    }
    app.ready();
    app.expand();
    if (app.isVersionAtLeast("6.1")) {
      // Шапка и фон вокруг страницы — того же цвета, что страница: без
      // полосы другого цвета над формой.
      app.setHeaderColor("secondary_bg_color");
      app.setBackgroundColor("secondary_bg_color");
    }
    // Иначе свайп вниз при прокрутке длинной формы закрывает мини-апп.
    if (app.isVersionAtLeast("7.7")) app.disableVerticalSwipes();
    setEnv("telegram");
  }

  // Скрипт может зависнуть так, что не сработает ни onReady, ни onError, —
  // тогда не было бы ни MainButton, ни кнопки на странице.
  useEffect(() => {
    const t = setTimeout(
      () => setEnv((current) => (current === "loading" ? "script-failed" : current)),
      SCRIPT_TIMEOUT_MS
    );
    return () => clearTimeout(t);
  }, []);

  // Черновик и последняя группа — с телефона. setState — вне синхронного
  // тела эффекта (как и в других формах проекта), иначе линтер ругается на
  // каскадные рендеры; страница собирается статически, поэтому читать
  // localStorage при первом рендере нельзя — разошлась бы гидратация.
  useEffect(() => {
    const raw = readStorage(DRAFT_KEY);
    const lastGroup = readStorage(LAST_GROUP_KEY);
    const t = setTimeout(() => {
      try {
        const draft = raw ? (JSON.parse(raw) as Partial<Draft>) : {};
        setGroupName(draft.groupName || lastGroup || "");
        setDescription(draft.description ?? "");
        setStudentContact(draft.studentContact ?? "");
        setLessonLink(draft.lessonLink ?? "");
        if (draft.submissionId) setSubmissionId(draft.submissionId);
      } catch {
        if (lastGroup) setGroupName(lastGroup);
      }
      setRestored(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!restored || sent) return;
    const draft: Draft = { groupName, description, studentContact, lessonLink, submissionId };
    const empty = !description && !studentContact && !lessonLink;
    writeStorage(DRAFT_KEY, empty ? null : JSON.stringify(draft));
  }, [restored, sent, groupName, description, studentContact, lessonLink, submissionId]);

  const dirty = Boolean(description || studentContact || lessonLink || photo);

  // Закрыть начатую форму — спросить. Текст переживёт закрытие в черновике,
  // фото — нет; различать это в одном системном вопросе Telegram нельзя,
  // поэтому спрашиваем всегда, когда что-то начато.
  useEffect(() => {
    const app = telegramApp();
    if (!app?.isVersionAtLeast("6.2")) return;
    if (dirty && !sent) app.enableClosingConfirmation();
    else app.disableClosingConfirmation();
  }, [env, dirty, sent]);

  // Отправка внутри Telegram — нативной нижней кнопкой: она всегда на месте,
  // не прыгает под клавиатурой и показывает прогресс сама.
  useEffect(() => {
    const button = telegramApp()?.MainButton;
    if (!button) return;
    if (sent) {
      button.hide();
      return;
    }
    button.setParams({
      text: sending ? "Жіберілуде…" : "Өтінішті жіберу",
      is_visible: true,
      is_active: !sending && !compressing,
    });
    if (sending) button.showProgress(false);
    else button.hideProgress();
  }, [env, sent, sending, compressing]);

  useEffect(() => {
    const button = telegramApp()?.MainButton;
    if (!button) return;
    const onClick = () => submitRef.current();
    button.onClick(onClick);
    return () => button.offClick(onClick);
  }, [env]);

  // Скриншот из буфера обмена: Ctrl+V / ⌘V где угодно на форме (компьютер)
  // или «Қою» в зоне вставки (телефон). Если в буфере ещё и текст — его
  // вставку в поле не трогаем, забираем только картинку.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const file = imageFromClipboard(event);
      if (!file) return;
      if (!event.clipboardData?.types.includes("text/plain")) event.preventDefault();
      pickPhotoRef.current(file);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    submitRef.current = submit;
    pickPhotoRef.current = pickPhoto;
  });

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  async function pickPhoto(file: File | undefined) {
    if (!file || sent) return;
    setError(null);
    setCompressing(true);
    // Не каждый браузер умеет открыть любой формат (HEIC на Android, например)
    // — тогда пробуем отправить оригинал, если он в лимите. Telegram может
    // его не принять (тот же HEIC) — тогда сервер попросит скриншот.
    let chosen: Blob | null = null;
    try {
      chosen = await compressImage(file);
    } catch (err) {
      // Причина — для отладки в WebView, если куратор пожалуется.
      console.warn("[miniapp] фото не сжалось, пробую оригинал:", err);
      if (file.type.startsWith("image/") && file.size <= MAX_PHOTO_BYTES) chosen = file;
    }
    if (chosen) {
      setPhoto(chosen);
      setPhotoPreview(URL.createObjectURL(chosen));
      haptic("tap");
    } else {
      setError(
        file.size > MAX_PHOTO_BYTES
          ? PHOTO_TOO_BIG
          : "Бұл фотоны ашу мүмкін болмады — скриншот жасаңыз немесе басқа фото таңдаңыз"
      );
      haptic("error");
    }
    setCompressing(false);
  }

  function removePhoto() {
    setPhoto(null);
    setPhotoPreview(null);
  }

  const missing: Field[] = [
    ...(!groupName ? (["group"] as const) : []),
    ...(!description.trim() ? (["description"] as const) : []),
    ...(!studentContact.trim() ? (["contact"] as const) : []),
    ...(!lessonLink.trim() ? (["link"] as const) : []),
    ...(!photo ? (["photo"] as const) : []),
  ];
  const isMissing = (field: Field) => showErrors && missing.includes(field);

  async function submit() {
    if (inFlightRef.current || compressing) return;
    if (missing.length > 0) {
      setShowErrors(true);
      haptic("warning");
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document
        .getElementById(FIELD_IDS[missing[0]])
        ?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
      return;
    }
    if (!photo) return;

    inFlightRef.current = true;
    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("initData", currentInitData());
      form.append("submissionId", submissionId);
      form.append("groupName", groupName);
      form.append("description", description);
      form.append("studentContact", studentContact);
      form.append("lessonLink", lessonLink);
      form.append("photo", photo, "photo.jpg");
      const res = await fetch("/api/miniapp/submit", {
        method: "POST",
        body: form,
        signal:
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(SUBMIT_TIMEOUT_MS)
            : undefined,
      });
      const data = await res.json().catch(() => null);
      // 413 может прийти и от самой платформы (Vercel) — уже не нашим JSON.
      if (res.status === 413) {
        setError(PHOTO_TOO_BIG);
        haptic("error");
        return;
      }
      // Успех — только явный ответ нашего маршрута. 200 от чего-то другого
      // (например, редирект на страницу входа) — это не отправка, и стирать
      // черновик нельзя.
      if (!res.ok || data?.ok !== true) {
        setError(data?.error ?? `Жіберілмеді (қате ${res.status}) — қайталап көріңіз`);
        haptic("error");
        return;
      }
      writeStorage(DRAFT_KEY, null);
      writeStorage(LAST_GROUP_KEY, groupName);
      setSent({ groupName, description: description.trim() });
      haptic("success");
      window.scrollTo({ top: 0 });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      setError(
        timedOut
          ? "Сервер бір минут ішінде жауап бермеді — қайта жіберіңіз, екінші өтініш пайда болмайды"
          : "Байланыс жоқ — интернетті тексеріп, қайта жіберіңіз"
      );
      haptic("error");
    } finally {
      inFlightRef.current = false;
      setSending(false);
    }
  }

  function startOver() {
    // Группа остаётся: следующее обращение почти всегда туда же.
    setDescription("");
    setStudentContact("");
    setLessonLink("");
    removePhoto();
    setSubmissionId(newSubmissionId());
    setShowErrors(false);
    setError(null);
    setSent(null);
    window.scrollTo({ top: 0 });
  }

  const kind = contactKind(studentContact);
  const lesson = lessonKind(lessonLink);
  // Кнопка на странице — там, где нет MainButton Telegram.
  const pageButton = env === "browser" || env === "script-failed";

  const telegramScript = (
    <Script
      src="https://telegram.org/js/telegram-web-app.js"
      onReady={onTelegramReady}
      onError={() => setEnv("script-failed")}
    />
  );

  if (sent) {
    const hue = GROUP_HUE[sent.groupName];
    const group = OFFICIAL_GROUPS.find((g) => g.name === sent.groupName);
    return (
      <main className={styles.root} lang="kk">
        {telegramScript}
        <div className={styles.success} role="status">
          <div className={styles.successMark}>
            <CheckIcon size={38} />
          </div>
          <h1 className={styles.successTitle}>Өтініш жіберілді</h1>
          <p className={styles.successText}>Кезекші оны қолдау тақтасынан көреді.</p>

          <div className={`${styles.list} ${styles.summary}`}>
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>Топ</span>
              <span className={styles.summaryValue} style={{ color: hue }}>
                {group?.emoji} {sent.groupName}
              </span>
            </div>
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>Мәні</span>
              <span className={styles.summaryValue}>
                {sent.description.length > 140
                  ? `${sent.description.slice(0, 140)}…`
                  : sent.description}
              </span>
            </div>
          </div>

          <button type="button" className={styles.primaryButton} onClick={startOver}>
            Жаңа өтініш
          </button>
          {env === "telegram" && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => window.Telegram?.WebApp?.close()}
            >
              Жабу
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className={styles.root} lang="kk">
      {telegramScript}

      <h1 className={styles.title}>Жаңа өтініш</h1>
      <p className={styles.subtitle}>Кезекші оны қолдау тақтасынан көреді</p>

      {env === "browser" && (
        <p className={styles.notice}>
          Форма Telegram-нан ашылмаған, сондықтан жіберілмейді. Оны боттағы
          «Өтініш жіберу» батырмасы арқылы ашыңыз.
        </p>
      )}
      {env === "script-failed" && (
        <p className={styles.notice}>
          Telegram модулі жүктелмеді — интернетті тексеріңіз. Төмендегі батырмамен
          жіберіп көруге болады; болмаса, форманы жауып, боттан қайта ашыңыз.
        </p>
      )}

      <section className={styles.section} id={FIELD_IDS.group}>
        <span className={styles.sectionHeader} id="group-label">
          Қай топқа жіберу
        </span>
        <div className={styles.groups} role="group" aria-labelledby="group-label">
          {OFFICIAL_GROUPS.map((g) => {
            const selected = groupName === g.name;
            return (
              <button
                key={g.name}
                type="button"
                aria-pressed={selected}
                className={styles.groupTile}
                style={{ "--hue": GROUP_HUE[g.name] } as CSSProperties}
                onClick={() => {
                  if (!selected) haptic("select");
                  setGroupName(g.name);
                }}
              >
                <span className={styles.groupEmoji} aria-hidden="true">
                  {g.emoji}
                </span>
                <span className={styles.groupName}>{g.name}</span>
                {selected && (
                  <span className={styles.groupCheck}>
                    <CheckIcon size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {isMissing("group") && (
          <p className={`${styles.footer} ${styles.footerError}`}>Топты таңдаңыз</p>
        )}
      </section>

      <section className={styles.section}>
        <label className={styles.sectionHeader} htmlFor={FIELD_IDS.description}>
          Не болды
        </label>
        <div className={styles.list}>
          <textarea
            id={FIELD_IDS.description}
            className={`${styles.input} ${styles.textarea}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Мысалы: оқушыда геометриядан тест ашылмайды, «500 қатесі» шығады"
            maxLength={4000}
          />
        </div>
        <p
          className={`${styles.footer} ${isMissing("description") ? styles.footerError : ""}`}
        >
          {isMissing("description")
            ? "Не болғанын жазыңыз"
            : "Оқушы не істеді және не көрді — сонда кезекшіге қайта сұраудың қажеті болмайды"}
        </p>
      </section>

      <section className={styles.section}>
        <label className={styles.sectionHeader} htmlFor={FIELD_IDS.contact}>
          Оқушы
        </label>
        <div className={styles.list}>
          <input
            id={FIELD_IDS.contact}
            className={styles.input}
            value={studentContact}
            onChange={(e) => setStudentContact(e.target.value)}
            placeholder="Поштасы немесе телефоны"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode={kind === "phone" ? "tel" : "email"}
            maxLength={200}
          />
        </div>
        <p
          className={`${styles.footer} ${
            isMissing("contact") || kind === "unknown"
              ? styles.footerError
              : kind === "email" || kind === "phone"
                ? styles.footerOk
                : ""
          }`}
        >
          {isMissing("contact")
            ? "Оқушының поштасы немесе телефоны керек"
            : kind === "email"
              ? "Оқушының поштасы"
              : kind === "phone"
                ? "Оқушының телефоны"
                : kind === "unknown"
                  ? "Пошта немесе телефонға ұқсамайды — тексеріңіз"
                  : "Поштасыз немесе телефонсыз кезекші оқушыны таба алмайды"}
        </p>
      </section>

      <section className={styles.section}>
        <label className={styles.sectionHeader} htmlFor={FIELD_IDS.link}>
          Сабақ немесе тапсырма
        </label>
        <div className={styles.list}>
          <input
            id={FIELD_IDS.link}
            className={styles.input}
            value={lessonLink}
            onChange={(e) => setLessonLink(e.target.value)}
            placeholder="Сілтеме немесе ай-апта (3-ай 2-апта)"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={500}
          />
        </div>
        <p
          className={`${styles.footer} ${
            isMissing("link")
              ? styles.footerError
              : lesson === "url" || lesson === "week"
                ? styles.footerOk
                : ""
          }`}
        >
          {isMissing("link")
            ? "Сабақтың сілтемесі немесе ай-аптасы керек"
            : lesson === "url"
              ? "Сабақтың сілтемесі"
              : lesson === "week"
                ? "Ай-апта көрсетілді"
                : lesson === "text"
                  ? "Сілтеме де, ай-апта да жарайды — мысалы: 3-ай 2-апта"
                  : "Сілтемені қойыңыз немесе ай-аптаны жазыңыз (3-ай 2-апта)"}
        </p>
      </section>

      <section className={styles.section} id={FIELD_IDS.photo}>
        <span className={styles.sectionHeader}>Скриншот</span>
        <div className={styles.list}>
          {photo && photoPreview ? (
            <div className={styles.photoFilled}>
              {/* Локальный blob: из выбранного файла — next/image тут не к месту. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoPreview} alt="Тіркелген скриншот" className={styles.thumb} />
              <div className={styles.photoMeta}>
                Скриншот тіркелді
                <div className={styles.photoSize}>{formatSize(photo.size)}</div>
              </div>
              <div className={styles.photoActions}>
                <label className={styles.textButton}>
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => {
                      pickPhoto(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  Ауыстыру
                </label>
                <button
                  type="button"
                  className={`${styles.textButton} ${styles.textButtonDestructive}`}
                  onClick={removePhoto}
                >
                  Өшіру
                </button>
              </div>
            </div>
          ) : (
            <>
              <label className={styles.photoPick}>
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(e) => {
                    pickPhoto(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <CameraIcon />
                {compressing ? "Фото сығылуда…" : "Скриншот тіркеу"}
              </label>
              {/* Вставку ловит общий обработчик paste выше; здесь — только
                  место, где телефон покажет «Қою» по долгому нажатию. */}
              <div
                className={styles.pasteZone}
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-label="Көшірілген скриншотты осында қойыңыз"
                inputMode="none"
                data-placeholder="Көшірілген скриншотты осында қойыңыз: басып тұрып → «Қою»"
                onInput={(e) => {
                  e.currentTarget.textContent = "";
                }}
              />
            </>
          )}
        </div>
        <p className={`${styles.footer} ${isMissing("photo") ? styles.footerError : ""}`}>
          {isMissing("photo")
            ? "Қатенің скриншотын тіркеңіз"
            : "Телефонда сығылады — жіберу бірнеше секунд алады"}
        </p>
      </section>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {pageButton && (
        <button
          type="button"
          className={styles.primaryButton}
          onClick={submit}
          disabled={sending || compressing}
        >
          {sending ? "Жіберілуде…" : "Өтінішті жіберу"}
        </button>
      )}
    </main>
  );
}
