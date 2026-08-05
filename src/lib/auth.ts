import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { AGENTS, type Agent } from "@/lib/agents";

export const SESSION_COOKIE_NAME = "support_session";

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
};

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function verifyAgentPassword(agent: string, password: string): agent is Agent {
  if (!AGENTS.includes(agent as Agent)) return false;
  const expected = AGENT_PASSWORDS[agent as Agent];
  if (!expected || !password) return false;
  return timingSafeStringEqual(password, expected);
}

function sign(value: string): string {
  return createHmac("sha256", getSecret()).update(value).digest("hex");
}

// Токен = "<агент>.<hmac(агент)>" — client не может подделать имя агента
// без секрета сервера, но сам агент виден и его удобно читать на сервере
// без похода в базу.
export function createSessionToken(agent: Agent): string {
  return `${agent}.${sign(agent)}`;
}

export function verifySessionToken(token: string | undefined | null): Agent | null {
  if (!token) return null;
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex === -1) return null;

  const agent = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  if (!AGENTS.includes(agent as Agent)) return null;
  if (!timingSafeStringEqual(signature, sign(agent))) return null;

  return agent as Agent;
}

export async function getCurrentAgent(): Promise<Agent | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token);
}
