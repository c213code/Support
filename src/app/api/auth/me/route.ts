import { NextResponse } from "next/server";
import { getCurrentAgent } from "@/lib/auth";

export async function GET() {
  const agent = await getCurrentAgent();
  return NextResponse.json({ agent });
}
