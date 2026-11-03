-- 0033: strict validation of what a doctor sends through a share link. Every refusal is a status 'invalid' with a "field:code"
-- reason, and none of them uses up one of the share's additions.
\pset tuples_only on
\set alice 'a1111111-1111-1111-1111-111111111111'
select id as s_dent from public.medical_specialties where code = 'dentistry' \gset

select test.as_user(:'alice'::uuid);
select public.create_patient('Validation Patient', date '1990-02-02', 'female', null, null, null, null, null, null, 'self', true) as pv \gset
select public.create_patient('Validation Other', date '1991-03-03', 'male', null, null, null, null, null, null, 'self', true) as po \gset
insert into public.encounters (patient_id, kind, started_at, reason) values (:'po', 'clinic', now() - interval '1 day', 'OTHER-PATIENTS-VISIT') returning id as e_other \gset

select public.share_create(p_patient => :'pv', p_title => 'Validation', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_expires_at => now() + interval '2 days', p_allow_contribute => true, p_allow_notes => true,
  p_contribute_modules => array['encounters', 'conditions', 'procedures', 'clinical_notes', 'medications', 'appointments', 'test_orders', 'imaging_studies',
                                'medical_documents', 'dental_exams', 'treatment_plans', 'perio_exams', 'prescriptions', 'consents'],
  p_clinician => '{"name":"Dr Strict","facility":"Rules Clinic"}') as a \gset
select public.share_create(p_patient => :'pv', p_title => 'Last month only', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_date_from => current_date - 30, p_date_to => current_date - 1, p_expires_at => now() + interval '2 days', p_allow_contribute => true,
  p_contribute_modules => array['procedures', 'encounters'], p_clinician => '{"name":"Dr Window","facility":"Rules Clinic"}') as b \gset
select (:'a'::jsonb ->> 'token') as a_tok, (:'a'::jsonb ->> 'pin') as a_pin, (:'a'::jsonb ->> 'share_id') as a_id,
       (:'b'::jsonb ->> 'token') as b_tok, (:'b'::jsonb ->> 'pin') as b_pin \gset

select test.as_service();
select (public.share_open(:'a_tok', :'a_pin', 'ip-v1', 'UA') ->> 'session_token') as sa \gset
select (public.share_open(:'b_tok', :'b_pin', 'ip-v2', 'UA') ->> 'session_token') as sb \gset
select public.share_confirm_clinician(:'sa');
select public.share_confirm_clinician(:'sb');
select coalesce(sum(contribution_count), 0) as used0 from public.share_contributors where share_id = :'a_id'::uuid \gset

-- ---------------------------------------------------------------- the limits a form needs
select test.ok(public.share_limits(:'sa') ->> 'dob' = '1990-02-02' and public.share_limits(:'sa') ->> 'session_expires_at' is not null, 'the form is told the patient''s birth date and when the session ends');
select test.ok(public.share_limits(:'sb') ->> 'date_from' = (current_date - 30)::text, 'and the period the link covers');
select test.ok(public.share_limits('not-a-session-token-at-all-xxxxxxxx') ->> 'status' = 'expired', 'an unknown session learns nothing');

-- ---------------------------------------------------------------- text: unknown keys, types, control characters, markup, blank, length
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries 16","bogus":1}') ->> 'reason' = 'bogus:keys', 'an unknown key is refused (and named)');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries 16","__proto__":{"x":1}}') ->> 'reason' = '__proto__:keys', 'a prototype-polluting key is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries 16","constructor":"x"}') ->> 'reason' = 'constructor:keys', 'so is "constructor"');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries 16","patient_id":"00000000-0000-0000-0000-000000000000"}') ->> 'reason' = 'patient_id:keys', 'the patient cannot be named in the payload');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":12}') ->> 'reason' = 'name:format', 'a number where text belongs is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', jsonb_build_object('name', 'Car' || chr(7) || 'ies')) ->> 'reason' = 'name:control', 'a control character is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', jsonb_build_object('name', 'Caries', 'notes', 'line one' || chr(10) || 'line two' || chr(9) || 'tab')) ->> 'status' = 'ok', 'a newline and a tab are fine in free text');
select test.ok(public.share_contribute(:'sa', 'conditions', jsonb_build_object('name', 'Car' || chr(10) || 'ies')) ->> 'reason' = 'name:control', 'but not in a one-line field');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"     "}') ->> 'reason' = 'name:blank', 'text made only of spaces is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"x"}') ->> 'reason' = 'name:short', 'a one-letter diagnosis is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', jsonb_build_object('name', repeat('a', 201))) ->> 'reason' = 'name:long', 'a 201-character title is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', jsonb_build_object('name', 'Ok', 'notes', repeat('n', 4001))) ->> 'reason' = 'notes:long', 'free text stops at 4000');
select test.ok(public.share_contribute(:'sa', 'clinical_notes', jsonb_build_object('body', repeat('n', 20001))) ->> 'reason' = 'body:long', 'a note stops at 20000');
select test.ok(public.share_contribute(:'sa', 'clinical_notes', jsonb_build_object('body', repeat('n', 20000))) ->> 'status' = 'ok', 'a note of exactly 20000 is accepted');
select test.ok(public.share_contribute(:'sa', 'encounters', jsonb_build_object('started_at', now() - interval '1 hour', 'practitioner_name', 'Dr <script>')) ->> 'reason' = 'practitioner_name:markup',
  'markup in a name is refused');
select test.ok(public.share_contribute(:'sa', 'encounters', jsonb_build_object('started_at', now() - interval '1 hour', 'facility_name', 'A')) ->> 'reason' = 'facility_name:short', 'a facility name has at least 2 characters');
select test.ok(public.share_contribute(:'sa', 'clinical_notes', jsonb_build_object('body', 'see <b>this</b>')) ->> 'reason' = 'body:markup', 'a tag in free text is refused');
select test.ok(public.share_contribute(:'sa', 'clinical_notes', jsonb_build_object('body', 'pocket depth <5 mm and >3 mm')) ->> 'status' = 'ok', 'but a plain "<5 mm" is clinical shorthand, not markup');
select test.ok(public.share_contribute(:'sa', 'clinical_notes', jsonb_build_object('body', 'bidi ' || chr(8238) || 'override')) ->> 'reason' = 'body:control', 'a bidirectional override is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","icd10_code":"K02.1x9z9"}') ->> 'reason' = 'icd10_code:format', 'an ICD-10 code has its shape');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries 16","icd10_code":"K02.1"}') ->> 'status' = 'ok', 'a good ICD-10 code is accepted');

-- ---------------------------------------------------------------- enumerations and teeth
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","category":"bogus"}') ->> 'reason' = 'category:enum', 'an unknown category is refused by the database');
select test.ok(public.share_contribute(:'sa', 'encounters', jsonb_build_object('started_at', now() - interval '1 hour', 'kind', 'bogus')) ->> 'reason' = 'kind:enum', 'an unknown visit kind is refused');
select test.ok(public.share_contribute(:'sa', 'medications', '{"name_generic":"Amoxicillin","form":"mouthwash"}') ->> 'reason' = 'form:enum', 'an unknown medicine form is refused');
select test.ok(public.share_contribute(:'sa', 'medications', '{"name_generic":"Amoxicillin","route":"telepathy"}') ->> 'reason' = 'route:enum', 'an unknown route is refused');
select test.ok(public.share_contribute(:'sa', 'medications', '{"strength":"5 mg"}') ->> 'reason' = 'name_generic:required', 'a medicine needs a name');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","teeth":[99]}') ->> 'reason' = 'teeth:teeth', 'a tooth that is not FDI is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","teeth":[16,"x"]}') ->> 'reason' = 'teeth:teeth', 'a tooth that is not a number is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","teeth":[16.5]}') ->> 'reason' = 'teeth:teeth', 'nor a tooth with decimals');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","teeth":"16"}') ->> 'reason' = 'teeth:teeth', 'nor a string');
select test.ok(public.share_contribute(:'sa', 'procedures', jsonb_build_object('name', 'Filling', 'performed_on', current_date, 'sensitive', true)) ->> 'reason' = 'sensitive:keys', 'a field the table does not offer is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","sensitive":"yes"}') ->> 'reason' = 'sensitive:format', 'a boolean must be a boolean');

-- ---------------------------------------------------------------- dates
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","onset_date":"2026-02-30"}') ->> 'reason' = 'onset_date:date_invalid', '2026-02-30 is not a date');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","onset_date":"not a date"}') ->> 'reason' = 'onset_date:date_invalid', 'text is not a date');
select test.ok(public.share_contribute(:'sa', 'conditions', jsonb_build_object('name', 'Caries', 'onset_date', current_date + 10)) ->> 'reason' = 'onset_date:date_future', 'an onset in the future is refused');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","onset_date":"1899-12-31"}') ->> 'reason' = 'onset_date:date_old', 'nothing before 1900');
select test.ok(public.share_contribute(:'sa', 'conditions', '{"name":"Caries","onset_date":"1980-01-01"}') ->> 'reason' = 'onset_date:date_dob', 'nothing before the patient was born');
select test.ok(public.share_contribute(:'sa', 'conditions', jsonb_build_object('name', 'Caries', 'onset_date', current_date - 10, 'resolved_date', current_date - 20)) ->> 'reason' = 'resolved_date:date_order',
  'resolved before onset is refused');
select test.ok(public.share_contribute(:'sa', 'procedures', jsonb_build_object('name', 'Filling', 'performed_on', current_date + 3)) ->> 'reason' = 'performed_on:date_future', 'a procedure that has not happened is refused');
select test.ok(public.share_contribute(:'sa', 'encounters', jsonb_build_object('started_at', now() + interval '2 days')) ->> 'reason' = 'started_at:date_future', 'a completed visit cannot start in the future');
select test.ok(public.share_contribute(:'sa', 'encounters', jsonb_build_object('started_at', now() + interval '2 days', 'status', 'planned')) ->> 'status' = 'ok', 'a planned visit can');
select test.ok(public.share_contribute(:'sa', 'encounters', jsonb_build_object('started_at', now() - interval '3 hours', 'ended_at', now() - interval '4 hours')) ->> 'reason' = 'ended_at:date_order', 'a visit cannot end before it starts');
select test.ok(public.share_contribute(:'sa', 'encounters', jsonb_build_object('started_at', now() - interval '3 hours', 'follow_up_date', current_date - 30)) ->> 'reason' like 'follow_up_date:%', 'a follow-up is not in the past');
select test.ok(public.share_contribute(:'sa', 'encounters', jsonb_build_object('started_at', now() - interval '3 hours', 'follow_up_date', current_date + 14)) ->> 'status' = 'ok', 'a follow-up in two weeks is fine');
select test.ok(public.share_contribute(:'sa', 'appointments', jsonb_build_object('scheduled_at', now() - interval '3 days')) ->> 'reason' = 'scheduled_at:date_past', 'a scheduled appointment must be today or later');
select test.ok(public.share_contribute(:'sa', 'appointments', jsonb_build_object('scheduled_at', now() + interval '4000 days')) ->> 'reason' = 'scheduled_at:date_far', 'nor ten years ahead');
select test.ok(public.share_contribute(:'sa', 'appointments', jsonb_build_object('scheduled_at', now() + interval '3 days', 'reason', 'Review')) ->> 'status' = 'ok', 'an appointment next week is fine');
select test.ok(public.share_contribute(:'sa', 'appointments', jsonb_build_object('scheduled_at', now() - interval '3 days', 'status', 'completed')) ->> 'status' = 'ok', 'an attended one may be in the past');
select test.ok(public.share_contribute(:'sa', 'medications', jsonb_build_object('name_generic', 'Amoxicillin', 'start_date', current_date - 5, 'end_date', current_date - 9)) ->> 'reason' = 'end_date:date_order',
  'a medicine cannot stop before it starts');
select test.ok(public.share_contribute(:'sa', 'imaging_studies', jsonb_build_object('modality', 'panoramic', 'performed_on', current_date + 1 + 1)) ->> 'reason' = 'performed_on:date_future', 'an X-ray cannot be dated in the future');
-- the period the link covers
select test.ok(public.share_contribute(:'sb', 'procedures', jsonb_build_object('name', 'Filling', 'performed_on', current_date)) ->> 'reason' = 'performed_on:date_range', 'a procedure outside the link''s period is refused');
select test.ok(public.share_contribute(:'sb', 'procedures', jsonb_build_object('name', 'Filling', 'performed_on', current_date - 100)) ->> 'reason' = 'performed_on:date_range', 'before it too');
select test.ok(public.share_contribute(:'sb', 'procedures', jsonb_build_object('name', 'Filling', 'performed_on', current_date - 10)) ->> 'status' = 'ok', 'inside it is fine');
select test.ok(public.share_contribute(:'sb', 'encounters', jsonb_build_object('started_at', now())) ->> 'reason' = 'started_at:date_range', 'a visit outside the period is refused');

-- ---------------------------------------------------------------- links to other records
select test.ok(public.share_contribute(:'sa', 'clinical_notes', jsonb_build_object('body', 'linked', 'encounter_id', :'e_other')) ->> 'reason' = 'encounter_id:uuid', 'another patient''s visit cannot be linked');
select test.ok(public.share_contribute(:'sa', 'clinical_notes', '{"body":"linked","encounter_id":"not-a-uuid"}') ->> 'reason' = 'encounter_id:uuid', 'a malformed id is refused');
select test.ok(public.share_contribute(:'sa', 'clinical_notes', '{"body":"linked","encounter_id":"00000000-0000-0000-0000-000000000000"}') ->> 'reason' = 'encounter_id:uuid', 'an id that is not one of this link''s visits is refused');

-- ---------------------------------------------------------------- a refusal is not an addition
select test.ok((select coalesce(sum(contribution_count), 0) from public.share_contributors where share_id = :'a_id'::uuid) = :'used0'::int + 8,
  'only the 8 accepted additions were counted: the refusals above used up nothing');
select test.ok((select count(*) = 0 from public.conditions where patient_id = :'pv' and name in ('Caries 16', 'x', 'Car' || chr(7) || 'ies') and notes is null and icd10_code is distinct from 'K02.1'),
  'and nothing of a refused request was written');

-- ---------------------------------------------------------------- the dental exam
select test.ok(public.share_contribute_dental_exam(:'sa', jsonb_build_object('exam_date', current_date + 3), '[{"tooth":16,"status":"present"}]', '[]') ->> 'reason' = 'exam_date:date_future', 'an exam is not dated in the future');
select test.ok(public.share_contribute_dental_exam(:'sa', jsonb_build_object('exam_date', current_date, 'bogus', 1), '[{"tooth":16,"status":"present"}]', '[]') ->> 'reason' = 'exam:keys', 'an exam with an unknown key is refused');
select test.ok(public.share_contribute_dental_exam(:'sa', jsonb_build_object('exam_date', current_date, 'dentition', 'permanent'), '[{"tooth":55,"status":"present"}]', '[]') ->> 'reason' = 'teeth:teeth', 'a primary tooth is not charted in a permanent dentition');
select test.ok(public.share_contribute_dental_exam(:'sa', jsonb_build_object('exam_date', current_date), '[{"tooth":19,"status":"present"}]', '[]') ->> 'reason' = 'teeth:teeth', 'tooth 19 does not exist');
select test.ok(public.share_contribute_dental_exam(:'sa', jsonb_build_object('exam_date', current_date), '[{"tooth":16,"status":"present","x":1}]', '[]') ->> 'reason' = 'teeth:teeth', 'an unknown key on a tooth state is refused');
select test.ok(public.share_contribute_dental_exam(:'sa', jsonb_build_object('exam_date', current_date), '[]', '[{"tooth":16,"kind":"caries","surfaces":["Z"]}]') ->> 'reason' = 'surfaces:enum', 'a surface is one of M D O B L');
select test.ok(public.share_contribute_dental_exam(:'sa', jsonb_build_object('exam_date', current_date, 'notes', repeat('n', 4001)), '[{"tooth":16,"status":"present"}]', '[]') ->> 'reason' = 'notes:long', 'exam notes stop at 4000');
select test.throws(format($$select public.share_contribute_dental_exam(%L, jsonb_build_object('exam_date', current_date), '[]', '[]')$$, :'sa'), 'exam_empty', 'an exam that records nothing is refused');
select test.ok(public.share_contribute_dental_exam(:'sa', jsonb_build_object('exam_date', current_date, 'dentition', 'primary'), '[{"tooth":55,"status":"present"}]', '[]') ->> 'status' = 'ok', 'a primary tooth in a primary dentition is accepted');

-- ---------------------------------------------------------------- the periodontal chart
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date), '[{"tooth":16,"pd":[3,2,25,4,3,7]}]') ->> 'reason' = 'depth:range', 'a pocket depth of 25 mm is refused');
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date), '[{"tooth":16,"pd":[3,2,4]}]') ->> 'reason' = 'depth:format', 'six sites per tooth, no fewer');
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date), '[{"tooth":55,"pd":[3,2,4,4,3,2]}]') ->> 'reason' = 'teeth:teeth', 'primary teeth are not charted');
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date), '[{"tooth":16,"pd":[3,2,4,4,3,2]},{"tooth":16,"pd":[3,2,4,4,3,2]}]') ->> 'reason' = 'teeth:teeth', 'a tooth twice is refused');
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date), '[{"tooth":16,"pd":[3,2,4,4,3,2],"mobility":7}]') ->> 'reason' = 'depth:range', 'mobility is 0 to 3');
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date + 1 + 1), '[{"tooth":16,"pd":[3,2,4,4,3,2]}]') ->> 'reason' = 'exam_date:date_future', 'a chart is not dated in the future');
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date, 'dx_rbl_pct', 140), '[{"tooth":16,"pd":[3,2,4,4,3,2]}]') ->> 'reason' = 'dx_rbl_pct:range', 'bone loss is a percentage');
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date), '[{"tooth":16,"pd":[3,2,4,4,3,2]}]', true) ->> 'status' = 'ok', 'a good chart can be finalised');
select test.ok(public.share_perio_save(:'sa', null, jsonb_build_object('exam_date', current_date), '[]', true) ->> 'status' = 'invalid', 'an empty chart cannot be finalised');

-- ---------------------------------------------------------------- prescriptions: complete lines, sane durations
select test.ok(public.share_prescription_create(:'sa', '{"bogus":1}', '[{"name_generic":"A","dose":"1","frequency":"daily","duration_days":3}]') ->> 'reason' = 'rx:keys', 'a prescription with an unknown key is refused');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"name_generic":"Amoxicillin","dose":"1 capsule","frequency":"daily"}]') ->> 'reason' = 'l0_duration_days:range', 'a line needs a duration');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"name_generic":"Amoxicillin","dose":"1 capsule","frequency":"daily","duration_days":0}]') ->> 'reason' = 'l0_duration_days:range', 'zero days is refused');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"name_generic":"Amoxicillin","dose":"1 capsule","frequency":"daily","duration_days":3651}]') ->> 'reason' = 'l0_duration_days:range', 'ten years and a day is refused');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"name_generic":"Amoxicillin","dose":"1 capsule","frequency":"daily","duration_days":"7"}]') ->> 'reason' = 'l0_duration_days:range', 'a duration that is a string is refused');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"name_generic":"Amoxicillin","frequency":"daily","duration_days":7}]') ->> 'reason' = 'l0_dose:required', 'a line needs a dose or a strength');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"name_generic":"Amoxicillin","dose":"1 capsule","duration_days":7}]') ->> 'reason' = 'l0_frequency:required', 'and a frequency (or "as needed")');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"dose":"1 capsule","frequency":"daily","duration_days":7}]') ->> 'reason' = 'l0_name_generic:required', 'and a medicine name');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"name_generic":"Aspirin","dose":"1","frequency":"daily","duration_days":3,"refills":99}]') ->> 'reason' = 'l0_refills:range', 'refills are 0 to 24');
select test.ok(public.share_prescription_create(:'sa', '{}', jsonb_build_array(jsonb_build_object('name_generic', 'Amoxicillin', 'dose', '1', 'frequency', 'daily', 'duration_days', 3, 'instructions', repeat('i', 2001)))) ->> 'reason' = 'l0_instructions:long', 'instructions stop at 2000');
select test.ok(public.share_prescription_create(:'sa', jsonb_build_object('issued_on', current_date + 2 + 1), '[{"name_generic":"A","dose":"1","frequency":"daily","duration_days":3}]') ->> 'reason' = 'issued_on:date_future', 'a prescription is not dated in the future');
select test.ok(public.share_prescription_create(:'sa', '{}', '[{"name_generic":"Amoxicillin","dose":"1 capsule","frequency":"daily","duration_days":7},{"name_generic":"Ibuprofen","strength":"400 mg","as_needed":true,"duration_days":3}]') ->> 'status' = 'ok',
  'a complete prescription (the second line "as needed") is saved');

-- ---------------------------------------------------------------- consents
select test.ok(public.share_present_consent(:'sa', '{"kind":"treatment","title":"Extraction consent","body":"long enough text","signer_name":"A B","signer_role":"patient","bogus":1}', :'pv' || '/signatures/s1.png') ->> 'reason' = 'consent:keys', 'a consent with an unknown key is refused');
select test.ok(public.share_present_consent(:'sa', '{"kind":"magic","title":"Extraction consent","body":"long enough text","signer_name":"A B","signer_role":"patient"}', :'pv' || '/signatures/s1.png') ->> 'reason' = 'kind:enum', 'a consent kind is one of the list');
select test.ok(public.share_present_consent(:'sa', '{"kind":"treatment","title":"Extraction consent","body":"too short","signer_name":"A B","signer_role":"patient"}', :'pv' || '/signatures/s1.png') ->> 'reason' = 'body:short', 'the text is at least 10 characters');
select test.ok(public.share_present_consent(:'sa', '{"kind":"treatment","title":"E","body":"long enough text","signer_name":"A B","signer_role":"patient"}', :'pv' || '/signatures/s1.png') ->> 'reason' = 'title:short', 'the title is at least 2');
select test.ok(public.share_present_consent(:'sa', '{"kind":"treatment","title":"Extraction consent","body":"long enough text","signer_name":"<b>","signer_role":"patient"}', :'pv' || '/signatures/s1.png') ->> 'reason' = 'signer_name:markup', 'a signer name carries no markup');
select test.ok(public.share_present_consent(:'sa', '{"kind":"treatment","title":"Extraction consent","body":"long enough text","signer_name":"A B","signer_role":"nurse"}', :'pv' || '/signatures/s1.png') ->> 'reason' = 'signer_role:enum', 'the signer is the patient, a guardian or a representative');
select test.ok(public.share_present_consent(:'sa', '{"kind":"treatment","title":"Extraction consent","body":"long enough text","signer_name":"A B","signer_role":"patient"}', :'pv' || '/signatures/../../etc/x.png') ->> 'reason' = 'signature:format', 'a signature path cannot climb out of the folder');
select test.ok(public.share_present_consent(:'sa', '{"kind":"treatment","title":"Extraction consent","body":"long enough text","signer_name":"A B","signer_role":"patient"}', :'po' || '/signatures/s1.png') ->> 'reason' = 'signature:format', 'nor point into another patient''s folder');
select test.ok(public.share_present_consent(:'sa', '{"kind":"treatment","title":"Extraction consent","body":"long enough text","signer_name":"A B","signer_role":"patient"}', :'pv' || '/signatures/s1.png') ->> 'status' = 'ok', 'a complete consent is saved');

-- ---------------------------------------------------------------- treatment: items, costs, status
select test.ok(public.share_contribute_treatment_plan(:'sa', '{"title":"Plan","status":"accepted"}', '[{"catalog_code":"root_canal","teeth":[46]}]') ->> 'reason' = 'plan:keys', 'a plan cannot arrive accepted');
select test.ok(public.share_contribute_treatment_plan(:'sa', '{"title":"Plan"}', '[{"catalog_code":"root_canal","teeth":[99]}]') ->> 'reason' = 'teeth:teeth', 'a treatment on tooth 99 is refused');
select test.ok(public.share_contribute_treatment_plan(:'sa', '{"title":"Plan"}', '[{"catalog_code":"root_canal","phase":99}]') ->> 'reason' = 'phase:range', 'the phase is 1 to 20');
select test.ok(public.share_contribute_treatment_plan(:'sa', '{"title":"Plan"}', '[{"catalog_code":"Root Canal!"}]') ->> 'reason' = 'catalog_code:format', 'a procedure code has its shape');
select test.ok(public.share_contribute_treatment_plan(:'sa', '{"title":"Plan"}', '[{"catalog_code":"root_canal","price":5}]') ->> 'reason' = 'item:keys', 'a treatment with an unknown key is refused');
select test.ok(public.share_contribute_treatment_plan(:'sa', '{"title":"  "}', '[{"catalog_code":"root_canal"}]') ->> 'reason' = 'title:blank', 'a plan needs a title');
select (public.share_contribute_treatment_plan(:'sa', '{"title":"Strict plan"}', '[{"catalog_code":"root_canal","teeth":[46]}]') ->> 'id') as plan \gset
select test.ok(:'plan' is not null, 'a good plan is proposed');
select id as item from public.treatment_items where plan_id = :'plan'::uuid limit 1 \gset
select test.ok(public.share_set_cost(:'sa', :'item'::uuid, -5, 'SAR', 'estimate', null) ->> 'reason' = 'amount:range', 'a negative amount is refused');
select test.ok(public.share_set_cost(:'sa', :'item'::uuid, 100000000000, 'SAR', 'estimate', null) ->> 'reason' = 'amount:range', 'an absurd amount is refused');
select test.ok(public.share_set_cost(:'sa', :'item'::uuid, 12.345, 'SAR', 'estimate', null) ->> 'reason' = 'amount:range', 'more than two decimals is refused');
select test.ok(public.share_set_cost(:'sa', :'item'::uuid, 100, 'XXX', 'estimate', null) ->> 'reason' = 'currency:enum', 'an unknown currency is refused');
select test.ok(public.share_set_cost(:'sa', :'item'::uuid, 100, 'SAR', 'free', null) ->> 'reason' = 'kind:enum', 'an unknown cost kind is refused');
select test.ok(public.share_set_cost(:'sa', :'item'::uuid, 750.50, 'SAR', 'estimate', 'incl. materials') ->> 'status' = 'ok', 'a good cost is saved');
select test.ok(public.share_treatment_item_status(:'sa', :'item'::uuid, 'scheduled', current_date - 5, null) ->> 'reason' = 'date:date_past', 'a treatment is scheduled for today or later');
select test.ok(public.share_treatment_item_status(:'sa', :'item'::uuid, 'flying', null, null) ->> 'reason' = 'status:enum', 'a status is one of the list');
select test.ok(public.share_treatment_item_status(:'sa', :'item'::uuid, 'cancelled', null, repeat('r', 501)) ->> 'reason' = 'reason:long', 'a reason stops at 500');

-- ---------------------------------------------------------------- amendments and withdrawals
select (public.share_contribute(:'sa', 'clinical_notes', '{"body":"first note"}') ->> 'id') as n1 \gset
select test.ok(public.share_amend_note(:'sa', :'n1'::uuid, 'amended', 'x') ->> 'status' = 'reason_required', 'an amendment needs a reason of 3 characters');
select test.ok(public.share_amend_note(:'sa', :'n1'::uuid, '   ', 'clarify') ->> 'reason' = 'body:blank', 'and a text');
select test.ok(public.share_amend_note(:'sa', :'n1'::uuid, 'amended text', 'clarify the wording') ->> 'status' = 'ok', 'a good amendment is saved');
select test.ok(public.share_retract(:'sa', 'clinical_notes', :'n1'::uuid, 'ab') ->> 'status' = 'reason_required', 'a withdrawal needs a reason');
select test.ok(public.share_retract(:'sa', 'clinical_notes', :'n1'::uuid, repeat('r', 401)) ->> 'reason' = 'reason:long', 'a reason stops at 400');
select test.ok(public.share_retract(:'sa', 'clinical_notes', :'n1'::uuid, 'wrong chart') ->> 'status' = 'ok', 'a good withdrawal works');

-- ---------------------------------------------------------------- the patient's note box
select test.ok(public.share_add_note(:'sa', 'Dr <b>X</b>', 'a note') ->> 'reason' = 'author_name:markup', 'a note author carries no markup');
select test.ok(public.share_add_note(:'sa', 'Dr Strict', repeat('n', 4001)) ->> 'reason' = 'body:long', 'a note to the patient stops at 4000');
select test.ok(public.share_add_note(:'sa', 'Dr Strict', 'a note') ->> 'status' = 'ok', 'a good note is sent');

-- ---------------------------------------------------------------- documents: metadata and the per-link caps
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'pv' || '/abc.pdf', 'a/b.pdf', 'application/pdf', 100, repeat('a', 64)) ->> 'reason' = 'file:bad_name', 'a file name with a path is refused');
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'pv' || '/abc.pdf', 'a.exe', 'application/x-msdownload', 100, repeat('a', 64)) ->> 'reason' = 'file:bad_type', 'a type outside PDF, JPG, PNG and WebP is refused');
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'pv' || '/abc.pdf', 'a.pdf', 'application/pdf', 0, repeat('a', 64)) ->> 'reason' = 'file:too_large', 'an empty file is refused');
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'pv' || '/abc.pdf', 'a.pdf', 'application/pdf', 20 * 1024 * 1024 + 1, repeat('a', 64)) ->> 'reason' = 'file:too_large', 'over 20 MB is refused');
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'po' || '/abc.pdf', 'a.pdf', 'application/pdf', 100, repeat('a', 64)) ->> 'reason' = 'file:format', 'a storage path in another patient''s folder is refused');
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'pv' || '/../abc.pdf', 'a.pdf', 'application/pdf', 100, repeat('a', 64)) ->> 'reason' = 'file:format', 'a path that climbs is refused');
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'pv' || '/abc.pdf', 'a.pdf', 'application/pdf', 100, 'xyz') ->> 'reason' = 'file:format', 'a checksum has its shape');
select test.ok(public.share_register_document(:'sa', 'Report', 'weird', :'pv' || '/abc.pdf', 'a.pdf', 'application/pdf', 100, repeat('a', 64)) ->> 'reason' = 'doc_type:enum', 'a document type is one of the list');
select test.ok(public.share_register_document(:'sa', '', 'other', :'pv' || '/abc.pdf', 'a.pdf', 'application/pdf', 100, repeat('a', 64)) ->> 'reason' = 'title:required', 'a document has a title');
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'pv' || '/abc.pdf', 'a.pdf', 'application/pdf', 100, repeat('a', 64), null, current_date + 1 + 1) ->> 'reason' = 'document_date:date_future', 'a document is not dated in the future');
select test.ok(public.share_register_document(:'sa', 'Report', 'other', :'pv' || '/abc.pdf', 'a.pdf', 'application/pdf', 100, repeat('a', 64)) ->> 'status' = 'ok', 'a good document is registered');
select test.ok((select count(*) filter (where r ->> 'status' = 'ok') = 4 from (select public.share_register_document(:'sa', 'Big ' || g, 'other', :'pv' || '/big' || g || '.pdf', 'big.pdf', 'application/pdf', 20 * 1024 * 1024, repeat('b', 64)) as r from generate_series(1, 5) g) x),
  'files up to the link''s total (100 MB) are accepted: 99.99 MB were used before the fifth');
select test.ok(public.share_register_document(:'sa', 'Big 6', 'other', :'pv' || '/big6.pdf', 'big.pdf', 'application/pdf', 20 * 1024 * 1024, repeat('b', 64)) ->> 'status' = 'limit_bytes', 'beyond 100 MB in all, a link takes no more');

-- ---------------------------------------------------------------- double submit and the burst limit
select test.ok(public.share_claim_submission(:'sa', repeat('c', 64)) ->> 'status' = 'ok', 'the first submission of a key is claimed');
select test.ok(public.share_claim_submission(:'sa', repeat('c', 64)) ->> 'status' = 'duplicate', 'the same key within seconds is a duplicate (a double click)');
select public.share_release_submission(:'sa', repeat('c', 64));
select test.ok(public.share_claim_submission(:'sa', repeat('c', 64)) ->> 'status' = 'ok', 'a released key (a refused submission) can be claimed again');
select test.ok(public.share_claim_submission(:'sa', 'not-hex') ->> 'status' = 'invalid', 'a malformed key is refused');
select test.ok(public.share_claim_submission('not-a-session-token-at-all-xxxxxxxx', repeat('d', 64)) ->> 'status' = 'expired', 'an unknown session cannot claim');
select test.ok((select count(*) filter (where r ->> 'status' = 'ok') >= 1 and count(*) filter (where r ->> 'status' = 'rate_limited') >= 1
                  from (select public.share_claim_submission(:'sa', lpad(to_hex(g), 64, '0')) as r from generate_series(1, 60) g) x), 'more than 30 submission keys a minute are refused');

select test.as_user(:'alice'::uuid);
select public.share_create(p_patient => :'pv', p_title => 'Burst', p_scope_kind => 'full', p_expires_at => now() + interval '2 days', p_allow_contribute => true,
  p_contribute_modules => array['clinical_notes'], p_clinician => '{"name":"Dr Burst"}') as c \gset
select test.as_service();
select (:'c'::jsonb ->> 'token') as c_tok, (:'c'::jsonb ->> 'pin') as c_pin, (:'c'::jsonb ->> 'share_id') as c_id \gset
select (public.share_open(:'c_tok', :'c_pin', 'ip-v3', 'UA') ->> 'session_token') as sc \gset
select public.share_confirm_clinician(:'sc');
select test.ok((select count(*) filter (where r ->> 'status' = 'ok') = 30 from (select public.share_contribute(:'sc', 'clinical_notes', jsonb_build_object('body', 'burst note ' || g)) as r from generate_series(1, 30) g) x),
  '30 additions in a minute are accepted');
select test.throws(format($$select public.share_contribute(%L, 'clinical_notes', '{"body":"the 31st"}')$$, :'sc'), 'rate_limited', 'the 31st in the same minute is refused');
select test.ok((select coalesce(sum(contribution_count), 0) = 30 from public.share_contributors where share_id = :'c_id'::uuid) and not exists (select 1 from public.clinical_notes where body = 'the 31st'),
  'and it is rolled back whole: no record, no count');
