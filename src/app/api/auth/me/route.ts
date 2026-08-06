import { NextResponse } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";

export async function GET() {
  const identity = await getCurrentIdentity();
  return NextResponse.json({
    agent: identity?.agent ?? null,
    name: identity?.name ?? null,
  });
}
