\pset tuples_only on
\set alice 'a1111111-1111-1111-1111-111111111111'
\set bob 'b2222222-2222-2222-2222-222222222222'
select id as s_dent from public.medical_specialties where code = 'dentistry' \gset

select test.ok((select count(*) >= 60 from public.procedure_catalog where is_active)
               and (select surgical and tooth_state = 'extracted' from public.procedure_catalog where code = 'extraction_simple')
               and (select finding_kind = 'filling' and scope = 'surfaces' from public.procedure_catalog where code = 'filling_composite'),
  'a local catalogue of 60+ dental procedures, surgical ones marked');

select test.as_user(:'alice'::uuid);
select test.throws($$insert into public.procedure_catalog (code, category, name_ar, name_en) values ('mine', 'other', 'شيء', 'Thing')$$,
  'row-level security|permission denied', 'only an administrator edits the catalogue');
select public.create_patient('Treatment Patient', date '1980-02-02', 'female', null, null, null, null, null, null, 'self', true) as pt \gset
-- two problems: caries on 16 (with its exam finding) and a fractured 18
insert into public.conditions (patient_id, specialty_id, name, category, teeth) values (:'pt', :'s_dent', 'Caries 16', 'diagnosis', '{16}') returning id as c16 \gset
insert into public.conditions (patient_id, specialty_id, name, category, teeth) values (:'pt', :'s_dent', 'Fractured 18', 'diagnosis', '{18}') returning id as c18 \gset
select public.dental_exam_create(:'pt', jsonb_build_object('exam_date', current_date - 10, 'kind', 'comprehensive'), '[]',
  jsonb_build_array(jsonb_build_object('tooth', 16, 'surfaces', jsonb_build_array('M', 'O'), 'kind', 'caries', 'condition_id', :'c16'),
                    jsonb_build_object('tooth', 16, 'surfaces', jsonb_build_array('B'), 'kind', 'caries'),
                    jsonb_build_object('tooth', 18, 'kind', 'fracture'))) as ex \gset

select public.treatment_plan_create(:'pt', '{"title":"Plan A"}',
  jsonb_build_array(jsonb_build_object('catalog_code', 'filling_composite', 'teeth', jsonb_build_array(16), 'surfaces', jsonb_build_array('M', 'O'), 'condition_id', :'c16'),
                    jsonb_build_object('catalog_code', 'extraction_simple', 'teeth', jsonb_build_array(18), 'condition_id', :'c18', 'phase', 2),
                    jsonb_build_object('name', 'Whitening later', 'phase', 3))) as pa \gset
select id as i16 from public.treatment_items where plan_id = :'pa' and catalog_code = 'filling_composite' \gset
select id as i18 from public.treatment_items where plan_id = :'pa' and catalog_code = 'extraction_simple' \gset
select id as iw from public.treatment_items where plan_id = :'pa' and name = 'Whitening later' \gset
select test.ok((select status = 'draft' and version = 1 and group_id = id from public.treatment_plans where id = :'pa')
               and (select count(*) = 3 from public.treatment_items where plan_id = :'pa' and status = 'proposed')
               and (select surgical and name = 'خلع بسيط' from public.treatment_items where id = :'i18'),
  'a plan is created with its treatments, named from the catalogue; an extraction is marked surgical');

select test.throws(format($$select public.treatment_item_set_status(%L, 'completed')$$, :'i16'), 'invalid_transition', 'nothing is completed before it was accepted');
select test.throws(format($$update public.treatment_items set status = 'accepted', surgical = false where id = %L$$, :'i18'), 'immutable', 'a surgical treatment cannot be made non-surgical');
select test.throws(format($$select public.treatment_plan_set_status(%L, 'accepted')$$, :'pa'), 'surgical_confirmation_required',
  'a plan with a surgical treatment is accepted only with an explicit confirmation');
select public.treatment_plan_set_status(:'pa', 'accepted', 'discussed with the dentist', true);
select test.ok((select status = 'accepted' and accepted_on = current_date from public.treatment_plans where id = :'pa')
               and (select count(*) = 3 from public.treatment_items where plan_id = :'pa' and status = 'accepted'),
  'accepting the plan accepts its treatments');
select test.throws(format($$update public.treatment_items set status = 'completed', completed_on = current_date where id = %L$$, :'i16'),
  'complete_through_function', 'completion goes through the function that records it');

select public.treatment_item_set_status(:'i16', 'completed', current_date - 1, 'done at the clinic') as r16 \gset
select test.ok((:'r16'::jsonb ->> 'condition_resolved')::boolean and (:'r16'::jsonb ->> 'findings_resolved')::int = 1,
  'completing the filling resolves the caries it treated (not the one on another surface) and the diagnosis');
select test.ok((select p.teeth = '{16}' and p.performed_on = current_date - 1 and p.condition_id = :'c16'::uuid and p.kind = 'dental'
                  from public.procedures p join public.treatment_items i on i.procedure_id = p.id where i.id = :'i16'),
  'the procedure is recorded on the tooth, linked to the diagnosis');
select test.ok((select f.kind = 'filling' and f.surfaces = array['M', 'O'] and f.material = 'composite'
                  from public.dental_findings f join public.treatment_items i on i.exam_id = f.exam_id where i.id = :'i16'),
  'the chart gets the filling on its surfaces');
select test.ok((select count(*) = 1 from public.dental_findings where exam_id = :'ex' and tooth = 16 and resolved_on is null and surfaces = '{B}'),
  'the caries on the buccal surface stays open');
select test.ok((select clinical_status = 'resolved' and resolved_date = current_date - 1 from public.conditions where id = :'c16')
               and exists (select 1 from public.status_history where record_id = :'c16'::uuid and to_value = 'resolved' and reason like 'عولج%'),
  'the diagnosis is resolved, with the reason in its history');
select test.ok((select status = 'in_progress' from public.treatment_plans where id = :'pa'), 'the plan is in progress');

select test.throws(format($$select public.treatment_item_set_status(%L, 'completed')$$, :'i18'), 'surgical_confirmation_required',
  'a surgical treatment is completed only with an explicit confirmation');
select public.treatment_item_set_status(:'i18', 'completed', null, null, true) as r18 \gset
select test.ok((select s.status = 'extracted' from public.dental_tooth_states s join public.treatment_items i on i.exam_id = s.exam_id where i.id = :'i18')
               and (select resolved_on is not null from public.dental_findings where exam_id = :'ex' and tooth = 18),
  'an extraction marks the tooth extracted and closes its problems');
select public.treatment_item_set_status(:'iw', 'cancelled', null, 'not needed');
select test.ok((select status = 'completed' from public.treatment_plans where id = :'pa'), 'the plan completes when nothing is left open');
select test.ok((select count(*) >= 3 from public.status_history where record_id = :'i16'::uuid and table_name = 'treatment_items'),
  'every change of a treatment''s status is kept');
select test.throws(format($$update public.treatment_items set name = 'renamed' where id = %L$$, :'i16'), 'closed treatment', 'a completed treatment is not rewritten');
select test.throws(format($$insert into public.treatment_items (patient_id, plan_id, name) values (%L, %L, 'late')$$, :'pt', :'pa'), 'plan_closed',
  'nothing is added to a completed plan');

-- versions and alternatives
select public.treatment_plan_create(:'pt', '{"title":"Plan B"}', '[{"catalog_code":"crown_zirconia","teeth":[36]},{"catalog_code":"scaling"}]') as pb \gset
select public.treatment_plan_new_version(:'pb', 'price changed') as pb2 \gset
select test.ok((select status = 'superseded' from public.treatment_plans where id = :'pb')
               and (select count(*) = 2 from public.treatment_items where plan_id = :'pb' and status = 'cancelled')
               and (select version = 2 and previous_id = :'pb'::uuid and status = 'draft' from public.treatment_plans where id = :'pb2')
               and (select count(*) = 2 from public.treatment_items where plan_id = :'pb2' and status = 'proposed'),
  'a new version carries the open treatments over; the old one is kept, superseded');
select public.treatment_plan_create(:'pt', jsonb_build_object('title', 'Plan B alternative', 'alternative_of', :'pb2'), '[{"catalog_code":"crown_pfm","teeth":[36]}]') as pc \gset
select test.ok((select group_id from public.treatment_plans where id = :'pc') = (select group_id from public.treatment_plans where id = :'pb2'),
  'an alternative belongs to the same group');
select public.treatment_plan_set_status(:'pb2', 'accepted');
select test.ok((select status = 'declined' from public.treatment_plans where id = :'pc')
               and (select count(*) = 1 from public.treatment_items where plan_id = :'pc' and status = 'cancelled'),
  'choosing one option declines the other');

-- a private cost
select id as i36 from public.treatment_items where plan_id = :'pb2' and catalog_code = 'crown_zirconia' \gset
insert into public.treatment_costs (patient_id, item_id, amount, currency) values (:'pt', :'i36', 1500, 'SAR');
select test.throws(format($$insert into public.treatment_costs (patient_id, item_id, amount, currency) values (%L, %L, -5, 'SAR')$$, :'pt', :'i36'),
  'check constraint|violates', 'a cost cannot be negative');

-- isolation
select test.as_user(:'bob'::uuid);
select test.ok((select count(*) = 0 from public.treatment_plans where patient_id = :'pt') and (select count(*) = 0 from public.treatment_costs where patient_id = :'pt'),
  'another account sees no plan and no cost');
select test.throws(format($$select public.treatment_plan_create(%L, '{"title":"Intrusion"}', '[]')$$, :'pt'), 'forbidden', 'nor creates one');

-- the dentist through a share
select test.as_user(:'alice'::uuid);
select public.share_create(p_patient => :'pt', p_title => 'Dentist', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_expires_at => now() + interval '1 day', p_allow_contribute => true, p_contribute_modules => array['treatment_plans'], p_clinician => '{"name":"Dr Plan","facility":"Smile"}') as sh \gset
select (:'sh'::jsonb ->> 'token') as tok, (:'sh'::jsonb ->> 'pin') as pin \gset
select test.as_service();
select (public.share_open(:'tok', :'pin', 'ip-tx', 'UA') ->> 'session_token') as sess \gset
select test.ok(public.share_contribute_treatment_plan(:'sess', '{"title":"x"}', '[{"name":"y"}]') ->> 'status' = 'identify_first', 'the dentist identifies first');
select (public.share_identify(:'sess', 'Dr Plan', null, null, 'Smile', null, :'pt' || '/signatures/p.png') ->> 'contributor_id') as ctr \gset
select public.share_dental(:'sess') as d0 \gset
select test.ok(jsonb_array_length(:'d0'::jsonb -> 'plans') >= 2 and jsonb_array_length(:'d0'::jsonb -> 'my_costs') = 0
               and position('1500' in (:'d0'::jsonb -> 'plans')::text) = 0,
  'the dentist sees the current plans, without the patient''s costs');
select test.ok(public.share_contribute_treatment_plan(:'sess', '{"title":"Forged plan","status":"accepted"}', '[{"catalog_code":"root_canal","teeth":[46]}]') ->> 'status' = 'invalid',
  'a plan payload carrying a status key is refused (0033): a clinician cannot present a plan as accepted');
select public.share_contribute_treatment_plan(:'sess', '{"title":"Dentist plan"}',
  jsonb_build_array(jsonb_build_object('catalog_code', 'root_canal', 'teeth', jsonb_build_array(46)),
                    jsonb_build_object('catalog_code', 'implant_placement', 'teeth', jsonb_build_array(18)))) as dp \gset
select (:'dp'::jsonb ->> 'id') as dpid \gset
select test.ok((select status = 'proposed' and contributed_by = :'ctr'::uuid and presented_by like 'Dr Plan%' from public.treatment_plans where id = :'dpid'),
  'the dentist''s plan arrives as a proposal under their name');
select id as irc from public.treatment_items where plan_id = :'dpid' and catalog_code = 'root_canal' \gset
select public.share_add_treatment_item(:'sess', :'dpid', '{"catalog_code":"crown_zirconia","teeth":[46],"phase":2}') ->> 'status' as ai \gset
select test.ok(:'ai' = 'ok' and (select count(*) = 3 from public.treatment_items where plan_id = :'dpid'),
  'the dentist adds a treatment to their own proposal');
select test.ok((public.share_add_treatment_item(:'sess', :'pa', '{"name":"intrusion"}') ->> 'status') = 'not_found', 'but not to the patient''s plans');
select test.ok(public.share_treatment_item_status(:'sess', :'irc', 'accepted', null, null) ->> 'status' = 'patient_decides', 'only the patient accepts');
select test.ok((public.share_set_cost(:'sess', :'irc', 900, 'sar', 'quoted', 'incl. X-ray') ->> 'status') = 'ok', 'the dentist notes their cost');
select test.ok((select jsonb_array_length(public.share_dental(:'sess') -> 'my_costs') = 1), 'and sees only that cost');

select test.as_user(:'alice'::uuid);
select test.throws(format($$update public.treatment_items set name = 'my name' where id = %L$$, :'irc'), 'contributed_record_readonly',
  'the patient does not rewrite the dentist''s treatment');
select public.treatment_plan_set_status(:'dpid', 'accepted', null, true);
select test.ok((select status = 'accepted' from public.treatment_items where id = :'irc'), 'the patient accepts the dentist''s plan');

select test.as_service();
select public.share_treatment_item_status(:'sess', :'irc', 'completed', current_date, 'RCT done') as rc \gset
select test.ok(:'rc'::jsonb ->> 'status' = 'ok'
               and (select p.contributed_by = :'ctr'::uuid and p.source = 'clinic' from public.procedures p where p.id = (:'rc'::jsonb ->> 'procedure_id')::uuid)
               and exists (select 1 from public.dental_findings f where f.exam_id = (:'rc'::jsonb ->> 'exam_id')::uuid and f.kind = 'root_canal' and f.tooth = 46),
  'the dentist completes it: the procedure and the chart carry their name');
select test.ok((select contributed_by = :'ctr'::uuid from public.status_history where record_id = :'irc'::uuid and to_value = 'completed'),
  'the history says who completed it');
select public.share_retract(:'sess', 'treatment_plans', :'dpid', 'wrong patient') ->> 'status' as rt \gset
select test.ok(:'rt' = 'ok' and (select count(*) = 3 from public.treatment_items where plan_id = :'dpid' and record_status = 'entered_in_error'),
  'withdrawing the plan invalidates its treatments');

-- the patient's own treatments: the dentist carries them forward only once the patient accepted them
select test.as_user(:'alice'::uuid);
select public.treatment_plan_create(:'pt', '{"title":"Own plan"}', '[{"name":"Own scaling"}]') as pown \gset
select id as own_prop from public.treatment_items where plan_id = :'pown' \gset
select test.as_service();
select test.ok(public.share_treatment_item_status(:'sess', :'own_prop', 'planned', null, null) ->> 'status' = 'forbidden'
               and public.share_treatment_item_status(:'sess', :'own_prop', 'cancelled', null, 'nope') ->> 'status' = 'forbidden'
               and (select status = 'proposed' from public.treatment_items where id = :'own_prop'),
  'the dentist does not move or cancel a treatment the patient has not accepted');
select test.as_user(:'alice'::uuid);
select public.treatment_item_set_status(:'own_prop', 'accepted', null, null) is not null as acc \gset
select test.as_service();
select test.ok(public.share_treatment_item_status(:'sess', :'own_prop', 'cancelled', null, 'nope') ->> 'status' = 'forbidden'
               and public.share_treatment_item_status(:'sess', :'own_prop', 'scheduled', current_date + 7, null) ->> 'status' = 'ok',
  'once accepted, the dentist schedules it but does not cancel it');

-- what the dentist adds carries their own name as its author
select test.as_user(:'alice'::uuid);
select public.share_create(p_patient => :'pt', p_title => 'Notes', p_scope_kind => 'full', p_expires_at => now() + interval '1 day',
  p_allow_contribute => true, p_contribute_modules => array['clinical_notes', 'procedures'], p_clinician => '{"name":"Dr Real"}') as shn \gset
select test.as_service();
select (public.share_open(:'shn'::jsonb ->> 'token', :'shn'::jsonb ->> 'pin', 'ip-tn', 'UA') ->> 'session_token') as sessn \gset
select public.share_confirm_clinician(:'sessn');
select (public.share_contribute(:'sessn', 'clinical_notes', jsonb_build_object('body', 'x', 'noted_at', now(), 'author_name', 'Prof. Somebody Else')) ->> 'id') as fn \gset
select (public.share_contribute(:'sessn', 'procedures', jsonb_build_object('name', 'Scaling', 'kind', 'dental', 'performed_on', current_date)) ->> 'id') as fp \gset
select test.ok((select author_name = 'Dr Real' from public.clinical_notes where id = :'fn')
               and (select operator_name = 'Dr Real' from public.procedures where id = :'fp'),
  'a clinician cannot write another name as the author, and an empty one is their own');

select test.as_user(:'alice'::uuid);
select public.patient_request_deletion(:'pt', 'Treatment Patient');
select test.as_service();
select public.patient_purge(:'pt', true);
select test.ok((select count(*) = 0 from public.treatment_plans where patient_id = :'pt'), 'plans, treatments and costs are purged with the file');
select test.as_super();
