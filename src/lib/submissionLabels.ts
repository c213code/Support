import type { OfficialGroupName } from "@/lib/groups";

// Типовые проблемы («ярлыки») на первом экране формы мини-аппа и поля, которые
// форма спрашивает под каждую.
//
// Зачем: в обращении «оқушы кірмей жатыр» нет ничего, с чем можно работать —
// дежурный переспрашивает почту, скриншот ошибки, прошёл ли ученик регистрацию,
// и на это уходит несколько кругов переписки. По истории из 1019 тикетов пять
// типовых проблем закрывают почти половину потока, и у каждой заранее известно,
// что именно нужно спросить. Ярлык задаёт этот набор полей, и обращение
// приходит сразу полным.
//
// Побочный выигрыш: у тикета появляется категория (видно в репорте, чего
// именно было больше), а платформенные кнопки получают чистые значения —
// например смене почты больше не нужно вылавливать два адреса регуляркой из
// сплошного текста.
//
// Ярлык никогда не обязателен: «Басқа мәселе» с обычным описанием остаётся у
// каждой группы, потому что вторая половина обращений ни в какую категорию не
// укладывается.

export type FieldType =
  | "text"
  | "textarea"
  | "phone"
  | "email"
  | "link"
  | "select"
  // Скриншоты. У формы они и так есть, но ярлык может требовать свой минимум
  // (форма регистрации — это три страницы, и без всех трёх разбирать нечего).
  | "photos";

export type SelectOption = {
  value: string;
  label: string;
};

export type LabelField = {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  // Подсказка под полем — объясняет, откуда взять значение.
  hint?: string;
  options?: SelectOption[];
  // Минимум скриншотов для type: "photos".
  minPhotos?: number;
  // Поле показывается, только когда в другом поле выбрано одно из значений.
  // Так «Тіркеуден өтті ме?» переключает форму между двумя разными наборами
  // вопросов, не разводя один ярлык на три почти одинаковых.
  showIf?: { field: string; equals: string[] };
  // Блок можно добавить ещё раз (у одного вопроса бывает несколько потоков —
  // те же правки в разных ссылках).
  repeatable?: boolean;
};

export type SubmissionLabel = {
  id: string;
  emoji: string;
  // Текст на плитке — коротко, это заголовок, а не предложение.
  title: string;
  // Одна строка под заголовком в развёрнутом виде: когда выбирать этот ярлык.
  hint?: string;
  fields: LabelField[];
};

// Ссылка на урок и «ай-апта» есть не у всех: у продаж таких обращений не
// бывает, там речь про аккаунты и оплату. Поэтому общее поле ссылки показывает
// не форма, а сам ярлык — там, где оно осмысленно.
const LESSON_LINK: LabelField = {
  id: "lessonLink",
  label: "Сабаққа сілтеме немесе ай-апта",
  type: "link",
  required: true,
  placeholder: "Сілтеме немесе 3-ай 2-апта",
};

const DESCRIPTION: LabelField = {
  id: "description",
  label: "Мәселенің сипаттамасы",
  type: "textarea",
  required: true,
  placeholder: "Не болып жатқанын қысқаша жазыңыз",
};

const SCREENSHOT: LabelField = {
  id: "photos",
  label: "Қате көрініп тұрған скрин",
  type: "photos",
  required: true,
  minPhotos: 1,
};

// «Занят ли новый контакт» — один и тот же разговор для номера и для почты:
// если на новом контакте уже есть пользователь, дежурный должен знать, что с
// ним делать, иначе смена упрётся в занятый логин и вернётся переспрашиванием.
function occupancyFields(what: "номер" | "почта"): LabelField[] {
  const subject = what === "номер" ? "жаңа номер" : "жаңа почта";
  return [
    {
      id: "occupied",
      label: `ПФ-да ${subject} бойынша қолданушы бар ма?`,
      type: "select",
      required: true,
      hint: "Тексеріп көрсеңіз — бар болса, онымен не істейтінін айтып кетіңіз",
      options: [
        { value: "no", label: "Жоқ" },
        { value: "yes", label: "Бар" },
        { value: "unknown", label: "Білмеймін" },
      ],
    },
    {
      id: "occupiedAction",
      label: "Ол қолданушыны не істейміз?",
      type: "select",
      required: true,
      showIf: { field: "occupied", equals: ["yes"] },
      options: [
        { value: "delete", label: "Өшіру" },
        { value: "replace", label: "Басқасына ауыстыру" },
      ],
    },
    {
      id: "occupiedReplaceWith",
      label: "Нешеге ауыстырамыз?",
      type: "text",
      required: true,
      showIf: { field: "occupiedAction", equals: ["replace"] },
      placeholder: what === "номер" ? "Жаңа номер" : "Жаңа почта",
    },
  ];
}

const OTHER_LABEL: SubmissionLabel = {
  id: "other",
  emoji: "📝",
  title: "Басқа мәселе",
  hint: "Тізімде жоқ жағдай",
  fields: [DESCRIPTION, { ...SCREENSHOT, required: false, minPhotos: 0 }],
};

// «Басқа мәселе» для групп, где бывает привязка к уроку.
const OTHER_WITH_LESSON: SubmissionLabel = {
  ...OTHER_LABEL,
  fields: [DESCRIPTION, { ...LESSON_LINK, required: false }, { ...SCREENSHOT, required: false, minPhotos: 0 }],
};

const SALES: SubmissionLabel[] = [
  {
    id: "phone-change",
    emoji: "📱",
    title: "Номер өзгерту",
    hint: "Оқушының телефон нөмірін ауыстыру",
    fields: [
      {
        id: "oldContact",
        label: "Ескі номер немесе почта",
        type: "text",
        required: true,
        placeholder: "+7 700 000 00 00 немесе почта",
      },
      {
        id: "newPhone",
        label: "Жаңа номер",
        type: "phone",
        required: true,
        placeholder: "+7 700 000 00 00",
      },
      ...occupancyFields("номер"),
      { ...SCREENSHOT, required: false, minPhotos: 0 },
    ],
  },
  {
    id: "email-change",
    emoji: "✉️",
    title: "Почта өзгерту",
    hint: "Оқушының поштасын ауыстыру",
    fields: [
      {
        id: "oldContact",
        label: "Ескі почта немесе номер",
        type: "text",
        required: true,
        placeholder: "почта немесе +7 700 000 00 00",
      },
      {
        id: "newEmail",
        label: "Жаңа почта",
        type: "email",
        required: true,
        placeholder: "student@gmail.com",
      },
      ...occupancyFields("почта"),
      { ...SCREENSHOT, required: false, minPhotos: 0 },
    ],
  },
  {
    id: "login-issue",
    emoji: "🔐",
    title: "Оқушы аккаунтқа кірмей тұр",
    hint: "Кіру кезінде қате шығады немесе тіркеле алмайды",
    fields: [
      {
        id: "registered",
        label: "Оқушы тіркеуден өтті ме?",
        type: "select",
        required: true,
        options: [
          { value: "yes", label: "Тіркеуден өткен" },
          { value: "no", label: "Тіркеуден өтпеген" },
        ],
      },
      // Прошёл регистрацию: нужен текст ошибки и то, чем он входит.
      {
        id: "errorAndCredentials",
        label: "Шығып тұрған қате, жазылған логин және пароль",
        type: "textarea",
        required: true,
        showIf: { field: "registered", equals: ["yes"] },
        placeholder: "Қате мәтіні, логин, пароль",
      },
      {
        id: "photos",
        label: "Қате көрініп тұрған скрин",
        type: "photos",
        required: true,
        minPhotos: 1,
        showIf: { field: "registered", equals: ["yes"] },
      },
      // Не прошёл: форма регистрации — три страницы, нужны все.
      {
        id: "studentEmail",
        label: "Оқушының поштасы",
        type: "email",
        required: true,
        showIf: { field: "registered", equals: ["no"] },
      },
      {
        id: "photos",
        label: "Тіркеу формасын қалай толтырғаны",
        type: "photos",
        required: true,
        minPhotos: 3,
        hint: "Форманың үш бетінің де скрині керек",
        showIf: { field: "registered", equals: ["no"] },
      },
    ],
  },
  {
    id: "no-message",
    emoji: "📨",
    title: "СМС немесе хабарлама келмеді",
    hint: "Код, сілтеме немесе хабарлама келмей жатыр",
    fields: [
      {
        id: "channel",
        label: "Қайда келмеді?",
        type: "select",
        required: true,
        options: [
          { value: "sms", label: "СМС" },
          { value: "email", label: "Почта" },
        ],
      },
      {
        id: "phone",
        label: "Номер",
        type: "phone",
        required: true,
        showIf: { field: "channel", equals: ["sms"] },
      },
      {
        id: "email",
        label: "Почта",
        type: "email",
        required: true,
        showIf: { field: "channel", equals: ["email"] },
      },
      { ...SCREENSHOT, label: "Келмегені туралы скрин" },
    ],
  },
  OTHER_LABEL,
];

const METHODOLOGY: SubmissionLabel[] = [
  {
    id: "question-edit",
    emoji: "✏️",
    title: "Сұрақ немесе жауапты өзгерту",
    hint: "Мәтін, реттілік, дұрыс жауап",
    fields: [
      {
        id: "lessonType",
        label: "Сұрақ тұрған сабақ түрі",
        type: "select",
        required: true,
        options: [
          { value: "interactive", label: "Интерактив видео" },
          { value: "theory", label: "Теория сабақ" },
          { value: "homework", label: "Үй жұмысы" },
          { value: "test", label: "Тест" },
          { value: "ubt", label: "ҰБТ" },
          { value: "quiz", label: "Куиз гейм" },
        ],
      },
      { ...LESSON_LINK, repeatable: true, hint: "Басқа ағымда да түзету керек болса, тағы сілтеме қосыңыз" },
      {
        id: "questionNumber",
        label: "Сұрақтың нөмірі",
        type: "text",
        required: true,
        placeholder: "Мысалы: 7",
      },
      {
        id: "optionText",
        label: "Вариант (бар болса)",
        type: "text",
        placeholder: "Қай вариант туралы екенін жазыңыз",
      },
      {
        id: "description",
        label: "Нені және қалай өзгерту керек",
        type: "textarea",
        required: true,
        placeholder: "Дұрыс жауап B болуы керек, қазір C тұр",
      },
      { ...SCREENSHOT, label: "Қалай өзгерту керектігі көрсетілген скрин" },
    ],
  },
  {
    id: "lesson-settings",
    emoji: "⚙️",
    title: "Сабақ настройкасын өзгерту",
    hint: "Дедлайн, балл, тогл",
    fields: [
      { ...LESSON_LINK, repeatable: true },
      {
        id: "description",
        label: "Нені және қалай өзгерту керек",
        type: "textarea",
        required: true,
        placeholder: "Дедлайнды 20 қыркүйекке ауыстыру керек",
      },
      { ...SCREENSHOT, label: "Нақты нені өзгерту керегі көрсетілген скрин" },
    ],
  },
  OTHER_WITH_LESSON,
];

const SERVICE: SubmissionLabel[] = [
  {
    id: "discount",
    emoji: "🏷️",
    title: "Жеңілдік бойынша",
    fields: [
      { id: "studentEmail", label: "Оқушының поштасы", type: "email", required: true },
      { ...SCREENSHOT, label: "Қате туындап тұрғаны көрінетін скрин" },
      DESCRIPTION,
    ],
  },
  {
    id: "parent-link",
    emoji: "👨‍👩‍👦",
    title: "АА мен оқушы байланысы",
    hint: "Ата-ана мен оқушы арасындағы байланыс",
    fields: [
      {
        id: "action",
        label: "Не істеу керек?",
        type: "select",
        required: true,
        options: [
          { value: "remove", label: "Байланысты алып тастау" },
          { value: "add", label: "Байланыс қосу" },
          { value: "replace", label: "Байланысты алмастыру" },
        ],
      },
      { id: "parentEmail", label: "Ата-ананың поштасы", type: "email", required: true },
      { id: "studentEmail", label: "Оқушының поштасы", type: "email", required: true },
      { ...DESCRIPTION, required: false },
      { ...SCREENSHOT, required: false, minPhotos: 0 },
    ],
  },
  {
    id: "payment",
    emoji: "💳",
    title: "Төлем бойынша мәселе",
    fields: [
      { ...SCREENSHOT, label: "Төлем туралы скрин" },
      DESCRIPTION,
      {
        id: "expected",
        label: "Қалай болуы керек",
        type: "textarea",
        required: true,
        placeholder: "Дұрыс нәтиже қандай болуы керек",
      },
    ],
  },
  {
    id: "catalog",
    emoji: "📚",
    title: "Каталог немесе курс ұзарту",
    fields: [
      { ...SCREENSHOT, label: "Қате көрінетін скрин" },
      DESCRIPTION,
      {
        id: "expected",
        label: "Қалай болуы керек",
        type: "textarea",
        required: true,
      },
    ],
  },
  OTHER_LABEL,
];

const PRODUCT: SubmissionLabel[] = [
  {
    id: "parent-login",
    emoji: "👪",
    title: "АА кіре алмай жатыр",
    hint: "Ата-ана кабинетіне кіре алмайды",
    fields: [
      { id: "studentEmail", label: "Оқушының поштасы", type: "email", required: true },
      { ...SCREENSHOT, label: "Ата-ана қалай толтырғаны көрінетін скрин" },
      { ...DESCRIPTION, required: false },
    ],
  },
  {
    id: "progress",
    emoji: "📉",
    title: "Прогресс сақталмай жатыр",
    fields: [
      { id: "studentEmail", label: "Оқушының поштасы", type: "email", required: true },
      LESSON_LINK,
      { ...SCREENSHOT, label: "Қате көрінетін скриндер", minPhotos: 1 },
      {
        id: "description",
        label: "Оқушы не істегенін жазыңыз",
        type: "textarea",
        required: true,
        placeholder: "Тапсырманы аяқтады, шықты, кайта кірді — прогресс жоқ",
      },
    ],
  },
  {
    id: "zhzh",
    emoji: "📋",
    title: "ЖЖ бойынша мәселе",
    fields: [
      { id: "curatorEmail", label: "Куратордың поштасы", type: "email", required: true },
      { ...SCREENSHOT, label: "Қате көрінетін скрин" },
      {
        id: "description",
        label: "Толықтай сипаттама",
        type: "textarea",
        required: true,
      },
    ],
  },
  {
    id: "unt-dt",
    emoji: "🎓",
    title: "ҰБТ / ДТ бойынша мәселе",
    hint: "Нәтиже шықпады, қайта тапсыру керек",
    fields: [
      {
        id: "testType",
        label: "Тест түрі",
        type: "select",
        required: true,
        options: [
          { value: "unt", label: "ҰБТ" },
          { value: "dt", label: "ДТ (деңгейлік тест)" },
        ],
      },
      {
        id: "issueKind",
        label: "Не болды?",
        type: "select",
        required: true,
        options: [
          { value: "no-result", label: "Нәтиже шықпады" },
          { value: "reopen", label: "Қайта тапсыру керек" },
          { value: "not-opening", label: "Тест ашылмайды" },
          { value: "other", label: "Басқа" },
        ],
      },
      {
        // Почта обязательна: по ней кезекші сбрасывает результат ДТ прямо с
        // карточки (/platform/reset-unt), и без неё кнопка бесполезна.
        id: "studentEmail",
        label: "Оқушының поштасы",
        type: "email",
        required: true,
        hint: "Осы пошта бойынша кезекші нәтижені қайта ашады",
      },
      { ...SCREENSHOT, label: "Тест экранының скрині" },
      { ...DESCRIPTION, label: "Толықтай сипаттама", required: false },
    ],
  },
  {
    id: "suggestion",
    emoji: "💡",
    title: "Ұсыныс",
    hint: "Жақсарту туралы идея",
    fields: [
      {
        id: "description",
        label: "Ұсынысыңыз",
        type: "textarea",
        required: true,
        placeholder: "Нені жақсартуға болады",
      },
      {
        id: "urgency",
        label: "Қаншалықты шұғыл?",
        type: "select",
        required: true,
        options: [
          { value: "low", label: "Шұғыл емес" },
          { value: "medium", label: "Орташа" },
          { value: "high", label: "Шұғыл" },
        ],
      },
      { ...SCREENSHOT, required: false, minPhotos: 0 },
    ],
  },
  OTHER_WITH_LESSON,
];

export const LABELS_BY_GROUP: Record<OfficialGroupName, SubmissionLabel[]> = {
  "Сату - Платформа": SALES,
  "Әдістеме & IT": METHODOLOGY,
  "IT + Сервис": SERVICE,
  "IT & Product": PRODUCT,
};

export function labelsForGroup(groupName: string): SubmissionLabel[] {
  return LABELS_BY_GROUP[groupName as OfficialGroupName] ?? [];
}

export function findLabel(groupName: string, labelId: string): SubmissionLabel | null {
  return labelsForGroup(groupName).find((l) => l.id === labelId) ?? null;
}

// Показывать ли поле при текущих ответах: у ярлыка «кірмей тұр» половина полей
// зависит от того, прошёл ли ученик регистрацию.
export function fieldVisible(
  field: LabelField,
  values: Record<string, string | string[]>
): boolean {
  if (!field.showIf) return true;
  const current = values[field.showIf.field];
  return typeof current === "string" && field.showIf.equals.includes(current);
}

// Человекочитаемое значение поля — для описания тикета и карточки агента.
export function displayValue(field: LabelField, value: string | string[]): string {
  if (Array.isArray(value)) return value.filter(Boolean).join("\n");
  if (field.type === "select") {
    return field.options?.find((o) => o.value === value)?.label ?? value;
  }
  return value;
}

// Поля, которые ярлык требует, а куратор не заполнил. Одна проверка на форму и
// на сервер: иначе телефон покажет «всё хорошо», а маршрут молча отвергнет.
// photoCount передаётся отдельно — фото живут не в values, а в состоянии формы.
export function missingFields(
  label: SubmissionLabel,
  values: Record<string, string | string[]>,
  photoCount: number
): string[] {
  const missing: string[] = [];
  for (const field of label.fields) {
    if (!field.required) continue;
    if (!fieldVisible(field, values)) continue;

    if (field.type === "photos") {
      if (photoCount < (field.minPhotos ?? 1)) missing.push(field.id);
      continue;
    }

    const value = values[field.id];
    const filled = Array.isArray(value)
      ? value.some((v) => v.trim() !== "")
      : typeof value === "string" && value.trim() !== "";
    if (!filled) missing.push(field.id);
  }
  return missing;
}

// Сколько скриншотов требует выбранный ярлык (0 — не обязательны).
export function requiredPhotos(
  label: SubmissionLabel,
  values: Record<string, string | string[]>
): number {
  for (const field of label.fields) {
    if (field.type !== "photos") continue;
    if (!fieldVisible(field, values)) continue;
    if (field.required) return field.minPhotos ?? 1;
  }
  return 0;
}

// Описание тикета — оно идёт в репорт руководству, поэтому здесь только суть:
// название проблемы и то, что куратор пояснил словами. Почты, телефоны и
// пароли сюда не попадают, хотя ярлык их и спросил, — им место на карточке
// дежурного (см. buildDetails), а не в отчёте.
export function buildSummary(
  label: SubmissionLabel,
  values: Record<string, string | string[]>
): string {
  const own = values["description"];
  const text = typeof own === "string" ? own.trim() : "";
  return text ? `${label.title} — ${text}` : label.title;
}

// Полная расшифровка полей — для дежурного: в ней всё, что спросил ярлык, в
// том порядке, в каком спрашивал. Скриншоты сюда не попадают, они и так на
// карточке отдельными миниатюрами.
export function buildDetails(
  label: SubmissionLabel,
  values: Record<string, string | string[]>
): string {
  const lines: string[] = [label.title];
  for (const field of label.fields) {
    if (field.type === "photos") continue;
    if (!fieldVisible(field, values)) continue;
    const raw = values[field.id];
    if (raw === undefined) continue;
    const text = displayValue(field, raw).trim();
    if (!text) continue;
    lines.push(`${field.label}: ${text}`);
  }
  return lines.join("\n");
}

// Контакт ученика и ссылка на урок нужны отдельно: по ним считаются зацепки
// карточки и работают платформенные кнопки. У каждого ярлыка они называются
// по-своему, поэтому забираем первое подходящее поле, а не одно фиксированное.
const CONTACT_FIELDS = [
  "studentEmail",
  "studentContact",
  "newPhone",
  "newEmail",
  "oldContact",
  "parentEmail",
  "curatorEmail",
  "phone",
  "email",
];

export function extractContact(values: Record<string, string | string[]>): string {
  for (const id of CONTACT_FIELDS) {
    const value = values[id];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function extractLessonLink(values: Record<string, string | string[]>): string {
  const value = values["lessonLink"];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.filter((v) => v.trim()).join(" · ");
  return "";
}
