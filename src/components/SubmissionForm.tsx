"use client";

import { useState } from "react";
import Script from "next/script";
import { OFFICIAL_GROUPS } from "@/lib/groups";

type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
  close: () => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

// Цвета берём из темы Telegram (он сам задаёт эти CSS-переменные внутри
// мини-аппа), чтобы форма выглядела частью приложения, а не чужим сайтом.
// Запасные значения — для открытия в обычном браузере.
const theme = {
  bg: "var(--tg-theme-bg-color, #ffffff)",
  text: "var(--tg-theme-text-color, #0f172a)",
  hint: "var(--tg-theme-hint-color, #64748b)",
  field: "var(--tg-theme-secondary-bg-color, #f1f5f9)",
  button: "var(--tg-theme-button-color, #2563eb)",
  buttonText: "var(--tg-theme-button-text-color, #ffffff)",
};

// Сжимаем фото на телефоне до отправки: скрин с камеры весит 2-4 МБ, после
// — сотни килобайт, и текст ошибки на нём остаётся читаемым. JPEG, а не
// WebP: sendPhoto в Telegram гарантированно принимает JPEG.
async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob ?? file), "image/jpeg", 0.82)
  );
}

// Лимит Telegram на sendPhoto — тот же, что проверяет сервер
// (POST /api/miniapp/submit).
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} КБ`
    : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export function SubmissionForm() {
  // null — скрипт Telegram ещё не загрузился; "" — форма открыта не из
  // Telegram (подписи нет, сервер такую подачу всё равно отклонит).
  const [initData, setInitData] = useState<string | null>(null);

  const [groupName, setGroupName] = useState("");
  const [description, setDescription] = useState("");
  const [studentContact, setStudentContact] = useState("");
  const [lessonLink, setLessonLink] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function onTelegramReady() {
    const app = window.Telegram?.WebApp;
    app?.ready();
    app?.expand();
    setInitData(app?.initData ?? "");
  }

  async function onPhotoPicked(file: File | undefined) {
    if (!file) return;
    setError(null);
    setCompressing(true);
    // Не каждый браузер умеет открыть любой формат (HEIC на Android, например)
    // — тогда отправляем оригинал, если он укладывается в лимит Telegram, а не
    // заставляем куратора искать другое фото.
    let chosen: Blob | null = null;
    try {
      chosen = await compressImage(file);
    } catch {
      if (file.type.startsWith("image/") && file.size <= MAX_PHOTO_BYTES) chosen = file;
    }
    if (chosen) {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPhoto(chosen);
      setPhotoPreview(URL.createObjectURL(chosen));
    } else {
      setError("Не удалось обработать фото — сделайте скриншот или выберите другое");
    }
    setCompressing(false);
  }

  const complete =
    groupName &&
    description.trim() &&
    studentContact.trim() &&
    lessonLink.trim() &&
    photo;

  async function submit() {
    if (!complete || !photo || sending) return;
    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("initData", initData ?? "");
      form.append("groupName", groupName);
      form.append("description", description);
      form.append("studentContact", studentContact);
      form.append("lessonLink", lessonLink);
      form.append("photo", photo, "photo.jpg");
      const res = await fetch("/api/miniapp/submit", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Не удалось отправить (ошибка ${res.status})`);
        return;
      }
      setSent(true);
    } catch {
      setError("Нет связи — проверьте интернет и отправьте ещё раз");
    } finally {
      setSending(false);
    }
  }

  function startOver() {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setDescription("");
    setStudentContact("");
    setLessonLink("");
    setPhoto(null);
    setPhotoPreview(null);
    setSent(false);
  }

  const fieldStyle = { background: theme.field, color: theme.text };
  const fieldClass = "w-full rounded-xl px-3 py-2.5 text-[15px] outline-none";

  return (
    <main
      className="min-h-dvh px-4 pb-8 pt-5"
      style={{ background: theme.bg, color: theme.text }}
    >
      <Script src="https://telegram.org/js/telegram-web-app.js" onReady={onTelegramReady} />

      {initData === "" && (
        <p className="mb-4 rounded-xl px-3 py-2.5 text-sm" style={fieldStyle}>
          Откройте эту форму кнопкой в боте Telegram — иначе обращение не
          отправится.
        </p>
      )}

      {sent ? (
        <div className="py-10 text-center">
          <p className="text-4xl">✅</p>
          <h1 className="mt-3 text-lg font-semibold">Обращение отправлено</h1>
          <p className="mt-1 text-sm" style={{ color: theme.hint }}>
            Дежурный увидит его на доске поддержки.
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <button
              onClick={startOver}
              className="rounded-xl py-3 text-[15px] font-medium"
              style={{ background: theme.button, color: theme.buttonText }}
            >
              Подать ещё одно
            </button>
            <button
              onClick={() => window.Telegram?.WebApp?.close()}
              className="py-2 text-[15px]"
              style={{ color: theme.hint }}
            >
              Закрыть
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <h1 className="text-lg font-semibold">Обращение в поддержку</h1>

          <section>
            <p className="mb-2 text-sm" style={{ color: theme.hint }}>
              Группа
            </p>
            <div className="grid grid-cols-2 gap-2">
              {OFFICIAL_GROUPS.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => setGroupName(g.name)}
                  className="rounded-xl px-3 py-2.5 text-left text-sm"
                  style={
                    groupName === g.name
                      ? { background: theme.button, color: theme.buttonText }
                      : fieldStyle
                  }
                >
                  {g.emoji} {g.name}
                </button>
              ))}
            </div>
          </section>

          <label className="block">
            <span className="mb-2 block text-sm" style={{ color: theme.hint }}>
              Что случилось
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Например: тест по геометрии не открывается, ошибка 500"
              className={fieldClass}
              style={fieldStyle}
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm" style={{ color: theme.hint }}>
              Почта или телефон ученика
            </span>
            <input
              value={studentContact}
              onChange={(e) => setStudentContact(e.target.value)}
              placeholder="student@mail.kz или 87771234567"
              className={fieldClass}
              style={fieldStyle}
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm" style={{ color: theme.hint }}>
              Ссылка на урок или задание
            </span>
            <input
              value={lessonLink}
              onChange={(e) => setLessonLink(e.target.value)}
              placeholder="https://juz40-edu.kz/…"
              inputMode="url"
              className={fieldClass}
              style={fieldStyle}
            />
          </label>

          <section>
            <p className="mb-2 text-sm" style={{ color: theme.hint }}>
              Фото или скриншот
            </p>
            <label
              className="flex cursor-pointer items-center justify-center rounded-xl px-3 py-3 text-sm"
              style={fieldStyle}
            >
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => onPhotoPicked(e.target.files?.[0])}
              />
              {compressing
                ? "Сжимаем фото…"
                : photo
                  ? `Заменить фото · ${formatSize(photo.size)}`
                  : "📎 Прикрепить фото"}
            </label>
            {photoPreview && (
              // Локальный blob: из выбранного файла — next/image тут не к месту.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoPreview}
                alt="Прикреплённое фото"
                className="mt-2 max-h-48 rounded-xl"
              />
            )}
          </section>

          {error && (
            <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>
          )}

          <button
            onClick={submit}
            disabled={!complete || sending || compressing}
            className="w-full rounded-xl py-3 text-[15px] font-medium disabled:opacity-40"
            style={{ background: theme.button, color: theme.buttonText }}
          >
            {sending ? "Отправляем…" : "Отправить"}
          </button>
          {!complete && (
            <p className="text-center text-xs" style={{ color: theme.hint }}>
              Заполните все поля и прикрепите фото
            </p>
          )}
        </div>
      )}
    </main>
  );
}
