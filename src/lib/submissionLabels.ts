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
  // Пока куратор вводит значение, форма спрашивает платформу, занят ли такой
  // контакт (POST /api/miniapp/check-contact), и сама проставляет ответ в
  // поле occupied. Если платформа недоступна, occupied спрашивается вручную.
  checkOccupancy?: boolean;
  // Поле заполняется автопроверкой и показывается, только когда та не
  // сработала.
  autoFilled?: boolean;
  // Служебный выбор, который только разветвляет форму: на карточке доски его
  // не показываем — там место дорогое, а следующая строка говорит то же
  // самое («Оқушының ескі байланысы: Номер» перед «Ескі номер: …»).
  service?: boolean;
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

// «Номер или почта» одним полем не спросить: в текстовое поле нельзя вложить
// маску телефона — под неё попала бы и почта. Поэтому сначала выбор, потом
// нужное поле. Нужно и для старого контакта ученика, и для обоих концов
// переноса платежа, поэтому вынесено сюда.
function contactChoiceFields(opts: {
  prefix: string;
  kindLabel: string;
  phoneLabel: string;
  emailLabel: string;
}): LabelField[] {
  const kindId = `${opts.prefix}Kind`;
  return [
    {
      id: kindId,
      label: opts.kindLabel,
      type: "select",
      required: true,
      service: true,
      options: [
        { value: "phone", label: "Номер" },
        { value: "email", label: "Почта" },
      ],
    },
    {
      id: `${opts.prefix}Phone`,
      label: opts.phoneLabel,
      type: "phone",
      required: true,
      placeholder: "+7 (777) 777 77 77",
      showIf: { field: kindId, equals: ["phone"] },
    },
    {
      id: `${opts.prefix}Email`,
      label: opts.emailLabel,
      type: "email",
      required: true,
      placeholder: "student@gmail.com",
      showIf: { field: kindId, equals: ["email"] },
    },
  ];
}

const oldContactFields = (): LabelField[] =>
  contactChoiceFields({
    prefix: "old",
    kindLabel: "Оқушының ескі байланысы",
    phoneLabel: "Ескі номер",
    emailLabel: "Ескі почта",
  });

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
      // Обычно это выясняет сама форма, спросив платформу; вручную спрашиваем
      // только когда проверить не удалось.
      autoFilled: true,
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

// Предложение по улучшению — не проблема, но приходит от тех же кураторов и
// по тем же четырём направлениям, поэтому ярлык общий для всех групп.
const SUGGESTION_LABEL: SubmissionLabel = {
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
};


// Ярлыки, которые встречаются больше чем в одной группе. По истории тикетов
// «не открывается» — самая частая тема вообще (10–26% в каждой группе), а
// вход, переоткрытие попытки, балл и ошибки платформы идут следом. Держим их
// одним определением, чтобы вопросы были одинаковыми, куда бы обращение ни
// пришло.

const LOGIN_LABEL: SubmissionLabel = {
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
};

const REOPEN_LABEL: SubmissionLabel = {
  id: "reopen",
  emoji: "🔄",
  title: "Қайта ашу керек",
  hint: "Оқушы тапсырманы қате жіберіп қойды",
  fields: [
    {
      id: "what",
      label: "Нені қайта ашу керек?",
      type: "select",
      required: true,
      options: [
        { value: "test", label: "Тест" },
        { value: "quiz", label: "Куиз гейм" },
        { value: "ubt", label: "ҰБТ" },
        { value: "homework", label: "Үй жұмысы" },
      ],
    },
    { id: "studentEmail", label: "Оқушының поштасы", type: "email", required: true },
    LESSON_LINK,
    {
      id: "reason",
      label: "Себебі",
      type: "select",
      required: true,
      options: [
        { value: "accident", label: "Байқамай жіберіп қойды" },
        { value: "technical", label: "Техникалық ақау" },
        { value: "other", label: "Басқа" },
      ],
    },
    { ...SCREENSHOT, label: "Әрекет көрінетін скрин" },
    { ...DESCRIPTION, required: false },
  ],
};

const SCORE_LABEL: SubmissionLabel = {
  id: "score",
  emoji: "💯",
  title: "Балл дұрыс емес",
  hint: "Балл қате есептелген",
  fields: [
    { id: "studentEmail", label: "Оқушының поштасы", type: "email", required: true },
    LESSON_LINK,
    { id: "current", label: "Қазір қандай балл тұр", type: "text", required: true },
    { id: "expected", label: "Қандай болуы керек", type: "text", required: true },
    { ...SCREENSHOT, label: "Балл көрінетін скрин" },
  ],
};

const PLATFORM_ERROR_LABEL: SubmissionLabel = {
  id: "platform-error",
  emoji: "⚠️",
  title: "Платформа қате береді",
  hint: "Баяу жүктеледі немесе қате шығады",
  fields: [
    {
      id: "where",
      label: "Қай жерде?",
      type: "select",
      required: true,
      options: [
        { value: "lesson", label: "Сабақта" },
        { value: "test", label: "Тесте" },
        { value: "video", label: "Видеода" },
        { value: "cabinet", label: "Кабинетте" },
        { value: "other", label: "Басқа" },
      ],
    },
    { id: "studentEmail", label: "Оқушының поштасы", type: "email", required: true },
    {
      // Устройство спрашиваем сразу: половина «платформа не грузится»
      // оказывается старым браузером на телефоне.
      id: "device",
      label: "Неден кіреді?",
      type: "select",
      required: true,
      options: [
        { value: "phone", label: "Телефон" },
        { value: "computer", label: "Компьютер" },
        { value: "both", label: "Екеуінде де" },
      ],
    },
    { ...SCREENSHOT, label: "Қате көрінетін скрин" },
    { ...DESCRIPTION, required: true },
  ],
};

// Почта ученика и у свободного «Басқа мәселе»: именно по нему дежурный чаще
// всего переспрашивает «чей аккаунт», потому что ярлык ничего не подсказал.
// Необязательная: сюда попадают и вопросы без ученика вообще (как что
// устроено, доступ для самого куратора) — требовать почту там значило бы
// заставить вписать любую.
// У свободного ярлыка спрашиваем контакт одним полем: кураторы шлют то
// почту, то номер, и выбор «что именно» здесь только лишний тап. Поэтому
// тип text, а не email — номер в поле для почты телефон не даст ввести
// вовсе. Необязательное: сюда попадают и вопросы без ученика.
const OTHER_STUDENT_CONTACT: LabelField = {
  id: "studentContact",
  label: "Оқушының поштасы немесе нөмірі",
  type: "text",
  required: false,
  placeholder: "student@gmail.com немесе +7 (777) 777 77 77",
  hint: "Мәселе нақты оқушыға қатысты болса",
};

const OTHER_LABEL: SubmissionLabel = {
  id: "other",
  emoji: "📝",
  title: "Басқа мәселе",
  hint: "Тізімде жоқ жағдай",
  fields: [
    DESCRIPTION,
    OTHER_STUDENT_CONTACT,
    { ...SCREENSHOT, required: false, minPhotos: 0 },
  ],
};

// «Басқа мәселе» для групп, где бывает привязка к уроку.
const OTHER_WITH_LESSON: SubmissionLabel = {
  ...OTHER_LABEL,
  fields: [
    DESCRIPTION,
    OTHER_STUDENT_CONTACT,
    { ...LESSON_LINK, required: false },
    { ...SCREENSHOT, required: false, minPhotos: 0 },
  ],
};

const SALES: SubmissionLabel[] = [
  {
    id: "phone-change",
    emoji: "📱",
    title: "Номер өзгерту",
    hint: "Оқушының телефон нөмірін ауыстыру",
    fields: [
      ...oldContactFields(),
      {
        id: "newPhone",
        label: "Жаңа номер",
        type: "phone",
        required: true,
        placeholder: "+7 (777) 777 77 77",
        checkOccupancy: true,
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
      ...oldContactFields(),
      {
        id: "newEmail",
        label: "Жаңа почта",
        type: "email",
        required: true,
        placeholder: "student@gmail.com",
        checkOccupancy: true,
      },
      ...occupancyFields("почта"),
      { ...SCREENSHOT, required: false, minPhotos: 0 },
    ],
  },
  LOGIN_LABEL,
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
        placeholder: "+7 (777) 777 77 77",
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
  {
    id: "payment-merge",
    emoji: "🧾",
    title: "Төлем біріктіру",
    hint: "Бірнеше төлемді бір аккаунтқа жинау",
    fields: [
      ...contactChoiceFields({
        prefix: "student",
        kindLabel: "Оқушының байланысы",
        phoneLabel: "Оқушының номері",
        emailLabel: "Оқушының поштасы",
      }),
      {
        ...SCREENSHOT,
        label: "Қай төлемді қайсыға біріктіру керегі көрінетін скрин",
      },
      { ...DESCRIPTION, label: "Қосымша түсініктеме", required: false },
    ],
  },
  {
    id: "payment-transfer",
    emoji: "🔁",
    title: "Басқа аккаунтқа төлем ауыстыру",
    hint: "Төлем басқа аккаунтта тұр",
    fields: [
      ...contactChoiceFields({
        prefix: "from",
        kindLabel: "Төлем тұрған аккаунт",
        phoneLabel: "Төлем тұрған номер",
        emailLabel: "Төлем тұрған почта",
      }),
      ...contactChoiceFields({
        prefix: "to",
        kindLabel: "Ауыстыру керек аккаунт",
        phoneLabel: "Ауыстыру керек номер",
        emailLabel: "Ауыстыру керек почта",
      }),
      { ...SCREENSHOT, label: "Төлем көрінетін скрин" },
      {
        id: "reason",
        label: "Себебі",
        type: "textarea",
        required: true,
        placeholder: "Неліктен ауыстыру керек",
      },
    ],
  },
  PLATFORM_ERROR_LABEL,
  SUGGESTION_LABEL,
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
  SCORE_LABEL,
  REOPEN_LABEL,
  SUGGESTION_LABEL,
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
  PLATFORM_ERROR_LABEL,
  SUGGESTION_LABEL,
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
    // ЖЖ — жұптыҚ жұмыс. В базе таких обращений девять и все в этой группе,
    // но темы у них разные и требуют разного: «жұбы көрінбейді» — кто именно
    // и на каком уроке, «жұптарды ауыстыру керек» — кого с кем пересадить.
    // Одно поле «описание» это не собирало — кезекші доспрашивал вторым кругом.
    id: "zhzh",
    emoji: "👥",
    title: "ЖЖ (жұптық жұмыс) бойынша мәселе",
    hint: "Жұп көрінбейді, тест ашылмайды, жұпты ауыстыру керек",
    fields: [
      {
        id: "issueKind",
        label: "Не болды?",
        type: "select",
        required: true,
        options: [
          { value: "pairs-not-visible", label: "Оқушыға жұбы көрінбейді" },
          { value: "test-error", label: "ЖЖ тесті ашылмайды / аяқталмайды" },
          { value: "change-pairs", label: "Жұпты ауыстыру / алып тастау керек" },
          { value: "lesson-type", label: "Сабақ типінде «Жұптық жұмыс» жоқ" },
          { value: "other", label: "Басқа" },
        ],
      },
      LESSON_LINK,
      {
        // Пара — это всегда два куратора: своих учеников в ЖЖ сводят они, и
        // дежурному нужно знать обоих, иначе половину пары не найти.
        id: "curatorEmail",
        label: "Кураторлардың поштасы",
        type: "email",
        required: true,
        repeatable: true,
        hint: "Жұптағы оқушылардың кураторларын жазыңыз",
        showIf: {
          field: "issueKind",
          equals: ["pairs-not-visible", "test-error", "change-pairs"],
        },
      },
      {
        // Не email, а текст: ученика в ЖЖ зовут по имени («Айдана мен
        // Нұрсұлтан»), почта есть не всегда под рукой, а поле для почты имя
        // вписать не даст вовсе.
        id: "studentContact",
        label: "Оқушының аты немесе поштасы",
        type: "text",
        required: true,
        repeatable: true,
        placeholder: "Айдана немесе student@gmail.com",
        hint: "Жұптың екі оқушысын да жазыңыз",
        showIf: {
          field: "issueKind",
          equals: ["pairs-not-visible", "test-error", "change-pairs"],
        },
      },
      {
        id: "pairChange",
        label: "Кімді кіммен жұптау керек?",
        type: "textarea",
        required: true,
        placeholder: "Айдана мен Нұрсұлтанды жұптау, Асылды алып тастау",
        showIf: { field: "issueKind", equals: ["change-pairs"] },
      },
      { ...SCREENSHOT, label: "Жұптар бөлімінің скріні" },
      { ...DESCRIPTION, label: "Толықтай сипаттама" },
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
  LOGIN_LABEL,
  REOPEN_LABEL,
  PLATFORM_ERROR_LABEL,
  SCORE_LABEL,
  SUGGESTION_LABEL,
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

// Заполненные поля парами «подпись — значение»: ими карточка объясняет
// дежурному, что есть что. Без подписей два номера в обращении о смене
// выглядят одинаково, и непонятно, какой из них менять на какой.
// Скриншоты сюда не попадают — они и так на карточке миниатюрами.
export function describeFields(
  label: SubmissionLabel,
  values: Record<string, string | string[]>
): Array<{ label: string; value: string; service: boolean }> {
  const out: Array<{ label: string; value: string; service: boolean }> = [];
  for (const field of label.fields) {
    if (field.type === "photos") continue;
    if (!fieldVisible(field, values)) continue;
    const raw = values[field.id];
    if (raw === undefined) continue;
    const text = displayValue(field, raw).trim();
    if (!text) continue;
    out.push({ label: field.label, value: text, service: Boolean(field.service) });
  }
  return out;
}

// То же самое текстом — для rawText заявки и подсказок карточки.
export function buildDetails(
  label: SubmissionLabel,
  values: Record<string, string | string[]>
): string {
  return [
    label.title,
    ...describeFields(label, values).map((f) => `${f.label}: ${f.value}`),
  ].join("\n");
}

// Контакт ученика и ссылка на урок нужны отдельно: по ним считаются зацепки
// карточки и работают платформенные кнопки. У каждого ярлыка они называются
// по-своему, поэтому забираем первое подходящее поле, а не одно фиксированное.
const CONTACT_FIELDS = [
  "studentEmail",
  "studentContact",
  "studentPhone",
  "newPhone",
  "newEmail",
  "oldPhone",
  "oldEmail",
  "oldContact",
  "parentEmail",
  "curatorEmail",
  "phone",
  "email",
];

export function extractContact(values: Record<string, string | string[]>): string {
  for (const id of CONTACT_FIELDS) {
    const value = values[id];
    // Повторяемое поле (у ЖЖ это оба ученика пары) приходит массивом: для
    // подсказки на карточке берём первый — остальные видны в описании.
    const first = Array.isArray(value) ? value.find((v) => v.trim()) : value;
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  return "";
}

export function extractLessonLink(values: Record<string, string | string[]>): string {
  const value = values["lessonLink"];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.filter((v) => v.trim()).join(" · ");
  return "";
}
