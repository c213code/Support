export type { IssueStatus } from "@/lib/status";
import type { IssueStatus } from "@/lib/status";

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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
