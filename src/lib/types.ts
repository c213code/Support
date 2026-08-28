export type { IssueStatus } from "@/lib/status";
import type { IssueStatus } from "@/lib/status";

// Ответ, который бот отправил в рабочую группу по тикету (см.
// src/lib/botReply.ts). Приезжает вместе со списком тикетов, чтобы на
// карточке было видно, что уже сказано коллегам.
export type BotReplyDTO = {
  id: string;
  issueId: string;
  chatId: string;
  messageId: number;
  kind: string;
  text: string;
  deleted: boolean;
  sentAt: string;
};

export type IssueDTO = {
  id: string;
  reportDate: string;
  groupName: string;
  groupEmoji: string | null;
  position: number;
  description: string;
  telegramLink: string | null;
  extraLinks: string[];
  status: IssueStatus;
  note: string | null;
  ticketLink: string | null;
  escalatedTeam: string | null;
  escalatedAssignee: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Когда статус менялся в последний раз — им меряется "сколько тикет
  // висит". Не updatedAt: тот сдвигается от любой правки текста.
  statusChangedAt: string;
  botReplies?: BotReplyDTO[];
  // Почта/телефон/вложение из исходных сообщений — только для карточки,
  // в текст репорта не попадают (см. src/lib/ticketHints.ts).
  hints?: { emails: string[]; phones: string[]; hasAttachment: boolean };
};

export type GroupPresetDTO = {
  id: string;
  name: string;
  emoji: string | null;
  order: number;
  chatId?: string | null;
};

export type TelegramMessageDTO = {
  id: string;
  chatId: string;
  messageId: number;
  chatTitle: string | null;
  groupName: string | null;
  groupEmoji: string | null;
  authorName: string | null;
  text: string | null;
  messageLink: string;
  archived: boolean;
  viewed: boolean;
  usedForIssueId: string | null;
  receivedAt: string;
};
