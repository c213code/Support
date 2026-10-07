// Read-only model regression: no ticket mutations or notifications.
// npx tsx --env-file=.env scripts/eval-reconcile-followup.ts
import { reconcileIssue, type ReconcileStatus } from '../src/lib/dayReconcile';
import type { ThreadLine } from '../src/lib/resolutionNote';
import { prisma } from '../src/lib/prisma';

const agent = (text: string): ThreadLine => ({ from: 'agent', text });
const curator = (text: string): ThreadLine => ({ from: 'curator', text });
const payment = [
  agent('қайтіп көресіз бе'), curator('10 000 деп тұр енді'),
  agent('қанша болу керек?'), agent('@<скрыто>'), curator('35000'),
  agent('неге?\nОқушыда Мат Қазан және Инфо Қазан бар болып тұр ғой'),
  curator('3 пәнге төлем жасап қойған ғой, тарих қырқ болған'),
  curator('қазір тек тарихты жалғастыратындықтан, 1 пәнді алып жатыр деп алсақ, 35 000тг'),
  agent('қазанда 2 пәні тұр ғой әлі'), agent('көріңізші'),
];
const description = 'Оқушыда жеңілдік жоқ, бірақ қате сома көрсетіліп тұр';
const cases: { name: string; description: string; thread: ThreadLine[]; expected: ReconcileStatus[] }[] = [
  { name: 'Повторная проверка после спора о сумме', description, thread: payment, expected: ['RESOLVED'] },
  { name: 'Ошибка осталась после проверки', description, thread: [...payment, curator('әлі 10 000 деп тұр, қате сома өзгермеді')], expected: ['IN_PROGRESS', 'PENDING', 'UNCLEAR'] },
  { name: 'Запрос данных до исправления', description, thread: [agent('қанша болу керек? скрин жіберіңізші')], expected: ['PENDING'] },
  { name: 'Обещание после проверки', description, thread: [...payment, agent('соманы ертең емес, қазір түзеп беремін, әлі жасамадым')], expected: ['IN_PROGRESS'] },
  { name: 'Скидка выполнена, рекомендация для будущих оплат', description: '10% жеңілдігін өшіру қажет', thread: [
    agent('өшті тексеріп көре аласыз ба'),
    curator('<телефон>\n1 пән қосып төлем іжберейін десем дұрыс шықпай тұр 15 пайыз жеңілдігі бар оқушы\nТочнее 10125 тг төлеу керек\nҚазанға, басшылықтан рұқсат алдым\nТөлем сілтемесін жасап бере аласыздар ма?'),
    agent('қазір жеңілдігін қосамыз сонда дұрыс шығу керек'),
    agent('енді тексеріп көресіз бе'), curator('Көп рақмет 🫡'),
    agent('қазір тек 1 реттік скидка берілді 15%ға админдарға айтып скидкасын дұрыстап бересізғо а то келесіде тағы солай сумма қате шығып тұрады'),
  ], expected: ['RESOLVED'] },
];

async function main() {
  const model = process.env.RECONCILE_MODEL?.replace(/^openrouter:/, '') || 'xiaomi/mimo-v2.6-pro';
  console.log(`Model: ${model}`);
  let failures = 0;
  const filter = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length);
  const selected = filter ? cases.filter((item) => item.name.includes(filter)) : cases;
  if (!selected.length) throw new Error('No matching evaluation cases');
  for (const item of selected) {
    const result = await reconcileIssue({ kind: 'openrouter', model }, item.description, item.thread);
    const passed = result.ok && item.expected.includes(result.verdict.status);
    if (!passed) failures++;
    console.log(JSON.stringify({ name: item.name, passed, result }));
  }
  console.log(`${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
