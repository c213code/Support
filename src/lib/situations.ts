import { greeting, pickLanguage, type ReplyLanguage } from "@/lib/autoReply";

// Каталог ситуаций поддержки — из разбора выгрузки четырёх рабочих групп
// (см. Шаблонные_ответы.md, 42 767 сообщений за окт. 2023 — авг. 2026).
//
// Зачем он вообще нужен. Раньше автоответ знал про обращение ровно одно:
// есть в тексте почта/ссылка/номер или нет. Если нет — просил почту. По
// выгрузке видно, чем это плохо: из 7 020 обращений без идентификатора
// живой агент просит данные только в 22 % случаев. В остальных просить
// нечего — "ПФ жасамай қалды" не про конкретного ученика, правку вопроса
// ищут по ссылке или ай-апте, а на предложение функции почта не нужна
// вовсе. То есть бот переспрашивал примерно втрое чаще, чем следовало.
//
// Здесь ситуация решает две вещи сразу:
//   1. каким обещанием ответить (обещание зеркалит просьбу: "өзгертілгенде
//      кб береміз" на правку, "ашылғанда кб береміз" на доступ);
//   2. чего не хватает, чтобы взяться за работу, — и просим мы ровно это,
//      а не почту по умолчанию.
//
// Тексты не сочинялись: и обещания, и просьбы взяты из настоящей переписки
// Ероша и Алпы. Само определение ситуации делает модель (classifySituation
// в lib/ai.ts), но выбор слов остаётся здесь, в коде, — модель решает
// "что за случай", а не "как это сказать".

// Обещание обратной связи. Восемь форм вместо одной — самое дешёвое
// приближение к живой речи: в корпусе "кб бер*" встречается 570 раз, и
// формулировка почти всегда повторяет глагол просьбы.
export type PromiseId =
  | "p_generic"
  | "p_change"
  | "p_swap"
  | "p_add"
  | "p_open"
  | "p_solve"
  | "p_escalate"
  | "p_think";

// "кб" (кері байланыс) намеренно не разворачивается — именно так пишут в
// этих чатах, и развёрнутая форма сразу выдаёт в боте систему.
const PROMISE: Record<PromiseId, Record<ReplyLanguage, string>> = {
  p_generic: {
    kk: "жақсы, қарап кб беретін боламыз",
    ru: "хорошо, посмотрим и дадим обратную связь",
  },
  p_change: {
    kk: "жақсы, өзгертілгенде кб беретін боламыз",
    ru: "хорошо, как изменим — дадим обратную связь",
  },
  p_swap: {
    kk: "жақсы, ауыстырылғанда кб береміз",
    ru: "хорошо, как заменим — дадим обратную связь",
  },
  p_add: {
    kk: "жақсы, қосылғанда кб береміз",
    ru: "хорошо, как подключим — дадим обратную связь",
  },
  p_open: {
    kk: "жақсы, ашылғанда кб береміз",
    ru: "хорошо, как откроем — дадим обратную связь",
  },
  p_solve: {
    kk: "жақсы, мәселе шешімі табылғанда кб беретін боламыз",
    ru: "хорошо, как найдём решение — дадим обратную связь",
  },
  p_escalate: {
    kk: "жақсы, әріптестерімнен сұрап кб беретін боламын",
    ru: "хорошо, спрошу у коллег и дам обратную связь",
  },
  // Единственное обещание, которое не начинается с "жақсы": на предложение
  // отвечают благодарностью, а не согласием посмотреть поломку.
  p_think: {
    kk: "Ұсыныс үшін рақмет, ойланып көреміз",
    ru: "Спасибо за предложение, подумаем",
  },
};

// Чего может не хватать. Готовых фраз-просьб у агентов нет: из 1 175
// ответов с просьбой почти нет дословных повторов, зато набор запрашиваемых
// вещей устойчив. Поэтому просьба собирается из слотов, а не выбирается из
// списка заготовок.
export type SlotId =
  | "email"
  | "full_name"
  | "contact"
  | "parent_phone"
  | "student_phone"
  | "link"
  | "week"
  | "account"
  | "question_number"
  | "screenshot"
  | "app_version"
  | "order_file"
  | "new_value"
  | "from_to"
  | "proof";

const SLOT: Record<SlotId, Record<ReplyLanguage, string>> = {
  email: { kk: "оқушының почтасын", ru: "почту ученика" },
  // В Сату ученика опознают по имени, а не по почте: почта бывает
  // родительская или с опечаткой. Реальный ответ на голую почту —
  // "бұндай почта жоқ екен, аты-жөні керек".
  full_name: { kk: "оқушының аты-жөнін", ru: "ФИО ученика" },
  contact: { kk: "оқушының почтасын не нөмірін", ru: "почту или номер ученика" },
  parent_phone: { kk: "ата-ананың нөмірін", ru: "номер родителя" },
  student_phone: { kk: "оқушының нөмірін", ru: "номер ученика" },
  link: { kk: "сілтемені", ru: "ссылку" },
  // "ай-апта" (месяц + неделя, напр. "1 ай 3 апта") — как внутри
  // обозначают секцию программы, когда прямой ссылки нет.
  week: { kk: "ай-аптаны", ru: "ай-апту (месяц и неделю)" },
  account: { kk: "осылай шығып тұрған аккаунтты", ru: "аккаунт, на котором это видно" },
  question_number: { kk: "нұсқа мен сұрақ нөмірін", ru: "номер варианта и вопроса" },
  screenshot: { kk: "скрин", ru: "скриншот" },
  app_version: { kk: "қосымшаның версиясын", ru: "версию приложения" },
  order_file: { kk: "дұрыс реттіліктегі файлды", ru: "файл с правильным порядком" },
  new_value: { kk: "жаңа мәнін", ru: "новое значение" },
  from_to: { kk: "қай пәннен қай пәнге ауыстыру керектігін", ru: "с какого предмета на какой" },
  proof: { kk: "дәлелді", ru: "подтверждение" },
};

export type SituationId =
  | "content_edit"
  | "test_behavior"
  | "feature_request"
  | "how_to"
  | "access_grant"
  | "registration"
  | "subject_swap"
  | "sales_form"
  | "account_access"
  | "progress_lost"
  | "parent_account"
  | "parent_email_clash"
  | "platform_down"
  | "mobile_app"
  | "live_lesson"
  | "external_service"
  | "refund";

type Situation = {
  promise: PromiseId;
  // Уточнение обещания по тексту обращения. Обещание зеркалит просьбу, а
  // просьба внутри одной ситуации бывает разной: "оплатил, доступа нет" —
  // это "ашылғанда кб береміз", а "второй предмет подключите" — уже
  // "қосылғанда". Разница слышна в глаголе, поэтому её ловит регулярка, а
  // не модель: лишний повод сходить в Groq тут не нужен.
  refine?: (text: string) => PromiseId | null;
  // Что имеет смысл просить в этой ситуации. Слот попадёт в ответ, только
  // если модель отметила его отсутствующим И его не видно в тексте
  // (см. buildSituationAck): список задаёт потолок, а не обязанность.
  slots: SlotId[];
  // Готовый ответ вместо "обещание + просьба" — там, где ответ известен
  // заранее и обещать нечего.
  answer?: Record<ReplyLanguage, string>;
};

export const SITUATIONS: Record<SituationId, Situation> = {
  // Блок A — контент и задания, почти весь Әдістеме & IT.
  content_edit: { promise: "p_change", slots: ["link", "week", "question_number"] },
  test_behavior: { promise: "p_solve", slots: ["account", "link", "week", "order_file"] },
  // Не поломка: функции просто нет или она работает как задумано. Принять
  // это за баг — значит завести тикет с неверным приоритетом и закрыть его
  // потом как "не воспроизводится".
  feature_request: { promise: "p_think", slots: [] },
  // Спрашивают не о поломке, а о способе. Обещать починку нечего —
  // отвечает человек.
  how_to: { promise: "p_generic", slots: [] },

  // Блок B — ученик, доступ, аккаунты. Почти весь Сату и Сервис.
  access_grant: {
    promise: "p_open",
    slots: ["full_name", "contact"],
    refine: (text) => (/қос(ып|у|ыл)/i.test(text) ? "p_add" : null),
  },
  registration: { promise: "p_swap", slots: ["full_name", "new_value"] },
  subject_swap: { promise: "p_swap", slots: ["full_name", "from_to"] },
  // Анкета нового ученика: заявка на регистрацию, а не жалоба. Всё нужное
  // в ней уже есть — просить нечего.
  sales_form: { promise: "p_open", slots: [] },
  account_access: { promise: "p_solve", slots: ["contact"] },
  progress_lost: { promise: "p_solve", slots: ["email", "week"] },
  // АА = ата-ана, родители (в автословаре это записано неверно). Просить
  // нужно ОБА номера сразу — иначе гарантирован второй круг переписки.
  parent_account: {
    promise: "p_solve",
    slots: ["parent_phone", "student_phone"],
    // Оба номера названы явно — значит правка механическая ("номера
    // перепутаны местами"), и обещать поиск решения неправильно: чинить
    // тут нечего, надо просто поменять.
    refine: (text) =>
      (text.match(/\+?\d[\d\-\t ()]{7,}\d/g) ?? []).length >= 2 ? "p_swap" : null,
  },
  // Главная причина АА-обращений, и она не требует тикета: ученик вписал
  // свою же почту в поле родителя, а аккаунт родителя создаётся
  // автоматически — две учётки на одну почту не встают, регистрация
  // падает. Ответ известен заранее.
  parent_email_clash: {
    promise: "p_solve",
    slots: [],
    answer: {
      kk: "оқушының почтасы мен ата-ана почтасы бірдей болып тұр, сондықтан осылай шығып жатыр. Ата-ана почтасын басқасын енгізсін",
      ru: "почта ученика и почта родителя совпадают — поэтому и выходит эта ошибка. Пусть родитель укажет другую почту",
    },
  },

  // Блок C — платформа и внешние сервисы.
  // Только "посмотрим". Формулировка "ПФ-да жөңдеу жұмыстары болып жатыр"
  // (ведём работы) в переписке есть, но она УТВЕРЖДАЕТ факт — а бот на
  // момент ответа не знает, лежит платформа или у одного человека не
  // грузится страница. Сообщить о работах, которых нет, хуже, чем ответить
  // общо: это же правило, по которому "решено" уходит только по кнопке
  // человека.
  platform_down: { promise: "p_generic", slots: [] },
  mobile_app: {
    promise: "p_generic",
    slots: [],
    answer: {
      kk: "қосымшаның соңғы версиясы жүктелген бе біле аласыз ба? Соңғы версияда қосымша тұрақты жұмыс жасап тұр",
      ru: "проверьте, пожалуйста, установлена ли последняя версия приложения — на ней всё работает стабильно",
    },
  },
  live_lesson: { promise: "p_solve", slots: ["account", "proof"] },
  // Чиним не мы — честная эскалация без обещания сроков.
  external_service: { promise: "p_escalate", slots: ["screenshot"] },
  // Возвраты ведёт отдельная группа; от IT нужно только удалить ученика.
  refund: { promise: "p_escalate", slots: [] },
};

export function isSituationId(value: unknown): value is SituationId {
  return typeof value === "string" && value in SITUATIONS;
}

export function isSlotId(value: unknown): value is SlotId {
  return typeof value === "string" && value in SLOT;
}

// Что уже видно в тексте регуляркой. Нужно как страховка от модели: она
// иногда отмечает недостающим то, что человек прислал прямо в сообщении, а
// переспросить присланное — худший вид автоответа.
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const URL = /https?:\/\/\S+/i;
const PHONE = /\+?\d[\d\-\t ()]{7,}\d/;
// "1 ай 3 апта", "2-ай 3-апта" — обозначение секции программы.
const WEEK = /\d\s*-?\s*ай|\d\s*-?\s*апта/i;

function alreadyPresent(slot: SlotId, text: string): boolean {
  switch (slot) {
    case "email":
      return EMAIL.test(text);
    case "contact":
      return EMAIL.test(text) || PHONE.test(text);
    case "parent_phone":
    case "student_phone":
      // Оба номера просим вместе, поэтому и снимаем просьбу только когда в
      // сообщении их правда два.
      return (text.match(new RegExp(PHONE, "g")) ?? []).length >= 2;
    case "link":
      return URL.test(text);
    case "week":
      return WEEK.test(text) || URL.test(text);
    case "screenshot":
      return /\[(фото|photo|сурет|скрин)/i.test(text);
    // full_name, from_to, new_value, account, question_number, proof,
    // app_version, order_file — регуляркой не опознать, полагаемся на модель.
    default:
      return false;
  }
}

// Сколько слотов просим за раз. Три требования в одном сообщении читаются
// как анкета, а не как вопрос коллеги; в переписке агенты просят одно, реже
// два.
const MAX_SLOTS = 2;

// Модель называет слот точнее или общее, чем ситуация его допускает:
// говорит "email", когда ситуация просит "contact" (почту ИЛИ номер), или
// наоборот. Без приведения такой слот отсеивался как посторонний, и бот
// молча не просил ничего — то есть ошибка модели в сторону точности
// оборачивалась потерей просьбы целиком.
const EQUIVALENT: Partial<Record<SlotId, SlotId[]>> = {
  contact: ["email", "student_phone"],
  email: ["contact"],
};

function toAllowedSlot(slot: SlotId, allowed: SlotId[]): SlotId | null {
  if (allowed.includes(slot)) return slot;
  const target = allowed.find((candidate) =>
    EQUIVALENT[candidate]?.includes(slot)
  );
  return target ?? null;
}

export function missingSlotsFor(
  situation: SituationId,
  modelMissing: SlotId[],
  text: string
): SlotId[] {
  const allowed = SITUATIONS[situation].slots;
  return Array.from(
    new Set(
      modelMissing
        .map((slot) => toAllowedSlot(slot, allowed))
        .filter((slot): slot is SlotId => slot !== null)
    )
  )
    .filter((slot) => !alreadyPresent(slot, text))
    .slice(0, MAX_SLOTS);
}

export function buildSituationAck(
  incomingText: string,
  situation: SituationId,
  missing: SlotId[],
  now: Date = new Date()
): string {
  const language = pickLanguage(incomingText);
  const meta = SITUATIONS[situation];
  const hello = greeting(language, now);

  // Готовый ответ по существу вытесняет и обещание, и просьбу: обещать
  // обратную связь там, где ответ уже дан, — лишнее сообщение.
  if (meta.answer) return `${hello}, ${meta.answer[language]}`;

  const promiseId = meta.refine?.(incomingText) ?? meta.promise;
  const base = `${hello}, ${PROMISE[promiseId][language]}`;
  if (missing.length === 0) return base;

  const list = missing.map((slot) => SLOT[slot][language]).join(
    language === "kk" ? " және " : " и "
  );
  const ask =
    language === "kk"
      ? `Тексеру үшін ${list} жібере аласыз ба?`
      : `Чтобы проверить — пришлите, пожалуйста, ${list}.`;
  return `${base}. ${ask}`;
}
