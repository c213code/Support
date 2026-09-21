"use client";

import { useEffect, useState } from "react";
import { fieldVisible, type SubmissionLabel } from "@/lib/submissionLabels";
import { currentInitData, haptic } from "@/lib/miniappClient";
import styles from "./SubmissionForm.module.css";

// Состояние автопроверки контакта на платформе: свободен ли новый номер или
// почта. "unavailable" — проверить не вышло (инструмент выключен, платформа
// молчит); тогда форма спрашивает то же самое вручную.
type CheckState =
  | { status: "loading" }
  | { status: "free" }
  | { status: "taken"; name: string | null }
  | { status: "unavailable" };

// Пауза перед запросом: номер набирают по цифре, и без неё запрос уходил бы
// на каждое нажатие.
const CHECK_DEBOUNCE_MS = 600;

// Поля выбранного ярлыка (см. lib/submissionLabels.ts). Что именно спрашивать,
// решает справочник — здесь только отрисовка, поэтому новая типовая проблема
// добавляется одним объектом в конфиге, без правок интерфейса.
//
// Скриншоты этот компонент пропускает: в форме для них своя секция со сжатием,
// вставкой из буфера и превью, и переносить её сюда незачем — ярлык лишь
// задаёт ей подпись и минимальное количество.

type Values = Record<string, string | string[]>;

export function LabelFields({
  label,
  values,
  onChange,
  missing,
  fieldId,
}: {
  label: SubmissionLabel;
  values: Values;
  onChange: (id: string, value: string | string[]) => void;
  // id полей, которые подсвечиваем как незаполненные (после первой попытки
  // отправки — до неё форма молчит и не ругается заранее).
  missing: string[];
  fieldId: (id: string) => string;
}) {
  const [checks, setChecks] = useState<Record<string, CheckState>>({});

  // Поля, которые проверяются на платформе, и их текущие значения — по ним
  // же перезапускается эффект.
  const watched = label.fields
    .filter((f) => f.checkOccupancy)
    .map((f) => `${f.id}=${typeof values[f.id] === "string" ? values[f.id] : ""}`)
    .join("|");

  useEffect(() => {
    const pending = label.fields
      .filter((f) => f.checkOccupancy)
      .map((f) => ({ field: f, value: (typeof values[f.id] === "string" ? values[f.id] : "") as string }))
      .filter(({ field, value }) => {
        const v = value.trim();
        if (!fieldVisible(field, values)) return false;
        return field.type === "email" ? v.includes("@") && v.length >= 5 : v.replace(/\D/g, "").length >= 9;
      });
    if (pending.length === 0) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const { field, value } of pending) {
        setChecks((prev) => ({ ...prev, [field.id]: { status: "loading" } }));
        try {
          const res = await fetch("/api/miniapp/check-contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ initData: currentInitData(), contact: value.trim() }),
          });
          const data = (await res.json().catch(() => null)) as {
            available?: boolean;
            taken?: boolean;
            name?: string | null;
          } | null;
          if (cancelled) return;
          if (!data?.available) {
            setChecks((prev) => ({ ...prev, [field.id]: { status: "unavailable" } }));
            continue;
          }
          setChecks((prev) => ({
            ...prev,
            [field.id]: data.taken
              ? { status: "taken", name: data.name ?? null }
              : { status: "free" },
          }));
          // Ответ платформы — это и есть ответ на вопрос «бар ма?»: по нему
          // открывается следующий вопрос, что делать с тем пользователем.
          onChange("occupied", data.taken ? "yes" : "no");
        } catch {
          if (!cancelled) {
            setChecks((prev) => ({ ...prev, [field.id]: { status: "unavailable" } }));
          }
        }
      }
    }, CHECK_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched, label.id]);

  // Ответила ли автопроверка хоть по одному полю — тогда поле, которое она
  // заполняет (occupied), спрашивать не нужно.
  const autoAnswered = label.fields.some((f) => {
    if (!f.checkOccupancy) return false;
    const state = checks[f.id]?.status;
    return state === "free" || state === "taken";
  });

  // Что показать под проверяемым полем.
  function checkNote(id: string) {
    const state = checks[id];
    if (!state) return null;
    if (state.status === "loading") {
      return <p className={styles.footer}>Тексерілуде…</p>;
    }
    if (state.status === "unavailable") {
      return (
        <p className={styles.footer}>Тексеру мүмкін болмады — төменде өзіңіз көрсетіңіз</p>
      );
    }
    if (state.status === "free") {
      return (
        <p className={`${styles.footer} ${styles.footerOk}`}>Бос — қолданушы жоқ</p>
      );
    }
    return (
      <p className={`${styles.footer} ${styles.footerError}`}>
        Бос емес{state.name ? ` — ${state.name}` : ""}
      </p>
    );
  }

  return (
    <>
      {label.fields.map((field, index) => {
        if (!fieldVisible(field, values)) return null;
        // Поле, которое заполняет автопроверка, спрашиваем только когда она
        // не сработала.
        if (field.autoFilled && autoAnswered) return null;
        const invalid = missing.includes(field.id);
        // Ключ с индексом: у ярлыка бывают два поля с одним id для разных
        // веток («кірмей тұр»: свой набор для прошедших регистрацию и для
        // тех, кто не прошёл) — одновременно видно всегда только одно.
        const key = `${field.id}-${index}`;

        // Скриншоты рисует сама форма — своей секцией, ниже полей.
        if (field.type === "photos") return null;

        if (field.type === "select") {
          const current = typeof values[field.id] === "string" ? (values[field.id] as string) : "";
          return (
            <section className={styles.section} key={key} id={fieldId(field.id)}>
              <span className={styles.sectionHeader}>{field.label}</span>
              <div className={styles.choices} role="group">
                {(field.options ?? []).map((option) => {
                  const selected = current === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      className={`${styles.choice} ${selected ? styles.choiceOn : ""}`}
                      onClick={() => {
                        if (!selected) haptic("select");
                        onChange(field.id, option.value);
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              {field.hint && <p className={styles.footer}>{field.hint}</p>}
              {invalid && (
                <p className={`${styles.footer} ${styles.footerError}`}>Таңдаңыз</p>
              )}
            </section>
          );
        }

        // Повторяемое поле: у одной правки бывает несколько потоков, и вместо
        // «перечислите через запятую» куратор добавляет столько строк, сколько
        // нужно.
        if (field.repeatable) {
          const list = Array.isArray(values[field.id])
            ? (values[field.id] as string[])
            : [typeof values[field.id] === "string" ? (values[field.id] as string) : ""];
          return (
            <section className={styles.section} key={key} id={fieldId(field.id)}>
              <span className={styles.sectionHeader}>{field.label}</span>
              <div className={styles.list}>
                {list.map((value, i) => (
                  <input
                    key={i}
                    className={styles.input}
                    value={value}
                    inputMode={field.type === "link" ? "url" : "text"}
                    placeholder={field.placeholder}
                    onChange={(e) => {
                      const next = [...list];
                      next[i] = e.target.value;
                      onChange(field.id, next);
                    }}
                  />
                ))}
              </div>
              <button
                type="button"
                className={styles.addMore}
                onClick={() => {
                  haptic("select");
                  onChange(field.id, [...list, ""]);
                }}
              >
                + Тағы қосу
              </button>
              {field.hint && <p className={styles.footer}>{field.hint}</p>}
              {invalid && (
                <p className={`${styles.footer} ${styles.footerError}`}>Толтырыңыз</p>
              )}
            </section>
          );
        }

        const value = typeof values[field.id] === "string" ? (values[field.id] as string) : "";
        return (
          <section className={styles.section} key={key} id={fieldId(field.id)}>
            <span className={styles.sectionHeader}>{field.label}</span>
            <div className={styles.list}>
              {field.type === "textarea" ? (
                <textarea
                  className={`${styles.input} ${styles.textarea}`}
                  value={value}
                  placeholder={field.placeholder}
                  onChange={(e) => onChange(field.id, e.target.value)}
                />
              ) : (
                <input
                  className={styles.input}
                  value={value}
                  placeholder={field.placeholder}
                  inputMode={
                    field.type === "phone" ? "tel" : field.type === "email" ? "email" : "text"
                  }
                  autoCapitalize={field.type === "email" ? "none" : undefined}
                  onChange={(e) => onChange(field.id, e.target.value)}
                />
              )}
            </div>
            {field.checkOccupancy && checkNote(field.id)}
            {field.hint && <p className={styles.footer}>{field.hint}</p>}
            {invalid && <p className={`${styles.footer} ${styles.footerError}`}>Толтырыңыз</p>}
          </section>
        );
      })}
    </>
  );
}
