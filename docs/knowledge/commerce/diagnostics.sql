-- Commerce V2: только чтение через локальный read-only MCP или вручную дежурным.
-- Q00–Q06 не выполнялись на данных ученика при подготовке первого пакета.
-- Q07 добавлен по кейсу замены/невидимого курса; сначала Q00, затем нужный SELECT.
-- 09.10.2026: после обновления интроспекции DataGrip таблицы Q01–Q06
-- обнаружены в juz40.public, а используемые колонки сверены.
-- Наличие таблиц не подтверждает, что конкретная фича включена в production.
-- :schema_name обычно public, но подтвердить окружение. :mail — точное значение аккаунта.
-- Именованные параметры привязывает SQL-клиент. Не вставлять непроверенный текст конкатенацией.
-- Таблицы Q01–Q06 намеренно schema-qualified public; при другой схеме дежурный
-- должен явно заменить public на подтверждённый идентификатор схемы во всех ссылках.
-- Удалённые записи показаны флагом deleted для диагностики, а не считаются действующими.

-- Q00: проверить наличие всех таблиц. missing не означает отсутствие кейса:
-- проверить окружение, схему и миграцию, затем остановить этот SQL-путь.
WITH expected(table_name) AS (
  VALUES ('users'), ('payment_histories'), ('payment_allocations'), ('student_credits'),
         ('commerce_requests'), ('commerce_request_payments'), ('streams'),
         ('groups'), ('groups_students')
)
SELECT e.table_name, (t.table_name IS NOT NULL) AS present
FROM expected e
LEFT JOIN information_schema.tables t
  ON t.table_schema = :schema_name AND t.table_name = e.table_name
ORDER BY e.table_name;

-- Q00b: после Q00 проверить типы используемых полей.
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = :schema_name
  AND table_name IN ('users', 'payment_histories', 'payment_allocations', 'student_credits',
                     'commerce_requests', 'commerce_request_payments', 'streams',
                     'groups', 'groups_students')
ORDER BY table_name, ordinal_position
LIMIT 300;

-- Q00c: только перед Q06 проверить дополнительные таблицы/поля.
-- present=false: остановить Q06 и проверить окружение/версию схемы.
WITH expected(table_name, column_name) AS (
  VALUES
    ('student_group_monthly_payments', 'id'),
    ('student_group_monthly_payments', 'payment_history_id'),
    ('student_group_monthly_payments', 'stream_id'),
    ('student_group_monthly_payments', 'payment_date_id'),
    ('student_group_monthly_payments', 'deleted'),
    ('stream_payment_dates', 'id'),
    ('stream_payment_dates', 'billed_year'),
    ('stream_payment_dates', 'billed_month'),
    ('stream_payment_dates', 'deleted'),
    ('streams', 'id'), ('streams', 'name'), ('streams', 'type'),
    ('streams', 'deleted'), ('streams', 'is_course_finished'),
    ('courses', 'stream_id'), ('courses', 'subject_id'),
    ('subjects', 'id'), ('subjects', 'name_ru'), ('subjects', 'type')
)
SELECT e.table_name, e.column_name, c.data_type,
       (c.column_name IS NOT NULL) AS present
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema = :schema_name
 AND c.table_name = e.table_name
 AND c.column_name = e.column_name
ORDER BY e.table_name, e.column_name;

-- Q01: попытки оплаты аккаунта ученика и платежи до привязки аккаунта.
-- Для привязанных платежей ph.mail может быть email родителя/старым email:
-- искать по student_id через users.username. Непривязанные — отдельно по mail.
-- from_date включительно, to_date исключительно; created_at — время создания, не успеха.
-- Не приводить legacy total_price к numeric без проверки формата.
WITH matching_student AS (
  SELECT id FROM public.users WHERE lower(username) = lower(:mail)
), matches AS (
  SELECT ph.id, ph.student_id, ph.status, ph.created_at, ph.payment_date,
         ph.total_price, ph.prepayment_kind, ph.applied_credit, ph.grant_reason,
         ph.deleted, 'linked_student' AS match_kind
  FROM public.payment_histories ph
  JOIN matching_student u ON u.id = ph.student_id
  WHERE ph.created_at >= CAST(:from_date AS timestamp)
    AND ph.created_at < CAST(:to_date AS timestamp)
  UNION ALL
  SELECT ph.id, ph.student_id, ph.status, ph.created_at, ph.payment_date,
         ph.total_price, ph.prepayment_kind, ph.applied_credit, ph.grant_reason,
         ph.deleted, 'unlinked_mail' AS match_kind
  FROM public.payment_histories ph
  WHERE ph.student_id IS NULL AND lower(ph.mail) = lower(:mail)
    AND ph.created_at >= CAST(:from_date AS timestamp)
    AND ph.created_at < CAST(:to_date AS timestamp)
)
SELECT id, student_id, status, created_at, payment_date, total_price,
       prepayment_kind, applied_credit, grant_reason, deleted, match_kind
FROM matches
ORDER BY created_at DESC, id
LIMIT 50;

-- Q02: строки выбранной попытки. CREATED не означает оплаченное.
-- Не использовать результат как готовый расчёт текущего доступа/возврата.
SELECT pa.id, pa.payment_history_id, ph.status,
       (ph.status = 'SUCCESS' AND NOT ph.deleted AND NOT pa.deleted)
         AS counts_as_successful_payment,
       pa.stream_id, pa.subject_id, pa.billed_year, pa.billed_month,
       pa.kind, pa.base, pa.paid, pa.origin,
       pa.deleted AS allocation_deleted, ph.deleted AS payment_deleted
FROM public.payment_allocations pa
JOIN public.payment_histories ph ON ph.id = pa.payment_history_id
WHERE pa.payment_history_id = CAST(:payment_id AS uuid)
ORDER BY pa.created_at, pa.id
LIMIT 100;

-- Q03: кредиты по mail, включая до регистрации и исчерпанные.
-- amount не равен remaining. expires_at сравнивать с бизнес-временем по правилам сервиса.
SELECT id, student_id, type, amount, remaining, created_at, expires_at,
       consumed_at, source_payment_id, source_request_id, consumed_by_payment_id, deleted
FROM public.student_credits
WHERE lower(mail) = lower(:mail)
ORDER BY created_at DESC, id
LIMIT 50;

-- Q04: заявки ученика; ids потоков — CSV, не одна UUID.
-- Причины/произвольные комментарии и персональные данные намеренно не выбираются.
SELECT id, type, status, created_at, decided_at, executed_at,
       cohort_year, cohort_month, billed_year, billed_month,
       remove_stream_ids, add_stream_ids, renew_stream_id, top_up_amount,
       refund_days_mode, refund_manual_days, refund_as_credit, deleted
FROM public.commerce_requests
WHERE student_id = CAST(:student_id AS uuid)
  AND created_at >= CAST(:from_date AS timestamp)
  AND created_at < CAST(:to_date AS timestamp)
ORDER BY created_at DESC, id
LIMIT 50;

-- Q05: попытки доплаты конкретной заявки, включая инвалидированные.
SELECT rp.request_id, rp.payment_history_id, rp.created_at,
       rp.invalidated, rp.invalidated_reason,
       ph.status AS payment_status, ph.payment_date, ph.total_price,
       rp.deleted AS relation_deleted, ph.deleted AS payment_deleted
FROM public.commerce_request_payments rp
JOIN public.payment_histories ph ON ph.id = rp.payment_history_id
WHERE rp.request_id = CAST(:request_id AS uuid)
ORDER BY rp.created_at DESC, rp.id
LIMIT 50;

-- Q06: кандидаты на резерв предмета предоплатой продления за billed-месяц.
-- Параметры :mail, :billed_year, :billed_month. Сначала Q00c.
-- Показаны PROFILE-предметы; deleted-флаги оставлены для разбора аномалий.
-- Не восстанавливает полный состав: оплаченные позиции и текущая корзина отдельно.
SELECT DISTINCT sgmp.id AS monthly_payment_id, ph.id AS payment_history_id,
       ph.status, ph.prepayment_kind, ph.created_at AS payment_created_at,
       pd.billed_year, pd.billed_month,
       s.id AS stream_id, s.name AS stream_name, s.type AS stream_type,
       sub.id AS subject_id, sub.name_ru AS subject_name, sub.type AS subject_type,
       ph.deleted AS payment_deleted, sgmp.deleted AS monthly_payment_deleted,
       pd.deleted AS window_deleted, s.deleted AS stream_deleted,
       s.is_course_finished
FROM public.users u
JOIN public.payment_histories ph ON ph.student_id = u.id
JOIN public.student_group_monthly_payments sgmp ON sgmp.payment_history_id = ph.id
JOIN public.stream_payment_dates pd ON pd.id = sgmp.payment_date_id
JOIN public.streams s ON s.id = sgmp.stream_id
JOIN public.courses c ON c.stream_id = s.id
JOIN public.subjects sub ON sub.id = c.subject_id
WHERE lower(u.username) = lower(:mail)
  AND ph.status = 'SUCCESS'
  AND ph.old_payment_history_id IS NULL
  AND ph.prepayment_kind = 'RENEWAL'
  AND pd.billed_year = CAST(:billed_year AS integer)
  AND pd.billed_month = CAST(:billed_month AS integer)
  AND sub.type = 'PROFILE'
  AND s.type IN ('SMART', 'JUNIOR', 'TURBO', 'JUNIOR_PRO')
ORDER BY payment_created_at DESC, payment_history_id, monthly_payment_id
LIMIT 100;

-- Q07: живые оплаченные позиции ученика и доступность группы по каждому потоку.
-- :mail — username ученика; :from_year и :from_month — первый интересующий billed-месяц.
-- group_count=0 означает, что нет активной группы для потока; active_memberships=0 — ученик не посажен.
-- Это не ответ /replace-form-data: при споре о форме дополнительно сверить её API-ответ.
WITH student AS (
  SELECT id FROM public.users WHERE lower(username) = lower(:mail)
), paid AS (
  SELECT pa.stream_id, pa.billed_year, pa.billed_month, SUM(pa.paid) AS paid_sum
  FROM public.payment_allocations pa
  JOIN public.payment_histories ph ON ph.id = pa.payment_history_id
  JOIN student u ON u.id = ph.student_id
  WHERE ph.status = 'SUCCESS'
    AND pa.stream_id IS NOT NULL
    AND (pa.billed_year > CAST(:from_year AS integer)
      OR (pa.billed_year = CAST(:from_year AS integer)
        AND pa.billed_month >= CAST(:from_month AS integer)))
    AND pa.kind NOT IN ('FORGIVEN', 'CREDIT')
  GROUP BY pa.stream_id, pa.billed_year, pa.billed_month
  HAVING SUM(pa.paid) > 0
)
SELECT p.stream_id, s.name AS stream_name, p.billed_year, p.billed_month, p.paid_sum,
       (SELECT COUNT(*) FROM public.groups g
        WHERE g.stream_id = p.stream_id AND NOT g.deleted) AS group_count,
       (SELECT COUNT(*) FROM public.groups_students gs
        JOIN public.groups g ON g.id = gs.group_id
        JOIN student u ON u.id = gs.user_id
        WHERE g.stream_id = p.stream_id AND NOT g.deleted
          AND gs.excluded_from_group_time IS NULL) AS active_memberships
FROM paid p
JOIN public.streams s ON s.id = p.stream_id
ORDER BY p.billed_year, p.billed_month, s.name
LIMIT 50;
