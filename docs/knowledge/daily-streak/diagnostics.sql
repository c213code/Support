-- Daily Streak: только шаблоны для ручной проверки дежурным.
-- Схема production не подтверждена. Перед любым диагностическим запросом:
-- выбрать правильное окружение, выполнить Q00/Q00b, проверить типы и поля.
-- Параметры связывает SQL-клиент: :schema_name, :mail, :student_id,
-- :from_date (включительно), :to_date (исключительно), :case_date (день Алматы).
-- public заменять только на подтверждённую схему. Не конкатенировать текст кейса.
-- Пустой результат не доказывает баг/пропуск. Deleted-записи показаны отдельно.

-- Q00: наличие таблиц; отсутствует таблица — остановить соответствующий путь.
WITH expected(table_name) AS (
  VALUES ('users'), ('student_streaks'), ('student_streak_days'),
         ('student_streak_waivers'), ('progresses'), ('lessons')
)
SELECT e.table_name, (t.table_name IS NOT NULL) AS present
FROM expected e
LEFT JOIN information_schema.tables t
  ON t.table_schema = :schema_name AND t.table_name = e.table_name
ORDER BY e.table_name;

-- Q00b: поля и типы, в том числе снимок цели; отсутствие поля — проверить миграции.
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = :schema_name
  AND table_name IN ('users', 'student_streaks', 'student_streak_days',
                     'student_streak_waivers', 'progresses', 'lessons')
ORDER BY table_name, ordinal_position
LIMIT 400;

-- Q01: найти ID ученика по почте аккаунта; не выбирать телефон или имя.
SELECT id AS student_id, deleted
FROM public.users
WHERE lower(username) = lower(:mail)
ORDER BY id
LIMIT 10;

-- Q02: хранимые счётчики, не готовый currentStreak из API.
-- LiveStreakReader может вернуть 0 после разрыва даже при положительной колонке.
SELECT id, student_id, current_streak, longest_streak, total_active_days,
       streak_zero_reason, last_closed_date, created_at, updated_at, deleted
FROM public.student_streaks
WHERE student_id = CAST(:student_id AS uuid)
ORDER BY updated_at DESC, id
LIMIT 10;

-- Q03: дневной журнал и снимок цели на ограниченном интервале до 90 дней.
-- MISSED отличается от отсутствующей строки; waived не превращает его в CLOSED.
-- ENT в хранилище соответствует UNT в API. goal_* null допустим у старого CLOSED.
-- Не пересчитывать историю по сегодняшнему пулу уроков. Нет полного JSON с названиями.
SELECT id, date, status, day_closed_by, break_waived, goal_level,
       goal_required, goal_completed, goal_overdue_required,
       goal_overdue_completed, created_at, updated_at, deleted
FROM public.student_streak_days
WHERE student_id = CAST(:student_id AS uuid)
  AND date >= CAST(:from_date AS date)
  AND date < CAST(:to_date AS date)
  AND CAST(:to_date AS date) > CAST(:from_date AS date)
  AND CAST(:to_date AS date) <= CAST(:from_date AS date) + 90
ORDER BY date DESC, id
LIMIT 100;

-- Q04: журнал восстановлений; комментарии с медицинскими деталями не выгружаются.
-- streak_restored_to — длина цепочки ДО разрыва, не итог ответа waive-break.
SELECT id, waived_from, waived_to, waive_reason, streak_restored_to,
       waived_at, waived_by, deleted
FROM public.student_streak_waivers
WHERE student_id = CAST(:student_id AS uuid)
ORDER BY waived_at DESC, id
LIMIT 30;

-- Q05: evidence выполненных уроков за один день Алматы, timestamp-колонки в UTC.
-- Показаны SUCCESS/IN_REVIEW с total-result и finish_time; это не полный расчёт цели.
-- При 100 строках нужен следующий ограниченный фрагмент, не считать выборку итогом.
-- Здесь не восстановлены доступ/родители/назначения и открытые или завершённые ҰБТ.
SELECT p.id AS progress_id, p.lesson_id, p.group_id, p.course_id, p.theme_id,
       p.status, p.finish_time, p.is_total_result,
       l.deadline, l.lesson_type, l.parent_id,
       l.is_published, l.deleted AS lesson_deleted
FROM public.progresses p
JOIN public.lessons l ON l.id = p.lesson_id
WHERE p.student_id = CAST(:student_id AS uuid)
  AND p.is_total_result
  AND p.deleted IS FALSE
  AND p.status IN ('SUCCESS', 'IN_REVIEW')
  AND p.finish_time >= (
    CAST(CAST(:case_date AS date) AS timestamp) AT TIME ZONE 'Asia/Almaty'
  ) AT TIME ZONE 'UTC'
  AND p.finish_time < (
    CAST(CAST(:case_date AS date) + 1 AS timestamp) AT TIME ZONE 'Asia/Almaty'
  ) AT TIME ZONE 'UTC'
ORDER BY p.finish_time, p.id
LIMIT 100;
