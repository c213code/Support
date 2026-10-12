-- DV-7952: ручные ограниченные SELECT для дежурного. Живая схема не сверена.
-- Сначала Q00/Q00b, правильное окружение и схема. public заменяют только на подтверждённую схему.
-- Параметры связывает клиент: :schema_name, :mail, :student_id, :group_id,
-- :lesson_id, :course_id, :month, :week. ID/неделю брать из проверенного контекста.
-- Пустая/ограниченная выборка не доказывает отсутствие проблемы или разрешённый доступ.

-- Q00: наличие таблиц и выбранное окружение.
WITH expected(table_name) AS (
  VALUES ('users'), ('courses'), ('groups'), ('groups_students'), ('themes'),
         ('lessons'), ('progresses'), ('personal_lessons_modifications'),
         ('personal_lessons_students'), ('curator_theme_modifications')
)
SELECT current_database() AS database_name, e.table_name,
       (t.table_name IS NOT NULL) AS present
FROM expected e
LEFT JOIN information_schema.tables t
  ON t.table_schema = :schema_name AND t.table_name = e.table_name
ORDER BY e.table_name;

-- Q00b: поля и типы, включая массив типов курса и UTC-время прогресса.
SELECT table_schema, table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = :schema_name
  AND table_name IN ('users', 'courses', 'groups', 'groups_students', 'themes',
                    'lessons', 'progresses', 'personal_lessons_modifications',
                    'personal_lessons_students', 'curator_theme_modifications')
ORDER BY table_name, ordinal_position
LIMIT 500;

-- Q01: ID ученика по почте аккаунта; без пароля, токена и профиля.
SELECT id AS student_id, deleted
FROM public.users
WHERE lower(username) = lower(:mail)
ORDER BY id
LIMIT 10;

-- Q02: реальная тема цели и настройки курса; это не полная проверка авторизации.
SELECT l.id AS lesson_id, l.lesson_type, l.rating_task_type, l.parent_id,
       l.is_published, l.deleted AS lesson_deleted, l.is_rating,
       t.id AS resolved_theme_id, t.month, t.week, t.deleted AS theme_deleted,
       c.id AS course_id, c.weekly_theory_gate_enabled,
       c.weekly_theory_gated_rating_task_types, g.course_id AS group_course_id,
       (g.course_id = c.id) AS course_matches_group
FROM public.lessons l
CROSS JOIN public.groups g
LEFT JOIN public.personal_lessons_modifications pl
  ON pl.lesson_id = l.id AND pl.group_id = g.id
 AND EXISTS (SELECT 1 FROM public.personal_lessons_students pls
             WHERE pls.personal_lesson_id = pl.id AND pls.user_id = CAST(:student_id AS uuid))
LEFT JOIN public.curator_theme_modifications ctm
  ON ctm.id = l.curator_theme_modification_id AND ctm.group_id = g.id
JOIN public.themes t ON t.id = coalesce(l.theme_id, pl.theme_id, ctm.theme_id)
JOIN public.courses c ON c.id = t.course_id
WHERE l.id = CAST(:lesson_id AS uuid) AND g.id = CAST(:group_id AS uuid)
ORDER BY t.id
LIMIT 20;

-- Q03: все обязательные общие лекции и итоговые статусы этой группы.
-- Если 100 строк: результат ограничен, нельзя объявлять список полным.
-- Несогласованный дополнительный total-прогресс тоже может блокировать в каноническом предикате.
SELECT prerequisite.id AS theory_lesson_id, prerequisite.is_rating,
       count(p.id) AS active_total_progress_count,
       coalesce(bool_or(p.status = 'SUCCESS'), false) AS has_success,
       bool_or(p.status IS DISTINCT FROM 'SUCCESS') AS blocks_weekly_theory_gate,
       min(p.finish_time) AS first_stored_finish_time
FROM public.themes t
JOIN public.lessons prerequisite ON prerequisite.theme_id = t.id
JOIN public.groups g ON g.course_id = t.course_id AND g.id = CAST(:group_id AS uuid)
LEFT JOIN public.progresses p
  ON p.lesson_id = prerequisite.id AND p.student_id = CAST(:student_id AS uuid)
 AND p.group_id = g.id AND p.is_total_result AND NOT p.deleted
WHERE t.course_id = CAST(:course_id AS uuid)
  AND t.month = CAST(:month AS integer) AND t.week = CAST(:week AS integer)
  AND NOT t.deleted AND prerequisite.parent_id IS NULL
  AND prerequisite.is_published AND NOT prerequisite.deleted
  AND prerequisite.rating_task_type = 'TEORIYALYK_TAPSYRMA'
  AND prerequisite.lesson_type = 'LECTURE'
GROUP BY prerequisite.id, prerequisite.is_rating
ORDER BY prerequisite.id
LIMIT 100;

-- Q04: только канонический weekly-предикат, не open и не весь LessonAccessChecker.
-- Предикат скопирован из WEEKLY_THEORY_LOCKED_QUERY с заменой alias/параметров.
SELECT exists (
    select 1
    from public.lessons l
             left join public.personal_lessons_modifications pl
                       on pl.lesson_id = l.id and pl.group_id = CAST(:group_id AS uuid)
                      and exists (select 1 from public.personal_lessons_students pls
                                  where pls.personal_lesson_id = pl.id and pls.user_id = CAST(:student_id AS uuid))
             left join public.curator_theme_modifications ctm
                       on ctm.id = l.curator_theme_modification_id and ctm.group_id = CAST(:group_id AS uuid)
             join public.themes t on t.id = coalesce(l.theme_id, pl.theme_id, ctm.theme_id)
             join public.courses c on c.id = t.course_id
             join public.groups g on g.course_id = c.id
    where l.id = CAST(:lesson_id AS uuid)
      and g.id = CAST(:group_id AS uuid)
      and c.weekly_theory_gate_enabled
      and l.rating_task_type is not null
      and l.rating_task_type <> 'TEORIYALYK_TAPSYRMA'
      and l.rating_task_type = any(c.weekly_theory_gated_rating_task_types)
      and exists (
        select 1
        from public.themes prerequisite_theme
                 join public.lessons prerequisite on prerequisite.theme_id = prerequisite_theme.id
                 left join public.progresses prerequisite_progress
                           on prerequisite_progress.lesson_id = prerequisite.id
                          and prerequisite_progress.student_id = CAST(:student_id AS uuid)
                          and prerequisite_progress.group_id = CAST(:group_id AS uuid)
                          and prerequisite_progress.is_total_result
                          and not prerequisite_progress.deleted
        where prerequisite_theme.course_id = c.id
          and prerequisite_theme.month = t.month
          and prerequisite_theme.week = t.week
          and not prerequisite_theme.deleted
          and prerequisite.parent_id is null
          and prerequisite.is_published
          and not prerequisite.deleted
          and prerequisite.rating_task_type = 'TEORIYALYK_TAPSYRMA'
          and prerequisite.lesson_type = 'LECTURE'
          and prerequisite_progress.status is distinct from 'SUCCESS'
      )
) AS weekly_theory_locked;

-- Q05: дедлайн лекции, статусы и время; история попыток не подменяет total SUCCESS.
-- finish_time в хранилище UTC; null не является условием замка недели.
SELECT l.id AS lesson_id, l.lesson_type, l.with_deadline, l.deadline,
       l.is_published, l.deleted AS lesson_deleted,
       p.id AS progress_id, p.status, p.is_total_result,
       p.deleted AS progress_deleted, p.video_viewed, p.finish_time, p.updated_at
FROM public.lessons l
LEFT JOIN public.progresses p
  ON p.lesson_id = l.id AND p.student_id = CAST(:student_id AS uuid)
 AND p.group_id = CAST(:group_id AS uuid)
WHERE l.id = CAST(:lesson_id AS uuid) AND l.lesson_type = 'LECTURE'
ORDER BY p.updated_at DESC NULLS LAST, p.id
LIMIT 20;

-- Q07: членство ученика и родительский прогресс цели; не доказывает оплату/старт/практические условия.
SELECT g.id AS group_id, g.course_id,
       (gs.user_id IS NOT NULL) AS membership_present,
       gs.added_to_group_time, gs.excluded_from_group_time,
       l.parent_id, p.id AS parent_progress_id,
       p.status AS parent_progress_status, p.attended_meeting AS parent_attended_meeting
FROM public.groups g
CROSS JOIN public.lessons l
LEFT JOIN public.groups_students gs ON gs.group_id = g.id AND gs.user_id = CAST(:student_id AS uuid)
LEFT JOIN public.progresses p
  ON p.lesson_id = l.parent_id AND p.student_id = CAST(:student_id AS uuid)
 AND p.group_id = g.id AND p.is_total_result AND NOT p.deleted
WHERE g.id = CAST(:group_id AS uuid) AND l.id = CAST(:lesson_id AS uuid)
ORDER BY p.id
LIMIT 20;
