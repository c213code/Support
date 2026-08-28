-- Уборка перед внешними ключами.
--
-- Раньше связи с Issue держались на голых строках, без ссылочной
-- целостности: удалённый тикет оставлял за собой ответы бота, prompt'ы
-- заметок и сообщения, которые всё ещё считают себя привязанными. Пока
-- ключей нет, такие строки просто мусор; в момент, когда ключ ставится,
-- они ломают саму миграцию — а вместе с ней и деплой.
--
-- Поэтому здесь единственный раз меняются данные: осиротевшие ссылки
-- обнуляются, осиротевшие строки удаляются. Ровно то, что с этого момента
-- будет делать сама база.
UPDATE "TelegramMessage" SET "usedForIssueId" = NULL
 WHERE "usedForIssueId" IS NOT NULL
   AND "usedForIssueId" NOT IN (SELECT "id" FROM "Issue");

UPDATE "TelegramMessage" SET "agentIssueId" = NULL
 WHERE "agentIssueId" IS NOT NULL
   AND "agentIssueId" NOT IN (SELECT "id" FROM "Issue");

DELETE FROM "BotReply" WHERE "issueId" NOT IN (SELECT "id" FROM "Issue");

DELETE FROM "PendingNotePrompt" WHERE "issueId" NOT IN (SELECT "id" FROM "Issue");

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "IssueEvent" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "from" "IssueStatus",
    "to" "IssueStatus" NOT NULL,
    "actor" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueEvent_issueId_at_idx" ON "IssueEvent"("issueId", "at");

-- CreateIndex
CREATE INDEX "IssueEvent_at_idx" ON "IssueEvent"("at");

-- CreateIndex
CREATE INDEX "TelegramMessage_usedForIssueId_idx" ON "TelegramMessage"("usedForIssueId");

-- CreateIndex
CREATE INDEX "TelegramMessage_agentIssueId_idx" ON "TelegramMessage"("agentIssueId");

-- AddForeignKey
ALTER TABLE "TelegramMessage" ADD CONSTRAINT "TelegramMessage_agentIssueId_fkey" FOREIGN KEY ("agentIssueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramMessage" ADD CONSTRAINT "TelegramMessage_usedForIssueId_fkey" FOREIGN KEY ("usedForIssueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotReply" ADD CONSTRAINT "BotReply_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingNotePrompt" ADD CONSTRAINT "PendingNotePrompt_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueEvent" ADD CONSTRAINT "IssueEvent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Существующим тикетам время смены статуса неоткуда взять точно: истории
-- не было. updatedAt — ближайшее, что есть, и он заведомо не позже
-- настоящей смены. Без этого все тикеты в базе выглядели бы так, будто
-- статус им поменяли в момент деплоя.
UPDATE "Issue" SET "statusChangedAt" = "updatedAt";
