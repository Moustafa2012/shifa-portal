\pset tuples_only on
\set alice 'a1111111-1111-1111-1111-111111111111'
\set bob 'b2222222-2222-2222-2222-222222222222'
\set carol 'c3333333-3333-3333-3333-333333333333'
select id as s_dent from public.medical_specialties where code = 'dentistry' \gset
select id as s_card from public.medical_specialties where code = 'cardiology' \gset

select test.as_user(:'alice'::uuid);
select public.create_patient('Rx Patient', date '1985-05-05', 'female', null, null, null, null, null, null, 'self', true) as pr \gset
select public.create_patient('Rx Other Patient', date '1990-01-01', 'male', null, null, null, null, null, null, 'self', true) as po \gset

-- ============================================================================================================ prescriptions
select public.prescription_create(:'pr',
  jsonb_build_object('prescriber_name', 'Dr Reem Saleh', 'prescriber_license', 'DEN-9', 'facility_name', 'Smile Clinic', 'specialty_id', :'s_dent', 'notes', 'after the extraction'),
  jsonb_build_array(
    jsonb_build_object('name_generic', 'Amoxicillin', 'strength', '500 mg', 'form', 'capsule', 'dose', '1 capsule', 'route', 'oral', 'frequency', 'three times a day',
                       'quantity', '21 capsules', 'duration_days', 7, 'refills', 0, 'instructions', 'after food', 'indication', 'infection'),
    jsonb_build_object('name_brand', 'Brufen', 'name_generic', 'Ibuprofen', 'strength', '400 mg', 'frequency', 'twice a day', 'as_needed', true, 'quantity', '10 tablets',
                       'duration_days', 3, 'refills', 1))) as rx \gset
select test.ok((select prescriber_name = 'Dr Reem Saleh' and status = 'active' and issued_on = current_date and specialty_id = :'s_dent'::uuid and source = 'self' and contributed_by is null
                  from public.prescriptions where id = :'rx'), 'a prescription is written with its prescriber, clinic and date');
select test.ok((select count(*) = 2 from public.medications where prescription_id = :'rx' and origin = 'prescribed' and status = 'active' and start_date = current_date
                  and prescriber_name = 'Dr Reem Saleh' and specialty_id = :'s_dent'::uuid and record_status = 'active'),
  'writing one writes its medication lines in one call: prescribed, active, starting on the day of issue');
select test.ok((select end_date = current_date + 6 and quantity = '21 capsules' and duration_days = 7 and refills = 0 and frequency = 'three times a day' and route = 'oral'
                  from public.medications where prescription_id = :'rx' and name_generic = 'Amoxicillin'),
  'each line carries quantity, duration, refills, frequency and route; the end date follows from the duration');
select test.ok((select as_needed and refills = 1 and end_date = current_date + 2 from public.medications where prescription_id = :'rx' and name_brand = 'Brufen'), 'an as-needed line with refills');
select test.ok((select count(*) = 1 from public.audit_logs where table_name = 'prescriptions' and record_id = :'rx' and action = 'insert' and actor_id = :'alice'::uuid), 'the prescription is audited');

select test.throws(format($$select public.prescription_create(%L, '{"prescriber_name":"Dr X"}', '[]')$$, :'pr'), 'prescription_needs_lines', 'a prescription needs at least one line');
select test.throws(format($$select public.prescription_create(%L, '{"prescriber_name":"Dr X"}', '[{"strength":"5 mg"}]')$$, :'pr'), 'medication_name_required', 'every line needs a medicine name');
select test.throws(format($$select public.prescription_create(%L, '{"prescriber_name":""}', '[{"name_generic":"Aspirin"}]')$$, :'pr'), 'prescriber_required', 'a prescription names its prescriber');
select test.throws(format($$select public.prescription_create(%L, jsonb_build_object('prescriber_name', 'Dr X', 'issued_on', current_date + 30), '[{"name_generic":"Aspirin"}]')$$, :'pr'),
  'date_in_future', 'a prescription is not dated in the future');
select test.throws(format($$select public.prescription_create(%L, '{"prescriber_name":"Dr X"}', '[{"name_generic":"Aspirin","duration_days":0}]')$$, :'pr'), 'check constraint|violates', 'the duration is at least a day');
select test.throws(format($$select public.prescription_create(%L, '{"prescriber_name":"Dr X"}', (select jsonb_agg(jsonb_build_object('name_generic', 'Drug ' || g)) from generate_series(1, 21) g))$$, :'pr'),
  'prescription_too_long', 'at most 20 lines');
select test.ok((select count(*) = 1 from public.prescriptions where patient_id = :'pr'), 'a refused prescription leaves nothing behind');

-- isolation
select test.as_user(:'bob'::uuid);
select test.ok((select count(*) = 0 from public.prescriptions where patient_id = :'pr'), 'another account sees no prescription');
select test.throws(format($$select public.prescription_create(%L, '{"prescriber_name":"Dr X"}', '[{"name_generic":"Aspirin"}]')$$, :'pr'), 'forbidden|42501', 'nor writes one into the file');
select test.throws(format($$insert into public.prescriptions (patient_id, prescriber_name) values (%L, 'Dr X')$$, :'pr'), 'row-level security|42501', 'nor inserts one directly');
select test.throws(format($$select public.prescription_set_status(%L, 'cancelled', 'x y z')$$, :'rx'), 'not_found', 'nor changes its status');
select test.as_anon();
select test.throws($$select count(*) from public.prescriptions$$, 'permission denied|42501', 'anonymous visitors have no access to prescriptions');
select test.throws($$select count(*) from public.consents$$, 'permission denied|42501', 'nor to consents');
select test.as_user(:'alice'::uuid);

-- life cycle: the prescription is never deleted; it is completed or cancelled (with a reason), and the lines follow
select test.throws(format($$delete from public.prescriptions where id = %L$$, :'rx'), 'permission denied|42501', 'a prescription cannot be deleted');
select test.throws(format($$delete from public.medications where prescription_id = %L$$, :'rx'), 'permission denied|42501', 'nor its medication lines');
select test.ok((select count(*) = 1 from public.prescriptions where id = :'rx') and (select count(*) = 2 from public.medications where prescription_id = :'rx'), 'both are still there');
select test.throws(format($$update public.prescriptions set prescriber_name = 'Someone else' where id = %L$$, :'rx'), 'immutable', 'the prescriber is fixed');
select test.throws(format($$update public.prescriptions set issued_on = current_date - 5 where id = %L$$, :'rx'), 'immutable', 'and so is the date');
select test.throws(format($$select public.prescription_set_status(%L, 'cancelled')$$, :'rx'), 'check constraint|violates', 'cancelling needs a reason');
select test.throws(format($$select public.prescription_set_status(%L, 'active', 'x')$$, :'rx'), 'invalid_transition', 'it cannot be set back to active');
select public.prescription_create(:'pr', '{"prescriber_name":"Dr Second","specialty_id":null}', '[{"name_generic":"Paracetamol","dose":"500 mg","frequency":"every 6 hours","duration_days":5}]') as rx2 \gset
select public.prescription_set_status(:'rx2', 'cancelled', 'the patient reacted badly');
select test.ok((select status = 'cancelled' and status_reason = 'the patient reacted badly' from public.prescriptions where id = :'rx2')
               and (select status = 'stopped' and stopped_by = 'clinician' and stop_reason = 'the patient reacted badly' and end_date >= start_date
                      from public.medications where prescription_id = :'rx2'),
  'cancelling closes the prescription with its reason and stops its lines');
select test.throws(format($$select public.prescription_set_status(%L, 'completed')$$, :'rx2'), 'invalid_transition', 'a cancelled prescription does not move again');
select test.throws(format($$update public.prescriptions set notes = 'late edit' where id = %L$$, :'rx2'), 'prescription_closed', 'nor is it edited');
select test.throws(format($$insert into public.medications (patient_id, prescription_id, name_generic) values (%L, %L, 'Late line')$$, :'pr', :'rx2'),
  'prescription_closed', 'a line is not added to a closed prescription');
select test.throws(format($$update public.medications set prescription_id = null where prescription_id = %L$$, :'rx'), 'immutable', 'a line stays with its prescription');
select public.prescription_set_status(:'rx', 'completed');
select test.ok((select status = 'completed' from public.prescriptions where id = :'rx')
               and (select count(*) = 2 from public.medications where prescription_id = :'rx' and status = 'completed' and stopped_by = 'course_completed' and end_date >= start_date),
  'completing it completes the lines');
select public.prescription_create(:'pr', '{"prescriber_name":"Dr Mistaken"}', '[{"name_generic":"Wrong drug"}]') as rx3 \gset
update public.prescriptions set record_status = 'entered_in_error', invalidated_reason = 'wrong patient' where id = :'rx3';
select test.ok((select record_status = 'entered_in_error' from public.medications where prescription_id = :'rx3'), 'a prescription entered in error takes its lines with it');
select test.throws(format($$update public.prescriptions set notes = 'x' where id = %L$$, :'rx3'), 'entered-in-error|cannot be modified', 'and is then read only');

-- ============================================================================================================ consents
select public.treatment_plan_create(:'pr', '{"title":"Consent plan"}',
  jsonb_build_array(jsonb_build_object('catalog_code', 'extraction_simple', 'teeth', jsonb_build_array(38)), jsonb_build_object('catalog_code', 'scaling'))) as pl \gset
select id as it_ext from public.treatment_items where plan_id = :'pl' and catalog_code = 'extraction_simple' \gset
select public.treatment_plan_create(:'pr', '{"title":"Second plan"}', '[{"catalog_code":"fluoride"}]') as pl2 \gset
select public.treatment_plan_create(:'po', '{"title":"Other plan"}', '[{"catalog_code":"scaling"}]') as pl_other \gset
select :'pr' || '/signatures/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png' as sig1 \gset
select :'pr' || '/signatures/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png' as sig2 \gset
select public.consent_create(:'pr',
  jsonb_build_object('kind', 'surgery', 'title', 'Consent to extraction', 'body', 'I understand the extraction of tooth 38, its risks and alternatives.',
                     'treatment_plan_id', :'pl', 'treatment_item_id', :'it_ext', 'signer_name', 'Rx Patient', 'signer_role', 'patient', 'witness_name', 'Nurse Huda',
                     'specialty_id', :'s_dent'), :'sig1') as c1 \gset
select test.ok((select status = 'signed' and version = 1 and kind = 'surgery' and treatment_plan_id = :'pl'::uuid and treatment_item_id = :'it_ext'::uuid and signer_role = 'patient'
                  and signature_path = :'sig1' and signed_at is not null and witness_name = 'Nurse Huda' and body like 'I understand%' and recorded_by = :'alice'::uuid
                  from public.consents where id = :'c1'), 'a consent keeps the text as signed, who signed in what role, the witness, the plan and treatment it covers, and the drawn signature');
select test.ok((select count(*) = 1 from public.audit_logs where table_name = 'consents' and record_id = :'c1' and action = 'insert'), 'the consent is audited');
select public.consent_create(:'pr', jsonb_build_object('kind', 'anesthesia', 'title', 'Anaesthesia', 'body', 'Local anaesthesia explained.', 'signer_name', 'Parent Name', 'signer_role', 'guardian'),
  :'sig2') as c_an \gset
select test.ok((select treatment_plan_id is null and signer_role = 'guardian' from public.consents where id = :'c_an'), 'a consent need not cover a plan; a guardian can sign');

select test.throws(format($$select public.consent_create(%L, '{"kind":"surgery","title":"Bad","body":"text here for the consent","signer_name":"A B","signer_role":"patient"}', %L)$$, :'pr', :'po' || '/signatures/cccccccc-cccc-cccc-cccc-cccccccccccc.png'),
  'check constraint|violates', 'the signature must be in the patient''s own folder');
select test.throws(format($$select public.consent_create(%L, '{"kind":"surgery","title":"Bad","body":"text here for the consent","signer_name":"A B","signer_role":"nurse"}', %L)$$, :'pr', :'sig2'),
  'check constraint|violates', 'the signer is a patient, guardian or representative');
select test.throws(format($$select public.consent_create(%L, '{"kind":"magic","title":"Bad","body":"text here for the consent","signer_name":"A B","signer_role":"patient"}', %L)$$, :'pr', :'sig2'),
  'check constraint|violates', 'the kind is one of the known ones');
select test.throws(format($$select public.consent_create(%L, jsonb_build_object('kind', 'treatment', 'title', 'Bad', 'body', 'text here for the consent', 'signer_name', 'A B', 'signer_role', 'patient', 'treatment_plan_id', %L), %L)$$,
  :'pr', :'pl_other', :'sig2'), 'foreign key|violates', 'a consent covers a plan of this patient only');
select test.throws(format($$select public.consent_create(%L, jsonb_build_object('kind', 'treatment', 'title', 'Bad', 'body', 'text here for the consent', 'signer_name', 'A B', 'signer_role', 'patient',
  'treatment_item_id', (select id from public.treatment_items where plan_id = %L and catalog_code = 'scaling')), %L)$$, :'pr', :'pl_other', :'sig2'), 'foreign key|violates', 'nor an item of another patient''s plan');
select test.throws(format($$select public.consent_create(%L, jsonb_build_object('kind', 'treatment', 'title', 'Bad', 'body', 'text here for the consent', 'signer_name', 'A B', 'signer_role', 'patient',
  'treatment_plan_id', %L, 'treatment_item_id', (select id from public.treatment_items where plan_id = %L)), %L)$$, :'pr', :'pl', :'pl2', :'sig2'),
  'consent_plan_mismatch', 'the treatment must belong to the plan named');

-- never rewritten, never deleted
select test.throws(format($$update public.consents set body = 'rewritten' where id = %L$$, :'c1'), 'consent_signed', 'a signed consent is not rewritten');
select test.throws(format($$update public.consents set signature_path = %L where id = %L$$, :'sig2', :'c1'), 'consent_signed', 'nor its signature swapped');
select test.throws(format($$update public.consents set signer_name = 'Someone Else' where id = %L$$, :'c1'), 'consent_signed', 'nor the signer changed');
select test.throws(format($$update public.consents set signed_at = now() - interval '5 days' where id = %L$$, :'c1'), 'consent_signed', 'nor the time of signing');
select test.throws(format($$delete from public.consents where id = %L$$, :'c1'), 'permission denied|42501', 'a consent cannot be deleted');
select test.ok((select count(*) = 1 from public.consents where id = :'c1'), 'and is still there');

-- isolation
select test.as_user(:'bob'::uuid);
select test.ok((select count(*) = 0 from public.consents where patient_id = :'pr'), 'another account sees no consent');
select test.throws(format($$select public.consent_withdraw(%L, 'not mine to withdraw')$$, :'c1'), 'not_found', 'nor withdraws one');
select test.throws(format($$select public.consent_create(%L, '{"kind":"treatment","title":"Fake","body":"text here for the consent","signer_name":"A B","signer_role":"patient"}', %L)$$, :'pr', :'sig2'),
  'forbidden|42501', 'nor signs one into the file');
select test.as_user(:'alice'::uuid);

-- withdraw with a reason; a new version supersedes
select test.throws(format($$select public.consent_withdraw(%L, 'no')$$, :'c_an'), 'reason_required', 'withdrawing needs a reason');
select public.consent_withdraw(:'c_an', 'I changed my mind about sedation');
select test.ok((select status = 'withdrawn' and withdrawn_at is not null and withdrawn_by = :'alice'::uuid and withdrawn_reason = 'I changed my mind about sedation'
                  and body = 'Local anaesthesia explained.' from public.consents where id = :'c_an'), 'a withdrawn consent keeps its text and signature, with who, when and why');
select test.throws(format($$select public.consent_withdraw(%L, 'again please')$$, :'c_an'), 'invalid_transition', 'a withdrawn consent does not move again');
select test.throws(format($$update public.consents set status = 'signed' where id = %L$$, :'c_an'), 'invalid_transition', 'nor is it signed again');
select test.throws(format($$update public.consents set withdrawn_reason = 'rewritten history' where id = %L$$, :'c_an'), 'consent_signed|invalid_transition', 'nor the reason rewritten');
select test.throws(format($$select public.consent_create(%L, jsonb_build_object('kind', 'anesthesia', 'title', 'Anaesthesia v2', 'body', 'new text', 'signer_name', 'Parent Name', 'signer_role', 'guardian', 'supersedes', %L), %L)$$,
  :'pr', :'c_an', :'sig2'), 'consent_not_signed', 'a withdrawn consent is not superseded');

select :'pr' || '/signatures/dddddddd-dddd-dddd-dddd-dddddddddddd.png' as sig3 \gset
select test.throws(format($$select public.consent_create(%L, jsonb_build_object('kind', 'treatment', 'title', 'Wrong kind', 'body', 'new text', 'signer_name', 'Rx Patient', 'signer_role', 'patient', 'supersedes', %L), %L)$$,
  :'pr', :'c1', :'sig3'), 'consent_kind_mismatch', 'a new version is of the same kind');
select public.consent_create(:'pr', jsonb_build_object('kind', 'surgery', 'title', 'Consent to extraction (v2)', 'body', 'Updated text: tooth 38 and 48.', 'signer_name', 'Rx Patient',
  'signer_role', 'patient', 'supersedes', :'c1', 'specialty_id', :'s_dent'), :'sig3') as c1b \gset
select test.ok((select version = 2 and status = 'signed' and supersedes = :'c1'::uuid and treatment_item_id = :'it_ext'::uuid from public.consents where id = :'c1b'),
  'a new version counts on from the old one and keeps what it covers');
select test.ok((select status = 'superseded' and superseded_by = :'c1b'::uuid and superseded_at is not null and body like 'I understand%' from public.consents where id = :'c1'),
  'the old version is closed, points to the new one and keeps its text');
select test.throws(format($$select public.consent_create(%L, jsonb_build_object('kind', 'surgery', 'title', 'Again', 'body', 'new text', 'signer_name', 'Rx Patient', 'signer_role', 'patient', 'supersedes', %L), %L)$$,
  :'pr', :'c1', :'sig3'), 'consent_not_signed', 'a superseded consent is not superseded twice');
select test.throws(format($$update public.consents set status = 'superseded', superseded_by = %L, superseded_at = now() where id = %L$$, :'c1b', :'c_an'),
  'invalid_transition', 'superseding is done by signing a new version, not by hand');
select test.ok((select count(*) = 3 from public.consents where patient_id = :'pr'), 'nothing was deleted along the way');

-- ============================================================================================================ the share link
select public.share_create(p_patient => :'pr', p_title => 'Dentist rx', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_expires_at => now() + interval '1 day', p_allow_contribute => true, p_contribute_modules => array['prescriptions', 'consents'],
  p_clinician => '{"name":"Dr Lina Prescriber","specialty":"Dentist","facility":"Molar Clinic","license":"LIC-77"}') as sh \gset
select (:'sh'::jsonb ->> 'token') as tok, (:'sh'::jsonb ->> 'pin') as pin, (:'sh'::jsonb ->> 'share_id') as sh_id \gset
select public.share_create(p_patient => :'pr', p_title => 'Read only dentist', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_expires_at => now() + interval '1 day', p_allow_contribute => true, p_contribute_modules => array['encounters'], p_clinician => '{"name":"Dr No Rx"}') as sh_n \gset
select (:'sh_n'::jsonb ->> 'token') as tok_n, (:'sh_n'::jsonb ->> 'pin') as pin_n \gset
select public.share_create(p_patient => :'pr', p_title => 'Cardio rx', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_card'::uuid],
  p_expires_at => now() + interval '1 day', p_allow_contribute => true, p_contribute_modules => array['prescriptions', 'consents'], p_clinician => '{"name":"Dr Heart Rx"}') as sh_c \gset
select (:'sh_c'::jsonb ->> 'token') as tok_c, (:'sh_c'::jsonb ->> 'pin') as pin_c \gset
select test.as_service();
select (public.share_open(:'tok', :'pin', 'ip-rx1', 'UA') ->> 'session_token') as sess \gset
select (public.share_open(:'tok_n', :'pin_n', 'ip-rx2', 'UA') ->> 'session_token') as sess_n \gset
select (public.share_open(:'tok_c', :'pin_c', 'ip-rx3', 'UA') ->> 'session_token') as sess_c \gset

select test.ok(public.share_prescription_create(:'sess', '{}', '[{"name_generic":"Aspirin"}]') ->> 'status' = 'identify_first', 'the doctor confirms who they are before writing a prescription');
select (public.share_confirm_clinician(:'sess') ->> 'contributor_id') as ctr \gset
select (public.share_confirm_clinician(:'sess_n') ->> 'contributor_id') as ctr_n \gset
select (public.share_confirm_clinician(:'sess_c') ->> 'contributor_id') as ctr_c \gset
select test.ok(public.share_prescription_create(:'sess_n', '{}', '[{"name_generic":"Aspirin"}]') ->> 'status' = 'forbidden', 'a link that does not allow prescriptions refuses them');
select test.ok(public.share_present_consent(:'sess_n', '{"kind":"treatment","title":"T","body":"text here for the consent","signer_name":"A B","signer_role":"patient"}', :'pr' || '/signatures/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.png') ->> 'status' = 'forbidden',
  'nor consents');
select test.ok(public.share_prescription_create(:'sess', '{}', '[]') ->> 'status' = 'invalid', 'an empty prescription is invalid');
select test.ok(public.share_prescription_create(:'sess', '{}', '[{"strength":"5 mg"}]') ->> 'status' = 'invalid' , 'a line without a medicine name is invalid');
select test.ok(public.share_prescription_create('not-a-session-token-at-all-xxxxxxxx', '{}', '[{"name_generic":"x"}]') ->> 'status' = 'expired', 'an unknown session is refused');

select test.ok(public.share_prescription_create(:'sess', jsonb_build_object('prescriber_name', 'Forged Name', 'specialty_id', :'s_card', 'status', 'cancelled'),
  '[{"name_generic":"Aspirin","dose":"100 mg","frequency":"daily","duration_days":5}]') ->> 'status' = 'invalid', 'a prescription payload carrying a status or specialty key is refused (0033)');
select (public.share_prescription_create(:'sess',
  jsonb_build_object('prescriber_name', 'Forged Name', 'prescriber_license', 'FORGED', 'notes', 'from the link'),
  jsonb_build_array(jsonb_build_object('name_generic', 'Metronidazole', 'strength', '400 mg', 'frequency', 'three times a day', 'quantity', '15 tablets', 'duration_days', 5, 'refills', 0),
                    jsonb_build_object('name_generic', 'Chlorhexidine', 'form', 'other', 'dose', '15 ml', 'frequency', 'twice a day', 'duration_days', 7))) ->> 'id') as srx \gset
select test.as_super();
select test.ok((select prescriber_name = 'Dr Lina Prescriber' and prescriber_license = 'LIC-77' and facility_name = 'Molar Clinic' and contributed_by = :'ctr'::uuid and source = 'clinic'
                   and verification = 'confirmed' and status = 'active' and specialty_id = :'s_dent'::uuid and notes = 'from the link' from public.prescriptions where id = :'srx'),
  'the prescriber is the doctor the patient named on the link, whatever the form says; a specialty share writes into that specialty');
select test.ok((select count(*) = 2 from public.medications where prescription_id = :'srx' and contributed_by = :'ctr'::uuid and prescriber_name = 'Dr Lina Prescriber' and origin = 'prescribed' and status = 'active'),
  'its lines are written under the doctor''s name');
select test.ok((select contribution_count = 1 from public.share_contributors where id = :'ctr'::uuid), 'a prescription counts as one addition');
select test.ok((select count(*) = 1 from public.audit_logs where table_name = 'prescriptions' and record_id = :'srx' and actor_kind = 'share_contributor' and actor_id = :'ctr'::uuid), 'the audit names the doctor as the actor');
select test.ok((select count(*) = 1 from public.medical_share_access_logs where share_id = :'sh_id'::uuid and event = 'contribution_added' and detail ->> 'table' = 'prescriptions'), 'the share log records it');
select test.as_service();

-- a visit to link to must be one this doctor added through this share
select (public.share_contribute(:'sess', 'encounters', '{"kind":"dental","started_at":"2026-01-02T10:00:00Z"}'::jsonb) ->> 'status') as e_st \gset
select test.ok(:'e_st' = 'forbidden', 'the visits module was not granted on this link');
select test.ok(public.share_prescription_create(:'sess', jsonb_build_object('encounter_id', gen_random_uuid()), '[{"name_generic":"Aspirin"}]') ->> 'status' = 'invalid',
  'a prescription links only to a visit this doctor added');

-- what the doctor sees
select public.share_rx_extras(:'sess') as ex \gset
select test.ok((:'ex'::jsonb ->> 'status') = 'ok' and jsonb_array_length(:'ex'::jsonb -> 'prescriptions') = 2, 'the doctor sees the prescriptions in the dental scope (theirs and the patient''s)');
select test.ok(exists (select 1 from jsonb_array_elements(:'ex'::jsonb -> 'prescriptions') x where (x ->> 'mine')::boolean and jsonb_array_length(x -> 'lines') = 2 and x ->> 'prescriber_name' = 'Dr Lina Prescriber'),
  'with their lines, theirs marked');
select test.ok((select jsonb_array_length(public.share_rx_extras(:'sess_n') -> 'prescriptions') = 0 and jsonb_array_length(public.share_rx_extras(:'sess_n') -> 'consents') = 0),
  'a link without those modules shows neither');
select test.ok((select jsonb_array_length(public.share_rx_extras(:'sess_c') -> 'prescriptions') = 0), 'a cardiology link does not show the dental prescriptions');
select test.ok(public.share_rx_extras('not-a-session-token-at-all-xxxxxxxx') ->> 'status' = 'expired', 'an unknown session gets nothing');

-- the doctor withdraws only their own
select test.ok(public.share_retract_prescription(:'sess', :'rx'::uuid, 'not mine to withdraw') ->> 'status' = 'not_found', 'a doctor cannot withdraw a prescription the patient wrote');
select test.ok(public.share_retract_prescription(:'sess_c', :'srx'::uuid, 'not theirs') ->> 'status' = 'not_found', 'nor another doctor''s');
select test.ok(public.share_retract_prescription(:'sess', :'srx'::uuid, 'no') ->> 'status' = 'reason_required', 'withdrawing needs a reason');
select (public.share_prescription_create(:'sess', '{}', '[{"name_generic":"Naproxen","dose":"250 mg","frequency":"twice a day","duration_days":3}]') ->> 'id') as srx2 \gset
select test.ok(public.share_retract_prescription(:'sess', :'srx2'::uuid, 'wrong drug chosen') ->> 'status' = 'ok', 'a doctor withdraws their own prescription');
select test.as_super();
select test.ok((select record_status = 'entered_in_error' and invalidated_reason like '%wrong drug chosen%' from public.prescriptions where id = :'srx2')
               and (select count(*) = 1 and bool_and(record_status = 'entered_in_error') from public.medications where prescription_id = :'srx2'),
  'it stays in the history with the reason and takes its line with it');

-- the patient can complete or cancel a doctor's prescription, not rewrite it
select test.as_user(:'alice'::uuid);
select test.throws(format($$update public.prescriptions set notes = 'patient rewrote it' where id = %L$$, :'srx'), 'contributed_record_readonly', 'a doctor''s prescription is not rewritten by the patient');
select test.throws(format($$update public.medications set dose = '10 tablets' where prescription_id = %L$$, :'srx'), 'contributed_record_readonly', 'nor its lines');
select public.prescription_set_status(:'srx', 'cancelled', 'finished the course early');
select test.ok((select status = 'cancelled' from public.prescriptions where id = :'srx') and (select count(*) = 2 from public.medications where prescription_id = :'srx' and status = 'stopped'),
  'but may cancel it, which stops the lines');

-- invalidating everything one doctor added
select test.as_service();
select (public.share_prescription_create(:'sess', '{}', '[{"name_generic":"Clindamycin","duration_days":7}]') ->> 'id') as srx3 \gset
select test.as_user(:'bob'::uuid);
select test.throws(format($$select public.share_invalidate_prescriptions(%L, 'not mine')$$, :'ctr'), 'forbidden|42501', 'another account cannot invalidate a doctor''s prescriptions');
select test.as_user(:'alice'::uuid);
select test.ok(public.share_invalidate_contributions(:'ctr'::uuid, 'the doctor was not mine') >= 1 and public.share_invalidate_prescriptions(:'ctr'::uuid, 'the doctor was not mine') >= 1,
  'the patient invalidates what a doctor added, medications and prescriptions');
select test.ok((select count(*) = 0 from public.prescriptions where contributed_by = :'ctr'::uuid and record_status = 'active')
               and (select count(*) = 0 from public.medications where contributed_by = :'ctr'::uuid and record_status = 'active'), 'nothing of theirs stays active');

-- consents through the link: the patient signs on the doctor's screen
select test.as_service();
select :'pr' || '/signatures/f0000000-0000-0000-0000-000000000001.png' as dsig1 \gset
select :'pr' || '/signatures/f0000000-0000-0000-0000-000000000002.png' as dsig2 \gset
select test.ok(public.share_present_consent(:'sess',
  jsonb_build_object('kind', 'surgery', 'title', 'Consent to extraction 38', 'body', 'Extraction of 38 explained.', 'signer_name', 'Rx Patient', 'signer_role', 'patient',
                     'treatment_item_id', :'it_ext', 'presented_by', 'Forged Presenter', 'specialty_id', :'s_card'), :'dsig1') ->> 'status' = 'invalid',
  'a consent payload carrying a presenter or specialty key is refused (0033)');
select (public.share_present_consent(:'sess',
  jsonb_build_object('kind', 'surgery', 'title', 'Consent to extraction 38', 'body', 'Extraction of 38 explained.', 'signer_name', 'Rx Patient', 'signer_role', 'patient',
                     'treatment_item_id', :'it_ext', 'witness_name', 'Receptionist'),
  :'dsig1') ->> 'id') as dc1 \gset
select test.as_super();
select test.ok((select presented_by = 'Dr Lina Prescriber' and treatment_plan_id = :'pl'::uuid and treatment_item_id = :'it_ext'::uuid and specialty_id = :'s_dent'::uuid and contributed_by = :'ctr'::uuid
                   and status = 'signed' and signer_name = 'Rx Patient' and signature_path = :'dsig1' and source = 'clinic' and version = 1 from public.consents where id = :'dc1'),
  'a doctor presents a consent for a treatment: the presenter is the named doctor, the plan follows the treatment, the signature is stored under the patient');
select test.ok((select count(*) = 1 from public.audit_logs where table_name = 'consents' and record_id = :'dc1' and actor_kind = 'share_contributor'), 'audited under the doctor');
select test.as_service();
select test.ok(public.share_present_consent(:'sess', jsonb_build_object('kind', 'surgery', 'title', 'Consent T', 'body', 'text here for the consent', 'signer_name', 'A B', 'signer_role', 'patient', 'treatment_item_id', gen_random_uuid()), :'dsig2') ->> 'status' = 'not_found',
  'a treatment that does not exist is not found');
select test.ok(public.share_present_consent(:'sess', jsonb_build_object('kind', 'treatment', 'title', 'Consent T', 'body', 'text here for the consent', 'signer_name', 'A B', 'signer_role', 'patient', 'treatment_plan_id', :'pl_other'), :'dsig2') ->> 'status' = 'not_found',
  'nor a plan of another patient');
select test.ok(public.share_present_consent(:'sess', jsonb_build_object('kind', 'treatment', 'title', 'Consent T', 'body', 'text here for the consent', 'signer_name', 'A B', 'signer_role', 'patient'), :'po' || '/signatures/f0000000-0000-0000-0000-000000000003.png') ->> 'status' = 'invalid',
  'a signature outside this patient''s folder is refused');
select test.ok(public.share_present_consent(:'sess_c', jsonb_build_object('kind', 'treatment', 'title', 'Consent T', 'body', 'text here for the consent', 'signer_name', 'A B', 'signer_role', 'patient', 'treatment_plan_id', :'pl'), :'dsig2') ->> 'status' = 'forbidden',
  'a link that does not cover the dental file cannot present a consent for a dental plan');
select test.ok(public.share_present_consent(:'sess', jsonb_build_object('kind', 'surgery', 'title', 'Consent T', 'body', 'text here for the consent', 'signer_name', 'A B', 'signer_role', 'patient', 'supersedes', :'c1b'), :'dsig2') ->> 'status' = 'not_found',
  'a doctor cannot supersede a consent the patient signed themselves');
select test.ok(public.share_present_consent(:'sess', jsonb_build_object('kind', 'surgery', 'title', 'Consent T', 'body', 'short', 'signer_name', 'A B', 'signer_role', 'nurse'), :'dsig2') ->> 'status' = 'invalid',
  'the signer''s role is checked');
select (public.share_present_consent(:'sess',
  jsonb_build_object('kind', 'surgery', 'title', 'Consent to extraction 38 (v2)', 'body', 'Updated explanation.', 'signer_name', 'Rx Patient', 'signer_role', 'patient', 'supersedes', :'dc1'), :'dsig2') ->> 'id') as dc2 \gset
select test.as_super();
select test.ok((select version = 2 and treatment_item_id = :'it_ext'::uuid from public.consents where id = :'dc2') and (select status = 'superseded' and superseded_by = :'dc2'::uuid from public.consents where id = :'dc1'),
  'a doctor supersedes their own consent with a new version');
select test.as_service();
select public.share_rx_extras(:'sess') as ex2 \gset
select test.ok(jsonb_array_length(:'ex2'::jsonb -> 'consents') >= 3 and not (:'ex2'::jsonb::text like '%signature_path%') and not (:'ex2'::jsonb::text like '%Extraction of 38 explained%'),
  'the doctor sees the consents (status, version, signer) without the signature file or the text');
select test.ok(exists (select 1 from jsonb_array_elements(:'ex2'::jsonb -> 'consents') x where x ->> 'id' = :'dc2' and (x ->> 'mine')::boolean and x ->> 'status' = 'signed'), 'theirs marked');

-- the patient withdraws a consent presented through the link; it cannot be rewritten
select test.as_user(:'alice'::uuid);
select test.throws(format($$update public.consents set body = 'edited by the patient' where id = %L$$, :'dc2'), 'consent_signed|contributed_record_readonly', 'a presented consent is not rewritten');
select public.consent_withdraw(:'dc2', 'I do not agree to this extraction');
select test.ok((select status = 'withdrawn' from public.consents where id = :'dc2'), 'but the patient withdraws it');
select test.as_service();
select test.ok(exists (select 1 from jsonb_array_elements(public.share_rx_extras(:'sess') -> 'consents') x where x ->> 'id' = :'dc2' and x ->> 'status' = 'withdrawn'), 'and the doctor sees that it was withdrawn');

-- a revoked link stops everything at once
select test.as_user(:'alice'::uuid);
select public.share_revoke(:'sh_id'::uuid, 'done');
select test.as_service();
select test.ok(public.share_prescription_create(:'sess', '{}', '[{"name_generic":"Late"}]') ->> 'status' = 'expired', 'a revoked link writes no prescription');
select test.ok(public.share_present_consent(:'sess', '{"kind":"treatment","title":"T","body":"text here for the consent","signer_name":"A B","signer_role":"patient"}', :'dsig2') ->> 'status' = 'expired', 'nor presents a consent');
select test.ok(public.share_rx_extras(:'sess') ->> 'status' = 'expired', 'nor shows them');

-- the per-share limit counts both
select test.as_user(:'alice'::uuid);
select public.share_create(p_patient => :'pr', p_title => 'Limited', p_scope_kind => 'full', p_expires_at => now() + interval '1 day', p_allow_contribute => true,
  p_contribute_modules => array['prescriptions'], p_clinician => '{"name":"Dr Limit"}') as sh_l \gset
select (:'sh_l'::jsonb ->> 'token') as tok_l, (:'sh_l'::jsonb ->> 'pin') as pin_l, (:'sh_l'::jsonb ->> 'share_id') as id_l \gset
select test.as_super();
update public.medical_shares set max_contributions = 1 where id = :'id_l'::uuid;
select test.as_service();
select (public.share_open(:'tok_l', :'pin_l', 'ip-rx4', 'UA') ->> 'session_token') as sess_l \gset
select public.share_confirm_clinician(:'sess_l');
select test.ok(public.share_prescription_create(:'sess_l', '{}', '[{"name_generic":"One","dose":"1 tablet","frequency":"daily","duration_days":3}]') ->> 'status' = 'ok', 'the first addition passes');
select test.ok(public.share_prescription_create(:'sess_l', '{}', '[{"name_generic":"Two","dose":"1 tablet","frequency":"daily","duration_days":3}]') ->> 'status' = 'limit', 'the second is over the limit of the link');
select test.as_super();
select test.ok((select specialty_id is null from public.prescriptions where contributed_by = (select id from public.share_contributors where share_id = :'id_l'::uuid) and record_status = 'active'),
  'on a whole-file link the prescription has no specialty unless the form names one');

-- the new modules are accepted on a link, unknown ones are not
select test.as_user(:'alice'::uuid);
select test.throws(format($$select public.share_create(p_patient => %L, p_title => 'Bad', p_scope_kind => 'full', p_allow_contribute => true, p_contribute_modules => array['prescriptions','magic'], p_clinician => '{"name":"Dr Bad"}')$$, :'pr'),
  'check constraint|violates', 'only known modules');
select test.ok((select contribute_modules @> array['prescriptions', 'consents'] from public.medical_shares where id = :'sh_id'::uuid), 'prescriptions and consents are modules a patient can allow');

-- ============================================================================================================ safety rules
select test.as_user(:'bob'::uuid);
select test.ok((select count(*) >= 12 from public.safety_rules where is_active), 'about a dozen dental safety rules are seeded');
select test.ok((select count(*) = 0 from public.safety_rules where reviewed_by is not null), 'none claims to have been reviewed');
select test.ok((select count(distinct severity) = 3 from public.safety_rules), 'with the three severities');
select test.ok(exists (select 1 from public.safety_rules where code = 'anticoagulant_before_surgery' and match -> 'procedures' -> 'categories' ? 'surgical' and match -> 'medications' ? 'warfarin'),
  'the anticoagulant rule is about surgery and names warfarin');
select test.ok((select bool_and(app.safety_match_ok(match)) from public.safety_rules), 'every seeded match is well formed');
select test.throws($$insert into public.safety_rules (code, title_ar, title_en, message_ar, message_en, match) values ('my_rule', 'قاعدة', 'My rule', 'رسالة', 'message', '{"medications":["x1"]}')$$,
  'row-level security', 'an ordinary account cannot add a rule');
update public.safety_rules set is_active = false, message_en = 'rewritten by bob' where code = 'latex_allergy';
select test.ok((select is_active and message_en <> 'rewritten by bob' from public.safety_rules where code = 'latex_allergy'), 'nor change one (the update touches nothing)');
select test.throws($$delete from public.safety_rules where code = 'latex_allergy'$$, 'permission denied|42501', 'nor delete one');
select test.as_anon();
select test.throws($$select count(*) from public.safety_rules$$, 'permission denied|42501', 'anonymous visitors cannot read the rules');

select test.as_user(:'carol'::uuid);
select test.ok((select version = 1 and reviewed_by is null from public.safety_rules where code = 'latex_allergy'), 'a rule starts unreviewed, at version 1');
update public.safety_rules set reviewed_by = :'bob'::uuid, reviewed_at = '2001-01-01' where code = 'latex_allergy';
select test.ok((select reviewed_by = :'carol'::uuid and reviewed_at > now() - interval '1 minute' and version = 1 from public.safety_rules where code = 'latex_allergy'),
  'reviewing records the administrator who did it and when (not what the form says)');
update public.safety_rules set message_en = 'A latex allergy is recorded: use latex-free gloves, dams and materials.' where code = 'latex_allergy';
select test.ok((select version = 2 and reviewed_by is null and reviewed_at is null from public.safety_rules where code = 'latex_allergy'), 'editing what a rule says raises the version and clears the review');
update public.safety_rules set reviewed_by = :'carol'::uuid, reviewed_at = now() where code = 'latex_allergy';
update public.safety_rules set is_active = false where code = 'latex_allergy';
select test.ok((select not is_active and reviewed_by = :'carol'::uuid and version = 2 from public.safety_rules where code = 'latex_allergy'), 'activating or deactivating a rule keeps its review');
update public.safety_rules set is_active = true, code = 'renamed_rule' where code = 'latex_allergy';
select test.ok((select count(*) = 1 from public.safety_rules where code = 'latex_allergy') and (select count(*) = 0 from public.safety_rules where code = 'renamed_rule'), 'the code of a rule is fixed');
insert into public.safety_rules (code, title_ar, title_en, message_ar, message_en, severity, match, sort)
values ('clinic_rule', 'قاعدة العيادة', 'Clinic rule', 'رسالة العيادة', 'Clinic message', 'info', '{"conditions":["asthma"],"procedures":{"codes":["scaling"]}}', 200);
select test.ok((select version = 1 and reviewed_by is null and is_active from public.safety_rules where code = 'clinic_rule'), 'an administrator adds a rule of their own');
select test.throws($$insert into public.safety_rules (code, title_ar, title_en, message_ar, message_en, match) values ('clinic_rule', 'قاعدة', 'Again', 'رسالة', 'message', '{"medications":["x1"]}')$$, 'duplicate key|unique', 'rule codes are unique');
select test.throws($$insert into public.safety_rules (code, title_ar, title_en, message_ar, message_en, match) values ('bad_one', 'قاعدة', 'Bad', 'رسالة', 'message', '{"nonsense":["x1"]}')$$, 'check constraint|violates', 'a match with unknown keys is refused');
select test.throws($$insert into public.safety_rules (code, title_ar, title_en, message_ar, message_en, match) values ('bad_two', 'قاعدة', 'Bad', 'رسالة', 'message', '{"procedures":{"codes":["scaling"]}}')$$, 'check constraint|violates', 'a rule needs something in the record to match');
select test.throws($$insert into public.safety_rules (code, title_ar, title_en, message_ar, message_en, match) values ('bad_three', 'قاعدة', 'Bad', 'رسالة', 'message', '{"medications":"warfarin"}')$$, 'check constraint|violates', 'keywords are a list');
select test.throws($$insert into public.safety_rules (code, title_ar, title_en, message_ar, message_en, match) values ('bad_four', 'قاعدة', 'Bad', 'رسالة', 'message', '{"labs":[{"code":"hba1c"}]}')$$, 'check constraint|violates', 'a lab condition needs a threshold');
select test.throws($$insert into public.safety_rules (code, title_ar, title_en, message_ar, message_en, severity, match) values ('bad_five', 'قاعدة', 'Bad', 'رسالة', 'message', 'critical', '{"medications":["x1"]}')$$, 'check constraint|violates', 'severity is info, warn or danger');
select test.throws($$delete from public.safety_rules where code = 'clinic_rule'$$, 'permission denied|42501', 'even an administrator cannot delete a rule (deactivate it)');
select test.as_super();
select test.ok((select count(*) >= 3 from public.audit_logs where table_name = 'safety_rules' and actor_id = :'carol'::uuid and action = 'update'), 'rule changes are audited');
select test.as_user(:'alice'::uuid);
select test.as_user(:'alice'::uuid);
select test.as_user(:'carol'::uuid);
select test.ok((select count(*) = 0 from public.prescriptions) and (select count(*) = 0 from public.consents), 'the administrator sees no prescription and no consent');

-- ============================================================================================================ purge
select test.as_user(:'alice'::uuid);
select public.patient_request_deletion(:'pr', 'Rx Patient');
select test.as_super();
update public.patients set deletion_scheduled_for = now() - interval '1 minute' where id = :'pr';
select test.as_service();
select public.patient_purge(:'pr', false);
select test.as_super();
select test.ok((select count(*) from public.prescriptions where patient_id = :'pr') + (select count(*) from public.consents where patient_id = :'pr')
             + (select count(*) from public.medications where patient_id = :'pr') = 0, 'purge removes prescriptions, consents (with their versions) and medication lines');
select test.ok((select count(*) = 1 from public.patients where id = :'po'), 'another file is untouched');
