import { prisma } from "@/lib/prisma";
import { similarity } from "@/lib/similarity";
import { shiftDateString, todayDateString } from "@/lib/date";

// "Как мы это решали в прошлый раз" — подсказка по уже закрытым тикетам.
//
// Половина обращений за день это два-три повторяющихся сценария, и заметки
// о решении у них повторяются почти дословно ("Админкамен өшіріп бердік" —
// дважды слово в слово за один день). Печатать это заново каждый раз
// незачем: показываем прошлое решение и даём применить его одним нажатием.
//
// Считаем Жаккаром (src/lib/similarity.ts), а не ИИ: мгновенно, бесплатно
// и не зависит от квоты — а главное, подсказка всё равно ничего не решает
// сама, применяет её человек.

// Порог выше, чем у подсказки при склейке обращений
// (SIMILARITY_HINT_THRESHOLD = 0.34): там предлагают посмотреть глазами, а
// тут — подставить готовый текст в репорт, и ошибиться дороже.
const SOLUTION_THRESHOLD = 0.45;
// Сколько дней истории смотрим. Месяц — компромисс: платформа меняется, и
// решение полугодовой давности может быть уже неверным.
const HISTORY_DAYS = 30;
// Ограничение на выборку — на случай, если тикетов за месяц накопится
// очень много: считаем похожесть в памяти, и гонять десятки тысяч строк
// незачем.
const MAX_CANDIDATES = 500;

export type SolutionSuggestion = {
  issueId: string;
  description: string;
  note: string;
  reportDate: string;
  score: number;
};

export async function findSimilarResolved(
  issue: { id: string; description: string },
  limit = 3
): Promise<SolutionSuggestion[]> {
  const since = shiftDateString(todayDateString(), -HISTORY_DAYS);

  const candidates = await prisma.issue.findMany({
    where: {
      id: { not: issue.id },
      status: "RESOLVED",
      reportDate: { gte: since },
      // Без заметки подсказывать нечего — именно она и есть решение.
      note: { not: null },
    },
    orderBy: { reportDate: "desc" },
    take: MAX_CANDIDATES,
    select: { id: true, description: true, note: true, reportDate: true },
  });

  return candidates
    .map((candidate) => ({
      issueId: candidate.id,
      description: candidate.description,
      note: (candidate.note ?? "").trim(),
      reportDate: candidate.reportDate,
      score: similarity(issue.description, candidate.description),
    }))
    .filter((s) => s.note.length > 0 && s.score >= SOLUTION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Лучшая подсказка для одного тикета — для кнопки в разборе, где место
// есть только на один вариант.
export async function bestSolution(issue: {
  id: string;
  description: string;
}): Promise<SolutionSuggestion | null> {
  const [best] = await findSimilarResolved(issue, 1);
  return best ?? null;
}
