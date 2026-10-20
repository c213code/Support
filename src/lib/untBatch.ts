import { normalizeKzPhone } from "@/lib/phone";
import { mentionsUntTest } from "@/lib/untResetRequest";

export const MAX_UNT_BATCH = 50;
export type BatchStudent = { id: string; name: string; emails: string[]; phones: string[]; source: string; warnings: string[] };
export type BatchAccount = { id: string; firstname: string | null; lastname: string | null; email: string | null; phoneNumber: string | null; googleMail?: string | null };
export type BatchCandidate = { account: BatchAccount; matchedBy: string[] };
export type BatchResolution = { status: "matched" | "choose" | "not_found"; candidates: BatchCandidate[]; reason: string };

const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE = /(?<!\d)(?:\+?7|8)[\s().-]*(?:\d[\s().-]*){10}(?!\d)/g;
const NAME_LABEL = /^(?:аты(?:\s*[-–]?\s*ж[өо]ні)?|фио|имя(?:\s+и\s+фамилия)?|оқушы)\s*[:–-]\s*(.+)$/iu;
const ISSUE_LABEL = /^(?:мәселе|маселе|проблема|вопрос)\s*:/iu;

export function normalizeBatchName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).sort().join(" ");
}

export function parseUntBatch(text: string): { students: BatchStudent[]; warnings: string[] } {
  if (text.length > 30000) throw new Error("Текст слишком длинный — разделите его на несколько пачек");
  const students: BatchStudent[] = [];
  const warnings: string[] = [];
  let current = { name: "", emails: [] as string[], phones: [] as string[], lines: [] as string[] };
  const flush = () => {
    if (current.name || current.emails.length || current.phones.length) {
      students.push({ id: `student-${students.length + 1}`, name: current.name,
        emails: [...new Set(current.emails)], phones: [...new Set(current.phones)], source: current.lines.join("\n"), warnings: [] });
    }
    current = { name: "", emails: [], phones: [], lines: [] };
  };
  for (const original of text.replace(/\u00a0/g, " ").split(/\r?\n/)) {
    const line = original.trim().replace(/^(?:\*\*|__|`)+|(?:\*\*|__|`)+$/g, "").trim();
    if (!line) continue;
    const named = line.match(NAME_LABEL)?.[1]?.trim();
    const emails = [...line.matchAll(EMAIL)].map(m => m[0].toLowerCase());
    const phones = [...line.replace(EMAIL, "").matchAll(PHONE)].map(m => normalizeKzPhone(m[0].replace(/\./g, ""))).filter((p): p is string => Boolean(p));
    const words = line.split(/\s+/);
    const bareName = !emails.length && !phones.length && !mentionsUntTest(line) && words.length >= 2 && words.length <= 4
      && words.every(w => /^\p{Lu}[\p{L}'’\-]+$/u.test(w)) ? line : null;
    const name = named || bareName;
    if ((ISSUE_LABEL.test(line) && (current.name || current.emails.length || current.phones.length))
      || (name && current.name)
      || (!current.name && emails.length && current.emails.length && !name)
      || (!current.name && !current.emails.length && phones.length && current.phones.length && !name)) flush();
    current.lines.push(original.trim());
    if (name) current.name = name;
    current.emails.push(...emails);
    current.phones.push(...phones);
  }
  flush();
  const seen = new Set<string>();
  const unique = students.filter(s => {
    const key = JSON.stringify([normalizeBatchName(s.name), [...s.emails].sort(), [...s.phones].sort()]);
    if (seen.has(key)) { warnings.push("Повторяющаяся запись ученика объединена"); return false; }
    seen.add(key);
    if (s.emails.length > 1 || s.phones.length > 1) s.warnings.push("В записи несколько контактов — проверьте, что они относятся к одному ученику");
    return true;
  });
  if (unique.length > MAX_UNT_BATCH) throw new Error(`За раз можно искать до ${MAX_UNT_BATCH} учеников — разделите список`);
  if (!unique.length) warnings.push("Не удалось выделить учеников. Укажите имя, почту или номер телефона");
  return { students: unique, warnings: [...new Set(warnings)] };
}

// Every supplied contact is checked independently. Never choose between conflicting accounts.
export async function resolveBatchStudent(
  student: BatchStudent,
  lookup: (query: string) => Promise<BatchAccount[]>
): Promise<BatchResolution> {
  const candidates = new Map<string, BatchCandidate>();
  const add = (account: BatchAccount, by: string) => {
    const entry = candidates.get(account.id) ?? { account, matchedBy: [] };
    if (!entry.matchedBy.includes(by)) entry.matchedBy.push(by);
    candidates.set(account.id, entry);
  };
  let unmatchedContact = false;
  for (const email of student.emails) {
    const found = (await lookup(email)).filter(a => [a.email, a.googleMail].some(e => e?.toLowerCase() === email.toLowerCase()));
    if (!found.length) unmatchedContact = true;
    found.forEach(a => add(a, "почта"));
  }
  for (const phone of student.phones) {
    const normalized = normalizeKzPhone(phone);
    if (!normalized) { unmatchedContact = true; continue; }
    let found = (await lookup(normalized)).filter(a => normalizeKzPhone(a.phoneNumber ?? "") === normalized);
    if (!found.length) found = (await lookup(normalized.slice(2))).filter(a => normalizeKzPhone(a.phoneNumber ?? "") === normalized);
    if (!found.length) unmatchedContact = true;
    found.forEach(a => add(a, "телефон"));
  }
  const byContact = [...candidates.values()];
  if (student.name) {
    const confirmed = byContact.length === 1 && !unmatchedContact
      && normalizeBatchName(`${byContact[0].account.lastname ?? ""} ${byContact[0].account.firstname ?? ""}`) === normalizeBatchName(student.name);
    if (confirmed) {
      add(byContact[0].account, "имя");
    } else {
      let found = (await lookup(student.name)).filter(a => normalizeBatchName(`${a.lastname ?? ""} ${a.firstname ?? ""}`) === normalizeBatchName(student.name));
      if (!found.length) found = (await lookup(student.name.split(/\s+/)[0])).filter(a => normalizeBatchName(`${a.lastname ?? ""} ${a.firstname ?? ""}`) === normalizeBatchName(student.name));
      found.forEach(a => add(a, "имя"));
    }
  }

  const list = [...candidates.values()];
  if (!list.length) return { status: "not_found", candidates: [], reason: "Ученик не найден по указанным данным" };
  const account = list[0].account;
  const nameMismatch = student.name && normalizeBatchName(`${account.lastname ?? ""} ${account.firstname ?? ""}`) !== normalizeBatchName(student.name);
  if (list.length > 1 || unmatchedContact || nameMismatch || !byContact.length) {
    return { status: "choose", candidates: list, reason: list.length > 1 ? "Данные указывают на разные аккаунты — выберите нужный" : "Нужна сверка данных — подтвердите аккаунт вручную" };
  }
  return { status: "matched", candidates: list, reason: "Найден по контактам" };
}
