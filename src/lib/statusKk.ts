import type { IssueStatus } from "@/lib/status";

// Статусы глазами куратора — на казахском, как вся форма мини-аппа.
//
// Один словарь на два места: уведомление в личку при смене статуса
// (submitterNotify.ts) и список «Менің өтініштерім» в мини-аппе. Куратор
// читает одни и те же слова в обоих — иначе «жұмысқа алынды» в сообщении и
// «өңделуде» в списке выглядели бы как два разных состояния.
//
// notice — фраза для уведомления; null у SENT: это исходный статус, сообщать
// о нём нечего.
export const STATUS_KK: Record<
  IssueStatus,
  { label: string; emoji: string; notice: string | null }
> = {
  SENT: { label: "Жіберілді", emoji: "📨", notice: null },
  IN_PROGRESS: { label: "Жұмыста", emoji: "🔄", notice: "Өтінішіңіз жұмысқа алынды" },
  PENDING: {
    label: "Күтуде",
    emoji: "⏳",
    notice: "Өтінішіңіз күтуде — жаңалық болса, хабарлаймыз",
  },
  ESCALATED: {
    label: "Басқа командада",
    emoji: "⚠️",
    notice: "Өтінішіңіз басқа командаға берілді",
  },
  RESOLVED: { label: "Шешілді", emoji: "✅", notice: "Өтінішіңіз шешілді" },
};
