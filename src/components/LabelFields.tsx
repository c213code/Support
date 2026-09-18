"use client";

import { fieldVisible, type SubmissionLabel } from "@/lib/submissionLabels";
import { haptic } from "@/lib/miniappClient";
import styles from "./SubmissionForm.module.css";

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
  return (
    <>
      {label.fields.map((field, index) => {
        if (!fieldVisible(field, values)) return null;
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
            {field.hint && <p className={styles.footer}>{field.hint}</p>}
            {invalid && <p className={`${styles.footer} ${styles.footerError}`}>Толтырыңыз</p>}
          </section>
        );
      })}
    </>
  );
}
