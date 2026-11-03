\pset tuples_only on
\set alice 'a1111111-1111-1111-1111-111111111111'
\set bob 'b2222222-2222-2222-2222-222222222222'
select id as s_dent from public.medical_specialties where code = 'dentistry' \gset
select id as s_card from public.medical_specialties where code = 'cardiology' \gset

-- ---------------------------------------------------------------- the file: charts made by the patient
select test.as_user(:'alice'::uuid);
select public.create_patient('Specialist Patient', date '1980-05-05', 'male', null, null, null, null, null, null, 'self', true) as pp \gset
insert into public.recalls (patient_id, kind, interval_months, due_on) values (:'pp', 'perio_maintenance', 3, current_date - 5) returning id as rc \gset
-- an old final chart (outside the link's date range) and a recent one (inside it)
select public.perio_exam_save(:'pp', null, '{"exam_date":"2023-06-01","examiner_name":"Dr Old"}', '[{"tooth":16,"pd":[3,3,3,3,3,3]}]', true) as ex_old \gset
select public.perio_exam_save(:'pp', null, jsonb_build_object('exam_date', current_date - 40, 'examiner_name', 'Dr General'),
  '[{"tooth":16,"pd":[4,3,4,3,3,3]}]', true) as ex_gen \gset
-- the patient's own open draft stays private to the account
select public.perio_exam_save(:'pp', null, jsonb_build_object('exam_date', current_date), '[{"tooth":11,"pd":[2,2,2,2,2,2]}]') as ex_draft \gset

-- ---------------------------------------------------------------- the links
-- A: the periodontist (may chart, propose treatment, add visits); the range starts in 2024
select public.share_create(p_patient => :'pp', p_title => 'Periodontist', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_include => array['specialty_records'], p_date_from => date '2024-01-01', p_expires_at => now() + interval '2 days', p_allow_contribute => true,
  p_contribute_modules => array['perio_exams', 'treatment_plans', 'encounters'],
  p_clinician => '{"name":"Dr Perio","specialty":"Periodontics","license":"LIC-9","facility":"Gum Centre","city":"Riyadh"}') as sa \gset
-- B: a later doctor who only reads
select public.share_create(p_patient => :'pp', p_title => 'Later doctor', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_include => array['specialty_records'], p_date_from => date '2024-01-01', p_expires_at => now() + interval '2 days') as sb \gset
-- C: may chart the teeth (dental exam module) but not the gums
select public.share_create(p_patient => :'pp', p_title => 'Dentist only', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_expires_at => now() + interval '2 days', p_allow_contribute => true, p_contribute_modules => array['dental_exams'],
  p_clinician => '{"name":"Dr Teeth"}') as sc \gset
-- D: a cardiology link must not reach the dental charts
select public.share_create(p_patient => :'pp', p_title => 'Cardiology', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_card'::uuid],
  p_expires_at => now() + interval '2 days', p_allow_contribute => true, p_contribute_modules => array['perio_exams'],
  p_clinician => '{"name":"Dr Heart"}') as sd \gset
-- the module cannot be invented
select test.throws(format($$select public.share_create(p_patient => %L, p_title => 'x', p_scope_kind => 'full', p_allow_contribute => true,
  p_contribute_modules => array['perio_charts'], p_clinician => '{"name":"Dr Nobody"}')$$, :'pp'), 'check constraint|violates', 'only known contribution modules');
-- another patient with a link of his own (isolation)
select test.as_user(:'bob'::uuid);
select public.create_patient('Other Patient', date '1990-01-01', 'female', null, null, null, null, null, null, 'self', true) as po \gset
select public.perio_exam_save(:'po', null, '{"exam_date":"2024-03-03","examiner_name":"Dr Other"}', '[{"tooth":26,"pd":[5,5,5,5,5,5]}]', true) as ex_other \gset
select public.share_create(p_patient => :'po', p_title => 'Other periodontist', p_scope_kind => 'full', p_expires_at => now() + interval '2 days',
  p_allow_contribute => true, p_contribute_modules => array['perio_exams'], p_clinician => '{"name":"Dr Elsewhere"}') as se \gset
select test.as_user(:'alice'::uuid);

select (:'sa'::jsonb ->> 'token') as a_tok, (:'sa'::jsonb ->> 'pin') as a_pin, (:'sa'::jsonb ->> 'share_id') as a_id,
       (:'sb'::jsonb ->> 'token') as b_tok, (:'sb'::jsonb ->> 'pin') as b_pin,
       (:'sc'::jsonb ->> 'token') as c_tok, (:'sc'::jsonb ->> 'pin') as c_pin,
       (:'sd'::jsonb ->> 'token') as d_tok, (:'sd'::jsonb ->> 'pin') as d_pin,
       (:'se'::jsonb ->> 'token') as e_tok, (:'se'::jsonb ->> 'pin') as e_pin \gset
select test.ok((select 'perio_exams' = any (contribute_modules) from public.medical_shares where id = :'a_id'), 'the owner sees the new module on the link');

-- ---------------------------------------------------------------- sessions
select test.as_service();
select (public.share_open(:'a_tok', :'a_pin', 'ip-1', 'UA') ->> 'session_token') as a_sess \gset
select (public.share_open(:'a_tok', :'a_pin', 'ip-2', 'UA') ->> 'session_token') as a2_sess \gset
select (public.share_open(:'b_tok', :'b_pin', 'ip-3', 'UA') ->> 'session_token') as b_sess \gset
select (public.share_open(:'c_tok', :'c_pin', 'ip-4', 'UA') ->> 'session_token') as c_sess \gset
select (public.share_open(:'d_tok', :'d_pin', 'ip-5', 'UA') ->> 'session_token') as d_sess \gset
select (public.share_open(:'e_tok', :'e_pin', 'ip-6', 'UA') ->> 'session_token') as e_sess \gset

-- before the doctor confirms who they are, nothing is written
select test.ok(public.share_perio_save(:'a_sess', null, '{"exam_date":"2025-01-01"}', '[{"tooth":16,"pd":[3,3,3,3,3,3]}]') ->> 'status' = 'identify_first',
  'the doctor confirms the link is theirs before charting');
select (public.share_confirm_clinician(:'a_sess', 'ip-1', 'UA') ->> 'contributor_id') as a_ctr \gset
select (public.share_confirm_clinician(:'a2_sess', 'ip-2', 'UA') ->> 'contributor_id') as a2_ctr \gset
select public.share_confirm_clinician(:'c_sess', 'ip-4', 'UA');
select public.share_confirm_clinician(:'d_sess', 'ip-5', 'UA');
select public.share_confirm_clinician(:'e_sess', 'ip-6', 'UA');

-- ---------------------------------------------------------------- module gating, scope
select test.ok(public.share_perio_save(:'b_sess', null, '{"exam_date":"2025-01-01"}', '[{"tooth":16,"pd":[3,3,3,3,3,3]}]') ->> 'status' = 'forbidden',
  'a read-only link cannot chart');
select test.ok(public.share_perio_save(:'c_sess', null, '{"exam_date":"2025-01-01"}', '[{"tooth":16,"pd":[3,3,3,3,3,3]}]') ->> 'status' = 'forbidden',
  'a link without the periodontal module cannot chart');
select test.ok(public.share_perio_save(:'d_sess', null, '{"exam_date":"2025-01-01"}', '[{"tooth":16,"pd":[3,3,3,3,3,3]}]') ->> 'status' = 'forbidden',
  'a link outside dentistry cannot chart the gums');
select test.ok(public.share_perio(:'d_sess') ->> 'status' = 'none', 'nor read them');
select test.ok(public.share_perio(:'c_sess') ->> 'status' = 'none', 'a link that shares neither the dental file nor the module reads none');
select test.ok(public.share_perio_save('not-a-session', null, '{"exam_date":"2025-01-01"}', '[]') ->> 'status' = 'expired', 'an unknown session is refused');
select test.ok(not exists (select 1 from public.perio_exams where contributed_by is not null), 'nothing was written by the refused calls');

-- ---------------------------------------------------------------- charting through the link
select test.ok(public.share_perio_save(:'a_sess', null, jsonb_build_object('exam_date', current_date, 'examiner_name', 'Somebody Else', 'source', 'self',
  'contributed_by', :'a2_ctr', 'notes', 'forged'), '[{"tooth":16,"pd":[3,2,6,4,3,7]}]'::jsonb) ->> 'status' = 'invalid', 'a chart carrying an examiner, source or author key is refused (0033)');
select public.share_perio_save(:'a_sess', null, jsonb_build_object('exam_date', current_date, 'notes', 'initial chart'),
  '[{"tooth":16,"pd":[3,2,6,4,3,7],"gm":[0,-1,-2,0,null,1],"bop":[false,false,true,false,false,true],"mobility":2,"furcation_b":2},
    {"tooth":26,"pd":[4,4,5,4,4,4]},{"tooth":46,"missing":true}]'::jsonb) as r1 \gset
select (:'r1'::jsonb ->> 'id') as d1, (:'r1'::jsonb ->> 'status') as d1_status \gset
select test.ok(:'d1_status' = 'ok' and :'d1' is not null, 'the periodontist saves a draft chart through the link');
select test.ok((select status = 'draft' and contributed_by = :'a_ctr'::uuid and examiner_name = 'Dr Perio' and source = 'clinic' and verification = 'confirmed'
                       and source_detail like 'Dr Perio — Gum Centre%' and facility_name = 'Gum Centre' and patient_id = :'pp'::uuid
                  from public.perio_exams where id = :'d1'),
  'the chart carries the doctor''s name; examiner, source and author cannot be set by the payload');
select test.ok((select count(*) = 3 from public.perio_teeth where exam_id = :'d1')
               and (select cal = '{3,3,8,4,3,6}'::smallint[] from public.perio_teeth where exam_id = :'d1' and tooth = 16), 'its teeth and computed CAL are stored');
select test.ok((select contribution_count = 1 from public.share_contributors where id = :'a_ctr'), 'the chart counts as one addition');
select test.ok(public.share_perio_save(:'a_sess', null, jsonb_build_object('exam_date', current_date, 'notes', 'resumed'), '[{"tooth":11,"pd":[2,2,2,2,2,2]}]') ->> 'id' = :'d1',
  'with no id the doctor''s open draft is resumed (one open draft per doctor)');
select public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'notes', 'initial chart again'), '[{"tooth":36,"pd":[3,3,3,3,3,3]}]');
select test.ok((select contribution_count = 1 from public.share_contributors where id = :'a_ctr') and (select count(*) = 5 from public.perio_teeth where exam_id = :'d1'),
  'saving again adds nothing to the count, and teeth not sent are left alone');
select test.ok((select count(*) = 1 from public.perio_exams where contributed_by = :'a_ctr' and status = 'draft'), 'still one draft');

-- a doctor edits only their own draft
select test.ok(public.share_perio_save(:'a2_sess', :'d1', '{"exam_date":"2025-01-01"}', '[]') ->> 'status' = 'not_found', 'another doctor cannot edit it');
select test.ok(public.share_perio_save(:'a_sess', :'ex_gen', '{"exam_date":"2025-01-01"}', '[]') ->> 'status' = 'not_found', 'nor the patient''s final chart');
select test.ok(public.share_perio_save(:'a_sess', :'ex_draft', '{"exam_date":"2025-01-01"}', '[]') ->> 'status' = 'not_found', 'nor the patient''s own draft');
select test.ok(public.share_perio_save(:'a_sess', gen_random_uuid(), '{"exam_date":"2025-01-01"}', '[]') ->> 'status' = 'not_found', 'nor one that does not exist');
select test.ok(public.share_perio_save(:'a_sess', :'ex_other', '{"exam_date":"2025-01-01"}', '[]') ->> 'status' = 'not_found', 'nor another patient''s');
select public.share_perio_save(:'a2_sess', null, jsonb_build_object('exam_date', current_date - 1), '[{"tooth":21,"pd":[2,3,2,3,2,3]}]') as r2 \gset
select (:'r2'::jsonb ->> 'id') as d2 \gset
select test.ok(:'d2' <> :'d1' and (select contributed_by = :'a2_ctr'::uuid from public.perio_exams where id = :'d2'), 'each doctor has a draft of their own');

-- what the link shows
select test.ok(public.share_perio(:'a_sess') ->> 'status' = 'ok' and (public.share_perio(:'a_sess') ->> 'can_add')::boolean, 'the periodontist reads and may add');
select test.ok((select count(*) = 2 from jsonb_array_elements(public.share_perio(:'a_sess') -> 'exams') e)
               and (select bool_and(true) from jsonb_array_elements(public.share_perio(:'a_sess') -> 'exams') e where e ->> 'id' in (:'ex_gen', :'d1')),
  'the link shows the final chart inside the date range and the doctor''s own draft');
select test.ok(not exists (select 1 from jsonb_array_elements(public.share_perio(:'a_sess') -> 'exams') e where e ->> 'id' in (:'ex_old', :'ex_draft', :'d2', :'ex_other')),
  'not the chart before the range, the patient''s draft, another doctor''s draft or another patient''s chart');
select test.ok((select jsonb_array_length(e -> 'teeth') = 5 from jsonb_array_elements(public.share_perio(:'a_sess') -> 'exams') e where e ->> 'id' = :'d1'), 'with its teeth');
select test.ok((select jsonb_array_length(e -> 'teeth') = 1 from jsonb_array_elements(public.share_perio(:'b_sess') -> 'exams') e where e ->> 'id' = :'ex_gen'), 'the final chart carries its teeth');
select test.ok(public.share_perio(:'b_sess') ->> 'status' = 'ok' and not (public.share_perio(:'b_sess') ->> 'can_add')::boolean
               and (select count(*) = 1 from jsonb_array_elements(public.share_perio(:'b_sess') -> 'exams')), 'a read-only link sees the final chart only, and cannot add');
select test.ok((public.share_perio(:'a_sess') -> 'factors' ->> 'date_of_birth') = '1980-05-05' and (public.share_perio(:'a_sess') -> 'factors' -> 'diabetes')::boolean = false,
  'the grade factors travel with it');
select test.ok(public.share_perio(:'e_sess') -> 'exams' @> '[]' and not exists (select 1 from jsonb_array_elements(public.share_perio(:'e_sess') -> 'exams') e where e ->> 'id' <> :'ex_other'),
  'another patient''s link reaches only that patient''s charts');
select test.ok(not exists (select 1 from jsonb_array_elements(public.share_perio(:'e_sess') -> 'exams') e where e ->> 'id' in (:'ex_gen', :'d1')), 'isolation between patients');

-- ---------------------------------------------------------------- the accounts cannot rewrite a doctor's chart
select test.as_user(:'alice'::uuid);
select test.throws(format($$update public.perio_exams set notes = 'patient edit' where id = %L$$, :'d1'), 'contributed_record_readonly', 'the patient cannot edit the doctor''s chart');
select test.throws(format($$update public.perio_exams set dx_kind = 'health' where id = %L$$, :'d1'), 'contributed_record_readonly', 'nor its diagnosis');
select test.throws(format($$update public.perio_exams set status = 'final' where id = %L$$, :'d1'), 'contributed_record_readonly', 'nor finalise it');
select test.throws(format($$insert into public.perio_teeth (patient_id, exam_id, tooth, pd) values (%L, %L, 21, '{1,1,1,1,1,1}')$$, :'pp', :'d1'),
  'contributed_record_readonly', 'nor add a tooth to it');
select test.throws(format($$update public.perio_teeth set pd = '{9,9,9,9,9,9}' where exam_id = %L and tooth = 16$$, :'d1'), 'contributed_record_readonly', 'nor change one');
select test.throws(format($$select public.perio_exam_save(%L, %L, '{"exam_date":"2025-01-01"}', '[]')$$, :'pp', :'d1'), 'contributed_record_readonly', 'the chart-saving function refuses it too');
select test.throws(format($$insert into public.perio_exams (patient_id, exam_date, contributed_by) values (%L, current_date, %L)$$, :'pp', :'a_ctr'),
  'contributed_by is set by the share functions only', 'an account cannot claim a doctor''s authorship');
select test.ok((select count(*) = 1 from public.perio_exams where id = :'ex_draft' and contributed_by is null), 'the patient''s own draft is untouched');
select test.ok(public.perio_exam_save(:'pp', :'ex_draft', jsonb_build_object('exam_date', current_date, 'notes', 'mine'), '[]') = :'ex_draft', 'the patient still edits their own draft');
-- clearing a tooth in a saved draft persists (an empty tooth is sent and written as empty; "missing" can be unticked)
select public.perio_exam_save(:'pp', :'ex_draft', jsonb_build_object('exam_date', current_date), '[{"tooth":18,"missing":true}]');
select test.ok((select missing and pd is null from public.perio_teeth where exam_id = :'ex_draft' and tooth = 18), 'a tooth is marked missing in the draft');
select public.perio_exam_save(:'pp', :'ex_draft', jsonb_build_object('exam_date', current_date), '[{"tooth":18}]');
select test.ok((select not missing and pd is null from public.perio_teeth where exam_id = :'ex_draft' and tooth = 18), 'unticking "missing" and saving persists');
select public.perio_exam_save(:'pp', :'ex_draft', jsonb_build_object('exam_date', current_date), '[{"tooth":11}]');
select test.ok((select pd is null and gm is null and bop is null from public.perio_teeth where exam_id = :'ex_draft' and tooth = 11), 'a tooth whose values were cleared is cleared in the database');
select test.throws(format($$select public.perio_exam_save(%L, null, '{"exam_date":"2020-01-01"}', '[]')$$, :'pp'), 'unique|duplicate',
  'the patient still has one open draft of their own (the doctors'' drafts do not count)');
select test.ok((select count(*) = 3 from public.perio_exams where patient_id = :'pp' and status = 'draft' and record_status = 'active'),
  'three open drafts: the patient''s and one per doctor');
-- but the patient can mark a doctor's chart entered in error
update public.perio_exams set record_status = 'entered_in_error', invalidated_reason = 'wrong patient' where id = :'d2';
select test.ok((select record_status = 'entered_in_error' and invalidated_by = :'alice'::uuid from public.perio_exams where id = :'d2'), 'the patient can mark the doctor''s chart entered in error');
select test.as_service();
select test.ok(public.share_perio_save(:'a2_sess', :'d2', '{"exam_date":"2025-01-01"}', '[]') ->> 'status' = 'not_found', 'and the doctor cannot save over it afterwards');
select test.ok(not exists (select 1 from jsonb_array_elements(public.share_perio(:'a2_sess') -> 'exams') e where e ->> 'id' = :'d2'), 'it disappears from the link');
select test.as_user(:'bob'::uuid);
select test.ok((select count(*) = 0 from public.perio_exams where patient_id = :'pp'), 'another account sees none of it');
select test.as_service();

-- ---------------------------------------------------------------- the diagnosis
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'dx_kind', 'health', 'dx_stage', 'II'), '[]') ->> 'status' = 'invalid',
  'a stage only goes with periodontitis');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'dx_kind', 'periodontitis', 'dx_stage', 'V', 'dx_grade', 'B', 'dx_extent', 'localized'), '[]') ->> 'status' = 'invalid',
  'a stage is I to IV');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'dx_kind', 'periodontitis', 'dx_stage', 'III', 'dx_grade', 'D', 'dx_extent', 'localized'), '[]') ->> 'status' = 'invalid',
  'a grade is A to C');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'dx_kind', 'periodontitis', 'dx_stage', 'III', 'dx_grade', 'B', 'dx_extent', 'everywhere'), '[]') ->> 'status' = 'invalid',
  'an extent is one of three');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'dx_kind', 'periodontitis', 'dx_rbl_pct', 140), '[]') ->> 'status' = 'invalid',
  'bone loss is 0 to 100 %');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'dx_kind', 'periodontitis', 'dx_teeth_lost_perio', 40), '[]') ->> 'status' = 'invalid',
  'teeth lost to periodontitis are 0 to 32');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'dx_kind', 'severe'), '[]') ->> 'status' = 'invalid', 'the kind is one of four');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'dx_kind', 'periodontitis', 'dx_stage', 'III'), '[]', true) ->> 'status' = 'invalid',
  'a final chart that names periodontitis names stage, grade and extent too');
select test.ok((select status = 'draft' and dx_kind is null from public.perio_exams where id = :'d1'), 'a refused save changes nothing');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date + 5), '[]') ->> 'status' = 'invalid', 'no future exam date');
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'encounter_id', gen_random_uuid()), '[]') ->> 'status' = 'invalid',
  'a visit that does not exist cannot be linked');

-- the visit link: only visits added through this share
select (public.share_contribute(:'a_sess', 'encounters', jsonb_build_object('kind', 'clinic', 'started_at', now() - interval '1 hour', 'reason', 'Gum consultation')) ->> 'id') as enc_a \gset
insert into public.encounters (patient_id, kind, started_at, reason) values (:'pp', 'clinic', now() - interval '5 days', 'PATIENT-OWN-VISIT') returning id as enc_own \gset
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'encounter_id', :'enc_own'), '[]') ->> 'status' = 'invalid',
  'a doctor links a chart only to a visit added through the link, not to the patient''s own visits');
select test.ok(public.share_perio_save(:'a2_sess', null, jsonb_build_object('exam_date', current_date, 'encounter_id', :'enc_a'), '[{"tooth":21,"pd":[2,3,2,3,2,3]}]') ->> 'status' = 'ok',
  'a visit added through the same link can be linked');
select test.ok((select encounter_id = :'enc_a'::uuid from public.perio_exams where contributed_by = :'a2_ctr' and record_status = 'active'), 'the chart carries the visit');
update public.perio_exams set record_status = 'entered_in_error', invalidated_reason = 'test cleanup' where contributed_by = :'a2_ctr' and record_status = 'active';

-- finalising with the diagnosis; the recall moves
select test.ok(public.share_perio_save(:'a_sess', :'d1', jsonb_build_object('exam_date', current_date, 'encounter_id', :'enc_a', 'notes', 'final notes',
  'dx_kind', 'periodontitis', 'dx_stage', 'III', 'dx_grade', 'B', 'dx_extent', 'generalized', 'dx_rbl_pct', 40, 'dx_teeth_lost_perio', 1, 'dx_note', 'smoker, deep pockets'),
  '[{"tooth":16,"pd":[3,2,6,4,3,7],"gm":[0,-1,-2,0,null,1]}]', true) ->> 'final' = 'true', 'the periodontist finalises the chart with the diagnosis');
select test.ok((select status = 'final' and finalized_at is not null and dx_kind = 'periodontitis' and dx_stage = 'III' and dx_grade = 'B' and dx_extent = 'generalized'
                       and dx_rbl_pct = 40 and dx_teeth_lost_perio = 1 and encounter_id = :'enc_a'::uuid and finalized_by is null
                  from public.perio_exams where id = :'d1'), 'the diagnosis is stored with the chart');
select test.ok((select last_done_on = current_date from public.recalls where id = :'rc'), 'finalising moves the periodontal maintenance recall');
select test.ok(public.share_perio_save(:'a_sess', :'d1', '{"exam_date":"2025-01-01"}', '[]') ->> 'status' = 'not_found', 'a final chart cannot be saved over, even by its author');
select test.throws(format($$update public.perio_exams set dx_stage = 'IV' where id = %L$$, :'d1'), 'perio_final', 'the diagnosis of a final chart is fixed');
select test.throws(format($$update public.perio_exams set encounter_id = null where id = %L$$, :'d1'), 'perio_final', 'and so is the visit link');
select test.throws(format($$update public.perio_teeth set pd = '{1,1,1,1,1,1}' where exam_id = %L and tooth = 16$$, :'d1'), 'perio_final', 'and its teeth');
select test.ok((select bool_and(true) from jsonb_array_elements(public.share_perio(:'b_sess') -> 'exams') e
                 where e ->> 'id' = :'d1' and e ->> 'dx_stage' = 'III' and e ->> 'dx_grade' = 'B' and e ->> 'dx_extent' = 'generalized' and e ->> 'dx_kind' = 'periodontitis'
                   and e ->> 'status' = 'final' and e ->> 'examiner_name' = 'Dr Perio'),
  'the next doctor sees the final chart with the diagnosis and who recorded it');
select test.ok((select count(*) = 2 from jsonb_array_elements(public.share_perio(:'b_sess') -> 'exams')), 'and the earlier final chart in range');
select test.ok(exists (select 1 from jsonb_array_elements(public.share_contrib_state(:'a_sess') -> 'items') i where i ->> 'table' = 'perio_exams' and (i ->> 'mine')::boolean),
  'the doctor''s own list shows the chart');

-- ---------------------------------------------------------------- the limit
select coalesce(sum(contribution_count), 0) as used0 from public.share_contributors where share_id = :'a_id' \gset
select test.ok(:used0 = 4, 'a visit and three charts have been counted once each');
update public.medical_shares set max_contributions = :used0 where id = :'a_id';
select test.ok(public.share_perio_save(:'a_sess', null, jsonb_build_object('exam_date', current_date), '[{"tooth":21,"pd":[2,2,2,2,2,2]}]') ->> 'status' = 'limit', 'a new chart past the limit is refused');
update public.medical_shares set max_contributions = :used0 + 1 where id = :'a_id';
select public.share_perio_save(:'a_sess', null, jsonb_build_object('exam_date', current_date), '[{"tooth":21,"pd":[2,2,2,2,2,2]}]') as r3 \gset
select (:'r3'::jsonb ->> 'id') as d3 \gset
select test.ok(:'d3' is not null and (select contribution_count from public.share_contributors where id = :'a_ctr') = 3, 'the last allowed chart is accepted');
select test.ok(public.share_perio_save(:'a_sess', :'d3', jsonb_build_object('exam_date', current_date), '[{"tooth":22,"pd":[2,2,2,2,2,2]}]') ->> 'status' = 'ok',
  'a draft already counted can still be saved at the limit');
update public.medical_shares set max_contributions = 100 where id = :'a_id';

-- ---------------------------------------------------------------- withdrawal, bulk invalidation
select test.ok(public.share_retract(:'a_sess', 'perio_exams', :'d3', 'wrong patient file') ->> 'status' = 'ok', 'the doctor withdraws their own chart');
select test.ok((select record_status = 'entered_in_error' from public.perio_exams where id = :'d3'), 'it stays in the history');
select test.ok(public.share_retract(:'e_sess', 'perio_exams', :'d1', 'not mine') ->> 'status' = 'not_found', 'a doctor of another link cannot withdraw this chart');
select test.ok(public.share_retract(:'b_sess', 'perio_exams', :'d1', 'not allowed') ->> 'status' = 'forbidden', 'a read-only link cannot withdraw');

-- ---------------------------------------------------------------- the plan in phases uses the catalogue
select test.ok((select count(*) = 2 from public.procedure_catalog where code in ('perio_reevaluation', 'perio_flap_surgery') and category = 'periodontal' and is_active)
               and (select surgical from public.procedure_catalog where code = 'perio_flap_surgery'), 'the catalogue has the re-evaluation and the periodontal surgery');
select public.share_contribute_treatment_plan(:'a_sess', '{"title":"Periodontal plan","lang":"en"}',
  '[{"catalog_code":"hygiene_instruction","phase":1},{"catalog_code":"root_planing","phase":1,"teeth":[16,17]},{"catalog_code":"perio_reevaluation","phase":2},
    {"catalog_code":"perio_flap_surgery","phase":3,"teeth":[16]},{"catalog_code":"perio_maintenance","phase":4}]') as r4 \gset
select test.ok(:'r4'::jsonb ->> 'status' = 'ok' and (select count(*) = 5 and count(distinct phase) = 4 and bool_or(surgical) from public.treatment_items where plan_id = (:'r4'::jsonb ->> 'id')::uuid),
  'the periodontist proposes the phased plan through the link');
select test.as_user(:'alice'::uuid);
select public.treatment_plan_create(:'pp', '{"title":"My periodontal plan"}', '[{"catalog_code":"scaling","phase":1},{"catalog_code":"perio_reevaluation","phase":2},{"catalog_code":"perio_maintenance","phase":4}]') as pl \gset
select test.ok((select count(*) = 3 from public.treatment_items where plan_id = :'pl'), 'the patient can create the same plan from their account');

-- ---------------------------------------------------------------- the owner invalidates everything one doctor added
select test.ok(public.share_invalidate_contributions(:'a2_ctr', 'not my doctor') >= 0, 'the owner can invalidate a doctor''s additions');
select test.ok(public.share_invalidate_contributions(:'a_ctr', 'link shared by mistake') >= 2, 'including charts (the chart, the visit and the plan)');
select test.ok(not exists (select 1 from public.perio_exams where contributed_by = :'a_ctr' and record_status = 'active'), 'no chart of that doctor stays active');
select test.ok((select count(*) = 3 from public.perio_exams where patient_id = :'pp' and record_status = 'active' and contributed_by is null), 'the patient''s own charts are untouched');

-- ---------------------------------------------------------------- revoked or ended links
select test.as_user(:'alice'::uuid);
select public.share_revoke((:'sa'::jsonb ->> 'share_id')::uuid, 'done');
select test.as_service();
select test.ok(public.share_perio_save(:'a_sess', null, '{"exam_date":"2025-01-01"}', '[{"tooth":21,"pd":[2,2,2,2,2,2]}]') ->> 'status' = 'expired', 'a revoked link cannot chart');
select test.ok(public.share_perio(:'a_sess') ->> 'status' = 'expired', 'nor read');

-- ---------------------------------------------------------------- checks that apply to every route
select test.as_user(:'alice'::uuid);
select test.throws(format($$select public.perio_exam_save(%L, null, '{"exam_date":"2025-01-01","dx_kind":"gingivitis","dx_stage":"I"}', '[]')$$, :'po'), 'forbidden', 'the account function still needs access to the file');
select test.throws(format($$update public.perio_exams set dx_stage = 'II' where id = %L$$, :'ex_draft'), 'perio_exams_dx_periodontitis_chk', 'a stage without any kind of diagnosis is refused (table check)');
select test.throws(format($$update public.perio_exams set dx_kind = 'periodontitis', dx_stage = 'II', dx_grade = 'Z' where id = %L$$, :'ex_draft'), 'check constraint|violates', 'a grade outside A–C is refused');
select test.throws(format($$update public.perio_exams set dx_rbl_pct = -1 where id = %L$$, :'ex_draft'), 'check constraint|violates', 'bone loss cannot be negative');
select test.throws(format($$select public.share_perio(%L)$$, :'b_sess'), 'permission denied|42501', 'an account cannot call the link''s read function');
select test.throws(format($$select public.share_perio_save(%L, null, '{}', '[]')$$, :'b_sess'), 'permission denied|42501', 'nor its write function');
select public.perio_exam_save(:'pp', :'ex_draft', jsonb_build_object('exam_date', current_date, 'encounter_id', :'enc_own', 'dx_kind', 'periodontitis', 'dx_stage', 'II', 'dx_grade', 'A', 'dx_extent', 'localized',
  'dx_rbl_pct', 20), '[]');
select test.ok((select dx_stage = 'II' and encounter_id = :'enc_own'::uuid from public.perio_exams where id = :'ex_draft'), 'the patient links a chart of their own to a visit and records a diagnosis');
select test.throws(format($$select public.perio_exam_save(%L, %L, '{"exam_date":"2025-01-01","dx_kind":"periodontitis","dx_stage":"II"}', '[{"tooth":11,"pd":[2,2,2,2,2,2]}]', true)$$, :'pp', :'ex_draft'),
  'perio_exams_dx_complete_chk', 'a final chart naming periodontitis is complete (account route)');

-- ---------------------------------------------------------------- purge
select public.patient_request_deletion(:'pp', 'Specialist Patient');
select test.as_service();
select public.patient_purge(:'pp', true);
select test.ok((select count(*) = 0 from public.perio_exams where patient_id = :'pp') and (select count(*) = 0 from public.perio_teeth where patient_id = :'pp')
               and (select count(*) = 0 from public.share_contributors where patient_id = :'pp'), 'charts, teeth and contributors are purged with the file');
select test.ok((select count(*) = 1 from public.perio_exams where patient_id = :'po'), 'another patient''s chart is untouched');
select test.as_super();
