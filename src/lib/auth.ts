import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "support_session";
export const AGENT_COOKIE_NAME = "support_agent";

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET env variable is not set");
  }
  return secret;
}

export function createSessionToken(): string {
  return createHmac("sha256", getSecret()).update("authenticated").digest("hex");
}

export function isValidSessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const expected = createSessionToken();
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return isValidSessionToken(token);
}
