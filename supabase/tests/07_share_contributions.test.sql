\pset tuples_only on
\set alice 'a1111111-1111-1111-1111-111111111111'
\set bob 'b2222222-2222-2222-2222-222222222222'
select id as s_dent from public.medical_specialties where code = 'dentistry' \gset
select id as s_card from public.medical_specialties where code = 'cardiology' \gset

select test.as_user(:'alice'::uuid);
select public.create_patient('Contrib Patient', date '1990-02-02', 'female', null, null, null, null, null, null, 'self', true) as pc \gset
select public.create_patient('Other Patient', date '1991-03-03', 'male', null, null, null, null, null, null, 'self', true) as po \gset
insert into public.encounters (patient_id, kind, started_at, reason) values (:'po', 'clinic', now() - interval '1 day', 'OTHER-PATIENT-VISIT') returning id as e_other \gset
insert into public.conditions (patient_id, name, category, certainty) values (:'pc', 'PATIENT-OWN-CONDITION', 'chronic', 'confirmed') returning id as c_own \gset

-- a read-only share and a contributing dentistry share
select public.share_create(p_patient => :'pc', p_title => 'Read only', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_expires_at => now() + interval '2 days') as ro \gset
select public.share_create(p_patient => :'pc', p_title => 'Dentist may add', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_expires_at => now() + interval '2 days', p_allow_contribute => true,
  p_contribute_modules => array['encounters', 'conditions', 'clinical_notes', 'medical_documents'],
  p_clinician => '{"name":"Dr Molar","specialty":"Dentist","license":"LIC-1","facility":"Smile Clinic","city":"Riyadh"}') as rw \gset
select (:'ro'::jsonb ->> 'token') as ro_tok, (:'ro'::jsonb ->> 'pin') as ro_pin, (:'rw'::jsonb ->> 'token') as rw_tok, (:'rw'::jsonb ->> 'pin') as rw_pin,
       (:'rw'::jsonb ->> 'share_id') as rw_id \gset
select test.throws(format($$select public.share_create(p_patient => %L, p_title => 'x', p_scope_kind => 'full', p_allow_contribute => true)$$, :'pc'),
  'choose what the clinician may add', 'a contributing share must say what may be added');
select test.throws(format($$select public.share_create(p_patient => %L, p_title => 'x', p_scope_kind => 'full', p_allow_contribute => true, p_contribute_modules => array['conditions'])$$, :'pc'),
  'clinician_name_required', 'a link that lets the doctor add names the doctor');
select test.ok((select clinician_name = 'Dr Molar' and clinician_facility = 'Smile Clinic' and clinician_city = 'Riyadh' and recipient_label = 'Dr Molar'
                from public.medical_shares where id = :'rw_id'), 'the patient names the doctor, clinic and city on the link');
select test.ok((select allow_contribute and contribute_modules @> array['conditions'] from public.medical_shares where id = :'rw_id'), 'the owner sees the contribution settings');
select test.throws(format($$select public.share_identify('x', 'Dr X', null, null, null, null, 'x', null, null)$$), 'permission denied|42501',
  'an account cannot call the clinician functions directly');

select test.as_service();
select (public.share_open(:'ro_tok', :'ro_pin', 'ip-c1', 'UA') ->> 'session_token') as ro_sess \gset
select (public.share_open(:'rw_tok', :'rw_pin', 'ip-c2', 'UA') ->> 'session_token') as rw_sess \gset
select test.ok(public.share_identify(:'ro_sess', 'Dr Read Only', null, null, null, null, :'pc' || '/signatures/a.png') ->> 'status' = 'forbidden',
  'a read-only share cannot take additions');
select test.ok(public.share_contribute(:'rw_sess', 'conditions', '{"name":"Too early"}') ->> 'status' = 'identify_first',
  'the clinician must identify before adding');
select test.ok(public.share_clinician(:'rw_sess') ->> 'name' = 'Dr Molar', 'the doctor sees whom the link is for');
select test.ok(public.share_confirm_clinician(:'ro_sess') ->> 'status' = 'forbidden', 'a read-only link has nothing to confirm');
select (public.share_confirm_clinician(:'rw_sess', 'ip-c2', 'UA') ->> 'contributor_id') as ctr \gset
select test.ok((select full_name = 'Dr Molar' and specialty = 'Dentist' and license_no = 'LIC-1' and facility = 'Smile Clinic' and city = 'Riyadh'
                       and named_by_patient and signature_path is null from public.share_contributors where id = :'ctr'),
  'one click: the doctor takes the details the patient gave, typing nothing');
select test.ok(exists (select 1 from public.medical_share_access_logs where share_id = :'rw_id' and event = 'contributor_identified'), 'the confirmation is logged');
select test.ok(public.share_identify(:'rw_sess', 'Somebody Else', null, null, null, null, :'pc' || '/signatures/sig2.png') ->> 'contributor_id' = :'ctr',
  'one identity per session (and a typed name never replaces the one the patient gave)');

-- forged provenance in the payload is refused outright (0033), not silently dropped
select test.ok(public.share_contribute(:'rw_sess', 'conditions',
  jsonb_build_object('name', 'CONTRIB-FORGED', 'category', 'diagnosis', 'patient_id', :'po', 'contributed_by', gen_random_uuid(), 'verification', 'reported',
                     'recorded_by', :'bob', 'source', 'self'), 'ip-c2', 'UA') ->> 'status' = 'invalid'
               and not exists (select 1 from public.conditions where name = 'CONTRIB-FORGED'), 'a payload carrying patient, provenance or author keys is refused and writes nothing');
select (public.share_contribute(:'rw_sess', 'conditions',
  jsonb_build_object('name', 'CONTRIB-CARIES-16', 'category', 'diagnosis', 'certainty', 'confirmed', 'specialty_id', :'s_card'),
  'ip-c2', 'UA') ->> 'id') as k1 \gset
select test.ok(:'k1' is not null, 'a diagnosis is added through the share');
select test.ok((select patient_id = :'pc'::uuid and contributed_by = :'ctr'::uuid and source = 'clinic' and verification = 'confirmed'
                       and specialty_id = :'s_dent'::uuid and recorded_by is null and source_detail like 'Dr Molar — Smile Clinic%'
                  from public.conditions where id = :'k1'),
  'patient, provenance, verification and specialty are forced, whatever the payload says');
select test.ok(public.share_contribute(:'rw_sess', 'procedures', '{"name":"Not allowed","kind":"dental"}') ->> 'status' = 'forbidden',
  'only the modules chosen by the patient can be added');
select test.ok(public.share_contribute(:'rw_sess', 'patients', '{"full_name":"x"}') ->> 'status' = 'forbidden', 'other tables are refused');
select test.ok(public.share_contribute(:'rw_sess', 'clinical_notes', jsonb_build_object('body', 'linked to another patient', 'noted_at', now(), 'encounter_id', :'e_other'))
                 ->> 'reason' = 'encounter_id:uuid', 'a link to another patient''s visit is refused');
select (public.share_contribute(:'rw_sess', 'encounters', jsonb_build_object('kind', 'dental', 'started_at', now() - interval '1 hour', 'reason', 'CONTRIB-VISIT')) ->> 'id') as v1 \gset
select (public.share_contribute(:'rw_sess', 'clinical_notes', jsonb_build_object('body', 'CONTRIB-NOTE', 'noted_at', now(), 'encounter_id', :'v1')) ->> 'id') as n1 \gset
select test.ok((select encounter_id = :'v1'::uuid from public.clinical_notes where id = :'n1'), 'a note can be linked to the visit added in the same share');
select test.ok((select actor_kind = 'share_contributor' and actor_id = :'ctr'::uuid from public.audit_logs where table_name = 'conditions' and record_id = :'k1' and action = 'insert'),
  'the audit trail names the clinician as the actor');
select test.ok(exists (select 1 from public.medical_share_access_logs where share_id = :'rw_id' and event = 'contribution_added'), 'additions are in the access log');
select public.share_contrib_state(:'rw_sess') as st \gset
select test.ok((:'st'::jsonb ->> 'used')::int = 3 and jsonb_array_length(:'st'::jsonb -> 'items') = 3 and jsonb_array_length(:'st'::jsonb -> 'encounters') = 1,
  'the clinician sees what was added through this share');
select test.ok(not (:'st'::jsonb -> 'contributor') ? 'signature_path' and not (:'st'::jsonb -> 'contributor') ? 'ip_hash', 'the state hides storage paths and network data');

-- documents
select test.ok((public.share_register_document(:'rw_sess', 'CONTRIB-XRAY', 'dental_image', :'pc' || '/x1.jpg', 'x1.jpg', 'image/jpeg', 1000, repeat('a', 64)) ->> 'status') = 'ok',
  'a document can be registered through the share');
select test.ok((select uploaded_by is null and contributed_by = :'ctr'::uuid and specialty_id = :'s_dent'::uuid from public.medical_documents where title = 'CONTRIB-XRAY'),
  'the document carries the clinician, not an account');

-- withdrawal by the clinician
select test.ok(public.share_retract(:'rw_sess', 'conditions', :'c_own', 'not mine') ->> 'status' = 'not_found', 'the clinician cannot withdraw the patient''s own records');
select test.ok(public.share_retract(:'rw_sess', 'clinical_notes', :'n1', 'x') ->> 'status' = 'reason_required', 'a withdrawal needs a reason');
select test.ok(public.share_retract(:'rw_sess', 'clinical_notes', :'n1', 'typed in the wrong file') ->> 'status' = 'ok', 'the clinician withdraws an addition');
select test.ok((select record_status = 'entered_in_error' and invalidated_reason like '%typed in the wrong file' from public.clinical_notes where id = :'n1'),
  'the withdrawn addition stays in the history with the reason');

-- limit
update public.medical_shares set max_contributions = 4 where id = :'rw_id';
select test.ok(public.share_contribute(:'rw_sess', 'conditions', '{"name":"CONTRIB-LIMIT"}') ->> 'status' = 'limit', 'the per-share limit is enforced');
update public.medical_shares set max_contributions = 100 where id = :'rw_id';

-- the patient's side
select test.as_user(:'alice'::uuid);
select test.ok((select full_name = 'Dr Molar' and license_no = 'LIC-1' from public.share_contributors where id = :'ctr'), 'the owner sees who added');
select test.throws(format($$update public.conditions set name = 'rewritten' where id = %L$$, :'k1'), 'contributed_record_readonly',
  'the patient cannot rewrite what the clinician added');
select test.throws(format($$insert into public.conditions (patient_id, name, contributed_by) values (%L, 'spoof', %L)$$, :'pc', :'ctr'),
  'set by the share functions only', 'an account cannot attribute a record to a clinician');
select test.throws(format($$update public.conditions set contributed_by = %L where id = %L$$, :'ctr', :'c_own'),
  'immutable fields', 'provenance cannot be added afterwards');
update public.encounters set status = 'completed' where id = :'v1';
select test.ok((select status from public.encounters where id = :'v1') = 'completed', 'the patient can update what happened next (status)');
select public.share_mark_contributor_reviewed(:'ctr');
select test.ok((select reviewed_at is not null from public.share_contributors where id = :'ctr'), 'the patient marks the additions reviewed');

select test.as_user(:'bob'::uuid);
select test.ok((select count(*) from public.share_contributors) = 0, 'another account sees no clinicians of this file');
select test.throws(format($$select public.share_invalidate_contributions(%L, 'not mine')$$, :'ctr'), 'forbidden', 'another account cannot invalidate them');

select test.as_user(:'alice'::uuid);
select test.ok(public.share_invalidate_contributions(:'ctr', 'not my dentist') = 3, 'the patient invalidates everything one clinician added in one step');
select test.ok((select count(*) from public.conditions where contributed_by = :'ctr' and record_status = 'active') = 0
               and (select record_status from public.conditions where id = :'c_own') = 'active',
  'only that clinician''s additions are invalidated');

-- revocation cuts the clinician off
select public.share_revoke(:'rw_id'::uuid, 'done');
select test.as_service();
select test.ok(public.share_contribute(:'rw_sess', 'conditions', '{"name":"After revoke"}') ->> 'status' = 'expired', 'a revoked share takes no more additions');

-- a contributing link made before links named the clinician still opens, counts wrong PINs and can be revoked
select test.as_user(:'alice'::uuid);
select public.share_create(p_patient => :'pc', p_title => 'Legacy', p_scope_kind => 'full', p_expires_at => now() + interval '1 day',
  p_allow_contribute => true, p_contribute_modules => array['conditions'], p_clinician => '{"name":"Dr Legacy"}') as lg \gset
select (:'lg'::jsonb ->> 'token') as lg_tok, (:'lg'::jsonb ->> 'pin') as lg_pin, (:'lg'::jsonb ->> 'share_id') as lg_id \gset
select test.as_super();
update public.medical_shares set clinician_name = null where id = :'lg_id';
select test.as_service();
select test.ok(public.share_open(:'lg_tok', :'lg_pin', 'ip-lg', 'UA') ->> 'session_token' is not null, 'a legacy contributing link still opens');
select test.ok(public.share_open(:'lg_tok', '000000', 'ip-lg', 'UA') ->> 'status' = 'invalid_pin', 'a wrong PIN on a legacy link is counted');
select test.as_user(:'alice'::uuid);
select public.share_revoke(:'lg_id'::uuid, 'old link');
select test.ok((select revoked_at is not null from public.medical_shares where id = :'lg_id'), 'a legacy contributing link can be revoked');

-- a file with clinician additions can still be erased completely
select test.as_user(:'alice'::uuid);
select public.patient_request_deletion(:'pc', 'Contrib Patient');
select test.as_service();
select public.patient_purge(:'pc', true);
select test.ok(not exists (select 1 from public.share_contributors where patient_id = :'pc') and not exists (select 1 from public.patients where id = :'pc'),
  'purging a file removes the clinicians and their additions');
select test.as_super();
