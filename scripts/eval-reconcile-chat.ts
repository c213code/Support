// Read-only semantic smoke evaluation against the configured provider.
// Uses synthetic tickets; does not create runs, update tickets or notify anyone.
// npx tsx --env-file=.env scripts/eval-reconcile-chat.ts
import { reconcileIssue, type ReconcileStatus } from "../src/lib/dayReconcile";
import { reconcileProvider } from "../src/lib/reconcileRun";
import { prisma } from "../src/lib/prisma";

const cases: { name: string; description: string; instructions: string[]; expected: ReconcileStatus }[] = [
  { name: "Короткое подтверждение", description: "Мини-тест ашылмай тұр", instructions: ["мини тест решен"], expected: "RESOLVED" },
  { name: "Казахское подтверждение", description: "Не открывается мини-тест", instructions: ["Мини тест мәселесі түзелді"], expected: "RESOLVED" },
  { name: "Другой тип теста", description: "ҰБТ нәтижесін өшіру керек", instructions: ["мини тест решен"], expected: "UNCLEAR" },
  { name: "Индивидуальный запрос", description: "Сбросьте результат мини-теста ученику, нужна ещё попытка", instructions: ["Сбой мини-тестов исправлен"], expected: "UNCLEAR" },
  { name: "Отрицание", description: "Мини-тест не открывается", instructions: ["мини тест ещё не решён"], expected: "UNCLEAR" },
  { name: "Вопрос", description: "Мини-тест не открывается", instructions: ["мини тест решён?"], expected: "UNCLEAR" },
  { name: "Уточнение-исключение", description: "Не открывается мини-тест по математике", instructions: ["Все мини-тесты исправлены", "Кроме математики"], expected: "UNCLEAR" },
  { name: "Задание после теоретического урока", description: "Теориялық сабақ көрілген, бірақ тапсырма ашылмай тұр\nГруппа: Әдістеме & IT", instructions: ["мини тест решен, найди все связанные и сделай статус решено"], expected: "RESOLVED" },
  { name: "Домашнее задание после урока", description: "Не загружается файл домашнего задания после урока\nГруппа: Әдістеме & IT", instructions: ["мини тест решен, найди все связанные и сделай статус решено"], expected: "UNCLEAR" },
  { name: "Индивидуальная попытка после урока", description: "После теоретического урока ученику нужно открыть дополнительную попытку мини-теста", instructions: ["мини тест решен, найди все связанные и сделай статус решено"], expected: "UNCLEAR" },
];

async function main() {
  let failures = 0;
  const provider = reconcileProvider();
  const filter = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
  const selected = filter ? cases.filter((item) => item.name.includes(filter)) : cases;
  if (selected.length === 0) throw new Error("No matching evaluation cases");
  console.log(`Provider: ${provider.kind}:${provider.model}`);
  for (const item of selected) {
    const result = await reconcileIssue(provider, item.description, [], [], [], item.instructions);
    const actual = result.ok ? result.verdict.status : "ERROR";
    const passed = actual === item.expected;
    if (!passed) failures++;
    console.log(`${passed ? "PASS" : "FAIL"} ${item.name}: ${actual} (expected ${item.expected})`);
    if (!passed) console.log(result.ok ? result.verdict.reason : result.error);
    // Pace sequential calls to stay within the per-minute token quota.
    if (provider.kind === "groq" && item !== selected[selected.length - 1]) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  console.log(`${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
