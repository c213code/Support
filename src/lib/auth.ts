import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { AGENTS, SHARED_AGENT, type Agent } from "@/lib/agents";

export const SESSION_COOKIE_NAME = "support_session";

export type Identity = {
  // Аккаунт, под которым вошли (Ерош / Алпа / Дежурный).
  agent: Agent;
  // Отображаемое имя. Для именных аккаунтов совпадает с agent, для общего
  // "Дежурный" — имя, которое человек ввёл при входе (напр. "Тикош").
  name: string;
};

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET env variable is not set");
  }
  return secret;
}

// Пароль каждого агента — свой env var, вместо одного общего APP_PASSWORD.
const AGENT_PASSWORDS: Record<Agent, string | undefined> = {
  Ерош: process.env.AGENT_EROSH_PASSWORD,
  Алпа: process.env.AGENT_ALPA_PASSWORD,
  Дежурный: process.env.AGENT_DEZHURNY_PASSWORD,
};

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// Чей это пароль. Логином на странице входа теперь служит просто имя
// человека, так что аккаунт выбирает пароль: у Ероша и Алпы он свой, у
// сменных — общий пароль «Дежурного».
//
// Сравниваем со всеми паролями, не выходя на первом совпадении: время
// ответа не должно подсказывать, какой по счёту пароль угадан. Именные
// аккаунты стоят в AGENTS раньше общего, поэтому при совпадении паролей
// (так быть не должно) выигрывает именной.
export function findAgentByPassword(password: string): Agent | null {
  if (!password) return null;
  let found: Agent | null = null;
  for (const agent of AGENTS) {
    const expected = AGENT_PASSWORDS[agent];
    const match = Boolean(expected) && timingSafeStringEqual(password, expected!);
    if (match && found === null) found = agent;
  }
  return found;
}

function sign(value: string): string {
  return createHmac("sha256", getSecret()).update(value).digest("hex");
}

// Нормализуем имя, чтобы в токене не было разделителя "|" и лишних пробелов.
function cleanName(name: string): string {
  return name.replace(/\|/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

// Токен = "<agent>|<name>.<hmac(agent|name)>" — client не может подделать
// ни аккаунт, ни имя без секрета сервера, но и то и другое читается на
// сервере без похода в базу.
export function createSessionToken(agent: Agent, displayName?: string): string {
  const name =
    agent === SHARED_AGENT && displayName ? cleanName(displayName) : agent;
  const payload = `${agent}|${name}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(
  token: string | undefined | null
): Identity | null {
  if (!token) return null;
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex === -1) return null;

  const payload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  if (!timingSafeStringEqual(signature, sign(payload))) return null;

  const [agent, name] = payload.split("|");
  if (!AGENTS.includes(agent as Agent)) return null;

  return { agent: agent as Agent, name: name || agent };
}

export async function getCurrentIdentity(): Promise<Identity | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token);
}
