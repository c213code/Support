import { normalizeKzPhone } from "./phone";

export type ParentAccount = {
  id: string;
  name: string;
  login: string;
  phoneNumber: string | null;
  students: Array<{ id: string; name: string; login: string; phoneNumber: string | null }>;
};

export type ParentLookup = {
  query: string;
  parents: Array<ParentAccount & { matchedStudentIds: string[] }>;
  notes: string[];
};

export type ParentCredentials = {
  login: string;
  password: string;
  phoneNumber: string | null;
  message: string;
};

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ParentAccessError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = "ParentAccessError"; }
}

export function parentPhone(value: string): string | null {
  return normalizeKzPhone(value.replace(/[‘’'`.]/g, ""));
}

export function parentSearchQueries(value: string): string[] {
  const phone = parentPhone(value);
  return phone ? [phone, phone.slice(2)] : [value.trim()];
}

export function parentContactMatches(value: string, user: { login: string; phoneNumber: string | null; googleMail?: string | null }): boolean {
  const phone = parentPhone(value);
  if (phone) return parentPhone(user.phoneNumber ?? "") === phone;
  if (value.includes("@")) return user.login.toLowerCase() === value.toLowerCase() ||
    user.googleMail?.toLowerCase() === value.toLowerCase();
  // Names require an explicit account selection; never infer a unique identity from a substring.
  return true;
}

export function parentContacts(text: string, allowName = true): string[] {
  const contacts: string[] = [];
  for (const match of text.matchAll(/[^\s<>()[\],;:]+@[^\s<>()[\],;:]+\.[^\s<>()[\],;:]+/g)) {
    contacts.push(match[0].replace(/[.!?]+$/, "").toLowerCase());
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}@])(?:\+?[78][\s()‘’'`.-]*)?7(?:[\s()‘’'`.-]*\d){9}(?![\p{L}\p{N}@])/gu)) {
    const phone = parentPhone(match[0].replace(/\./g, ""));
    if (phone) contacts.push(phone);
  }
  if (!contacts.length && allowName && !text.includes("\n") && text.trim().length >= 3 &&
    text.trim().length <= 100 && /^[\p{L}\s-]+$/u.test(text.trim()) && !isParentAccessRequest(text)) {
    contacts.push(text.trim());
  }
  return [...new Set(contacts)];
}

export function isParentAccessRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  const parent = /ата[\s-]*ана|родител|(?:^|[\s(])[аa][аa](?:$|[\s).,:])|parent-login/.test(normalized);
  return parent && /кір|логин|пароль|тіркел|вход|войти|аккаунт|кабинет|регистрац/.test(normalized);
}

export function parentReply(result: ParentCredentials): string {
  return ["Ата-ана кабинетіне кіру деректері:", `Логин: ${result.login}`,
    ...(result.phoneNumber ? [`Телефон арқылы да кіре аласыз: ${result.phoneNumber}`] : []),
    `Пароль: ${result.password}`].join("\n");
}
