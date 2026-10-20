// Backlog forum topic supplied by the team. Overrides allow isolated tests.
export const SUGGESTION_SPREADSHEET_URL = "https://docs.google.com/spreadsheets/d/1VCY43GIjOFA_FeFfIWo-k6G6_OortrNe53hfogkPWgQ/edit";

export function suggestionBacklogTarget(labelId: string): { chatId: string; threadId: number } | null {
  if (labelId !== "suggestion" || process.env.SUGGESTION_BACKLOG_ENABLED === "false") return null;
  const chatId = process.env.SUGGESTION_BACKLOG_CHAT_ID?.trim() || "-1001759146038";
  const threadId = Number(process.env.SUGGESTION_BACKLOG_THREAD_ID || "22735");
  if (!/^-\d+$/.test(chatId) || !Number.isSafeInteger(threadId) || threadId <= 0) {
    throw new Error("Invalid suggestion backlog chat/topic configuration");
  }
  return { chatId, threadId };
}
