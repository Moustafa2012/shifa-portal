\pset tuples_only on
\set alice 'a1111111-1111-1111-1111-111111111111'
\set bob 'b2222222-2222-2222-2222-222222222222'
select id as s_dent from public.medical_specialties where code = 'dentistry' \gset
select id as s_card from public.medical_specialties where code = 'cardiology' \gset

select test.ok(app.is_fdi_tooth(11::smallint) and app.is_fdi_tooth(48::smallint) and app.is_fdi_tooth(55::smallint) and app.is_fdi_tooth(85::smallint)
               and not app.is_fdi_tooth(19::smallint) and not app.is_fdi_tooth(56::smallint) and not app.is_fdi_tooth(91::smallint)
               and not app.is_fdi_tooth(10::smallint), 'FDI numbering: permanent 11-48, primary 51-85');
select test.ok(app.valid_surfaces(array['M', 'O']) and app.valid_surfaces('{}') and not app.valid_surfaces(array['X'])
               and not app.valid_surfaces(array['M', 'M']), 'surfaces are M/D/O/B/L, each once');

select test.as_user(:'alice'::uuid);
select public.create_patient('Dental Patient', date '1985-04-04', 'male', null, null, null, null, null, null, 'self', true) as pd \gset

-- profile
insert into public.dental_profiles (patient_id, dentition, brushing, bruxism) values (:'pd', 'permanent', 'twice', true);
update public.dental_profiles set flossing = 'daily' where patient_id = :'pd';
select test.ok((select flossing = 'daily' and updated_by = :'alice'::uuid from public.dental_profiles where patient_id = :'pd'), 'the dental profile is kept per patient');

-- an exam in one step
select public.dental_exam_create(:'pd', jsonb_build_object('exam_date', current_date - 30, 'kind', 'comprehensive', 'examiner_name', 'Dr Self Report'),
  '[{"tooth":11,"status":"present"},{"tooth":18,"status":"extracted"},{"tooth":28,"status":"impacted","note":"seen on panoramic"}]',
  '[{"tooth":16,"surfaces":["O","M"],"kind":"caries","evidence":"clinical"},{"tooth":36,"kind":"crown","material":"zirconia"}]') as ex1 \gset
select test.ok((select count(*) from public.dental_tooth_states where exam_id = :'ex1') = 3
               and (select count(*) from public.dental_findings where exam_id = :'ex1') = 2, 'an exam is saved with its tooth states and findings');
select test.ok((select surfaces = array['M', 'O'] and observed_on = current_date - 30 and specialty_id = :'s_dent'::uuid and verification = 'reported'
                  from public.dental_findings where exam_id = :'ex1' and tooth = 16), 'findings take the exam date and dentistry; a patient entry stays "reported"');
select test.throws(format($$select public.dental_exam_create(%L, '{"exam_date":"2020-01-01"}', '[]', '[]')$$, :'pd'), 'exam_empty', 'an empty exam is refused');
select test.throws(format($$select public.dental_exam_create(%L, jsonb_build_object('exam_date', current_date + 10), '[{"tooth":11,"status":"present"}]', '[]')$$, :'pd'),
  'exam_date_invalid', 'an exam in the future is refused');
select test.throws(format($$select public.dental_exam_create(%L, '{"exam_date":"2020-01-01"}', '[{"tooth":19,"status":"present"}]', '[]')$$, :'pd'),
  'check constraint|violates', 'a tooth number outside FDI is refused');
select test.throws(format($$select public.dental_exam_create(%L, '{"exam_date":"2020-01-01"}', '[{"tooth":11,"status":"present"},{"tooth":11,"status":"missing"}]', '[]')$$, :'pd'),
  'duplicate key|unique', 'a tooth appears once per exam');
select test.throws(format($$select public.dental_exam_create(%L, '{"exam_date":"2020-01-01"}', '[]', '[{"tooth":16,"surfaces":["Q"],"kind":"caries"}]')$$, :'pd'),
  'check constraint|violates', 'an unknown surface is refused');
select test.throws(format($$insert into public.dental_findings (patient_id, tooth, kind, observed_on) values (%L, 11, 'magic', current_date)$$, :'pd'),
  'check constraint|violates', 'an unknown finding kind is refused');

-- a finding outside any exam (e.g. "I have had a crown on 46 since 2019")
insert into public.dental_findings (patient_id, tooth, kind, evidence, observed_on, date_precision) values (:'pd', 46, 'crown', 'patient_reported', date '2019-01-01', 'year')
  returning id as f_self \gset
update public.dental_findings set resolved_on = current_date, resolved_note = 'replaced' where id = :'f_self';
select test.ok((select resolved_on = current_date from public.dental_findings where id = :'f_self'), 'a finding can be marked resolved');

-- diagnoses name their teeth
insert into public.conditions (patient_id, specialty_id, name, category, teeth, evidence) values (:'pd', :'s_dent', 'Irreversible pulpitis', 'diagnosis', '{36}', 'clinical_radiographic')
  returning id as dx \gset
select test.throws(format($$insert into public.conditions (patient_id, name, teeth) values (%L, 'bad', '{19}')$$, :'pd'), 'check constraint|violates',
  'a diagnosis cannot name a non-existent tooth');
select public.dental_exam_create(:'pd', jsonb_build_object('exam_date', current_date), '[]',
  jsonb_build_array(jsonb_build_object('tooth', 36, 'kind', 'periapical_lesion', 'evidence', 'radiographic', 'condition_id', :'dx'))) as ex2 \gset
select test.ok((select condition_id = :'dx'::uuid from public.dental_findings where exam_id = :'ex2'), 'a finding can be linked to the diagnosis it supports');

-- isolation
select test.as_user(:'bob'::uuid);
select test.ok((select count(*) from public.dental_exams where patient_id = :'pd') = 0 and (select count(*) from public.dental_findings where patient_id = :'pd') = 0
               and (select count(*) from public.dental_tooth_states where patient_id = :'pd') = 0 and (select count(*) from public.dental_profiles where patient_id = :'pd') = 0,
  'another account sees nothing of this dental file');
select test.throws(format($$select public.dental_exam_create(%L, '{"exam_date":"2020-01-01"}', '[{"tooth":11,"status":"present"}]', '[]')$$, :'pd'),
  'forbidden', 'another account cannot add an exam');
select test.throws(format($$insert into public.dental_findings (patient_id, tooth, kind, observed_on) values (%L, 11, 'caries', current_date)$$, :'pd'),
  'row-level security|permission', 'another account cannot add a finding');

-- invalidation follows the exam
select test.as_user(:'alice'::uuid);
update public.dental_exams set record_status = 'entered_in_error', invalidated_reason = 'wrong patient' where id = :'ex2';
select test.ok((select record_status = 'entered_in_error' and invalidated_reason like '%wrong patient' from public.dental_findings where exam_id = :'ex2'),
  'invalidating an exam invalidates its findings, with the reason');
select test.throws(format($$insert into public.dental_tooth_states (patient_id, exam_id, tooth, status) values (%L, %L, 21, 'present')$$, :'pd', :'ex2'),
  'entered in error', 'nothing is added to an invalidated exam');
select test.ok((select count(*) from public.audit_logs where table_name = 'dental_exams' and record_id = :'ex1') >= 1
               and (select count(*) from public.audit_logs where table_name = 'dental_tooth_states' and patient_id = :'pd') >= 3, 'dental changes are audited');

-- ---------------------------------------------------------------- the clinician through a share
select public.share_create(p_patient => :'pd', p_title => 'Dentist', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_expires_at => now() + interval '2 days', p_allow_contribute => true, p_contribute_modules => array['conditions', 'dental_exams'],
  p_clinician => '{"name":"Dr Enamel","specialty":"Dentist","license":"LIC-9","facility":"Molar Clinic"}') as dsh \gset
select public.share_create(p_patient => :'pd', p_title => 'Cardio', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_card'::uuid],
  p_expires_at => now() + interval '2 days', p_allow_contribute => true, p_contribute_modules => array['dental_exams'], p_clinician => '{"name":"Dr Heart"}') as csh \gset
select (:'dsh'::jsonb ->> 'token') as d_tok, (:'dsh'::jsonb ->> 'pin') as d_pin, (:'csh'::jsonb ->> 'token') as c_tok, (:'csh'::jsonb ->> 'pin') as c_pin \gset
select test.throws(format($$select public.share_dental('x')$$), 'permission denied|42501', 'an account cannot call the share dental functions');

select test.as_service();
select (public.share_open(:'d_tok', :'d_pin', 'ip-d', 'UA') ->> 'session_token') as d_sess \gset
select (public.share_open(:'c_tok', :'c_pin', 'ip-c', 'UA') ->> 'session_token') as c_sess \gset
select public.share_dental(:'d_sess') as chart \gset
select test.ok(:'chart'::jsonb ->> 'status' = 'ok' and jsonb_array_length(:'chart'::jsonb -> 'exams') = 1
               and jsonb_array_length(:'chart'::jsonb -> 'findings') = 3 and jsonb_array_length(:'chart'::jsonb -> 'diagnoses') = 1
               and (:'chart'::jsonb -> 'profile' ->> 'brushing') = 'twice',
  'the dentist sees the chart: active exams, findings and tooth-linked diagnoses (not the invalidated exam)');
select test.ok(public.share_dental(:'c_sess') ->> 'status' = 'none', 'a cardiology share does not show the dental chart');
select test.ok(public.share_contribute_dental_exam(:'d_sess', '{"exam_date":"2026-01-01"}', '[{"tooth":11,"status":"present"}]', '[]') ->> 'status' = 'identify_first',
  'the clinician identifies before recording');
select (public.share_identify(:'d_sess', 'Dr Enamel', 'Dentist', 'LIC-9', 'Molar Clinic', null, :'pd' || '/signatures/s.png') ->> 'contributor_id') as ctr \gset
select (public.share_identify(:'c_sess', 'Dr Heart', null, null, null, null, :'pd' || '/signatures/c.png') ->> 'contributor_id') as ctr2 \gset
select test.ok(public.share_contribute_dental_exam(:'c_sess', '{"exam_date":"2026-01-01"}', '[{"tooth":11,"status":"present"}]', '[]') ->> 'status' = 'forbidden',
  'a share without dentistry cannot record a dental exam');
select test.ok(public.share_contribute_dental_exam(:'d_sess', jsonb_build_object('exam_date', current_date), '[]',
                 jsonb_build_array(jsonb_build_object('tooth', 36, 'kind', 'caries', 'condition_id', :'dx'))) ->> 'status' = 'invalid',
  'the clinician can link only to diagnoses they added through this share');
select (public.share_contribute(:'d_sess', 'conditions', jsonb_build_object('name', 'Caries 26', 'teeth', '[26]'::jsonb, 'evidence', 'clinical')) ->> 'id') as dx2 \gset
select test.ok((select teeth = '{26}' and contributed_by = :'ctr'::uuid from public.conditions where id = :'dx2'), 'a diagnosis added through the share names its tooth');
select test.ok(public.share_contribute_dental_exam(:'d_sess', jsonb_build_object('exam_date', current_date, 'kind', 'periodic', 'source', 'self'), '[{"tooth":26,"status":"present"}]', '[]') ->> 'status' = 'invalid',
  'an exam payload carrying a source key is refused (0033)');
select (public.share_contribute_dental_exam(:'d_sess',
  jsonb_build_object('exam_date', current_date, 'kind', 'periodic', 'examiner_name', 'Dr Enamel'),
  '[{"tooth":26,"status":"present"},{"tooth":18,"status":"extracted"}]',
  jsonb_build_array(jsonb_build_object('tooth', 26, 'surfaces', jsonb_build_array('D'), 'kind', 'caries', 'evidence', 'clinical_radiographic', 'condition_id', :'dx2'),
                    jsonb_build_object('tooth', 21, 'surfaces', jsonb_build_array('B'), 'kind', 'filling', 'material', 'composite')),
  'ip-d', 'UA') ->> 'id') as cex \gset
select test.ok((select contributed_by = :'ctr'::uuid and source = 'clinic' and verification = 'confirmed' and source_detail like 'Dr Enamel%'
                  from public.dental_exams where id = :'cex')
               and (select bool_and(contributed_by = :'ctr'::uuid and verification = 'confirmed') from public.dental_findings where exam_id = :'cex')
               and (select bool_and(contributed_by = :'ctr'::uuid) from public.dental_tooth_states where exam_id = :'cex'),
  'the clinician''s exam, its findings and tooth states carry their name and are confirmed');
select test.ok((select actor_kind = 'share_contributor' from public.audit_logs where table_name = 'dental_exams' and record_id = :'cex'),
  'the audit names the clinician');
select public.share_contrib_state(:'d_sess') as st \gset
select test.ok(exists (select 1 from jsonb_array_elements(:'st'::jsonb -> 'items') i where i ->> 'table' = 'dental_exams')
               and jsonb_array_length(:'st'::jsonb -> 'conditions') = 1 and (:'st'::jsonb ->> 'covers_dentistry')::boolean,
  'the clinician sees the exam in their list and their diagnoses for linking');

-- the patient's side of a clinician's exam
select test.as_user(:'alice'::uuid);
select test.throws(format($$update public.dental_tooth_states set status = 'present' where exam_id = %L and tooth = 18$$, :'cex'), 'contributed_record_readonly',
  'the patient cannot change a tooth state the clinician recorded');
select test.throws(format($$insert into public.dental_findings (patient_id, exam_id, tooth, kind, observed_on) values (%L, %L, 11, 'caries', current_date)$$, :'pd', :'cex'),
  'contributed_record_readonly', 'the patient cannot add findings to the clinician''s exam');
select test.throws(format($$update public.dental_findings set kind = 'filling' where exam_id = %L and tooth = 26$$, :'cex'), 'contributed_record_readonly',
  'the patient cannot rewrite the clinician''s finding');
update public.dental_findings set resolved_on = current_date, resolved_note = 'filled elsewhere' where exam_id = :'cex' and tooth = 26;
select test.ok((select resolved_on is not null from public.dental_findings where exam_id = :'cex' and tooth = 26), 'but can record that it was resolved');

-- the clinician withdraws the exam: its findings follow
select test.as_service();
select test.ok(public.share_retract(:'d_sess', 'dental_exams', :'cex', 'recorded on the wrong visit') ->> 'status' = 'ok', 'the clinician withdraws the exam');
select test.ok((select bool_and(record_status = 'entered_in_error') from public.dental_findings where exam_id = :'cex'), 'its findings are withdrawn with it');

-- invalidate everything from one clinician
select (public.share_contribute_dental_exam(:'d_sess', jsonb_build_object('exam_date', current_date), '[{"tooth":11,"status":"present"}]', '[{"tooth":11,"kind":"sealant"}]') ->> 'id') as cex2 \gset
select test.as_user(:'alice'::uuid);
select test.ok(public.share_invalidate_contributions(:'ctr', 'not my dentist') = 2, 'invalidating a clinician covers their exams and diagnoses');
select test.ok((select record_status from public.dental_findings where exam_id = :'cex2') = 'entered_in_error', 'and the findings of those exams');

-- erasing the file removes the dental data too
select public.patient_request_deletion(:'pd', 'Dental Patient');
select test.as_service();
select public.patient_purge(:'pd', true);
select test.ok(not exists (select 1 from public.dental_exams where patient_id = :'pd') and not exists (select 1 from public.dental_findings where patient_id = :'pd')
               and not exists (select 1 from public.dental_profiles where patient_id = :'pd'), 'purging a file removes its dental records');
select test.as_super();
