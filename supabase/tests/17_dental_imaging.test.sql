\pset tuples_only on
\set alice 'a1111111-1111-1111-1111-111111111111'
\set bob 'b2222222-2222-2222-2222-222222222222'
select id as s_dent from public.medical_specialties where code = 'dentistry' \gset
select id as s_card from public.medical_specialties where code = 'cardiology' \gset

-- ---------------------------------------------------------------- modalities and the whole-mouth rule
select test.ok(app.is_whole_mouth('panoramic', null) and app.is_whole_mouth('cbct', null) and app.is_whole_mouth('cephalometric', null)
               and not app.is_whole_mouth('panoramic', array[16]::smallint[]) and not app.is_whole_mouth('periapical', null)
               and not app.is_whole_mouth('xray', null), 'a panoramic, CBCT or cephalometric image with no teeth is a whole-mouth image');

select test.as_user(:'alice'::uuid);
select public.create_patient('Imaging Patient', date '1988-05-05', 'male', null, null, null, null, null, null, 'self', true) as pi \gset
select public.create_patient('Other Imaging Patient', date '1990-01-01', 'female', null, null, null, null, null, null, 'self', true) as po \gset

insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on, teeth) values
  (:'pi', :'s_dent', 'periapical', current_date, array[36]::smallint[]),
  (:'pi', :'s_dent', 'bitewing', current_date, array[26, 27]::smallint[]),
  (:'pi', :'s_dent', 'occlusal', current_date, null),
  (:'pi', :'s_dent', 'intraoral_photo', current_date, array[11]::smallint[]),
  (:'pi', :'s_dent', 'extraoral_photo', current_date, null),
  (:'pi', :'s_dent', 'cbct', current_date, null),
  (:'pi', :'s_dent', 'cephalometric', current_date, null);
select test.ok((select count(*) = 7 from public.imaging_studies where patient_id = :'pi'), 'the dental image types are accepted');
select test.throws(format($$insert into public.imaging_studies (patient_id, modality, performed_on) values (%L, 'selfie', current_date)$$, :'pi'),
  'check constraint|violates', 'an unknown modality is refused');
insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on) values (:'pi', :'s_dent', 'dental_xray', current_date - 900), (:'pi', null, 'xray', current_date - 900);
select test.ok((select count(*) = 2 from public.imaging_studies where patient_id = :'pi' and modality in ('dental_xray', 'xray')), 'the earlier modalities still work');

-- ---------------------------------------------------------------- bone levels
select test.ok(app.bone_levels_ok('{"s1":{"level":"coronal_third","pattern":"horizontal"},"s6":{"level":"none"},"s3":{"level":"apical_third","pattern":"mixed"}}')
               and app.bone_levels_ok(null) and app.bone_levels_ok('{"s2":{"level":"coronal15"}}') and app.bone_levels_ok('{"s4":{"level":"middle_third","pattern":"vertical"}}'),
  'a sextant reading with level and optional pattern is accepted');
select test.ok(not app.bone_levels_ok('{"s7":{"level":"none"}}') and not app.bone_levels_ok('{"s1":{"level":"severe"}}')
               and not app.bone_levels_ok('{"s1":{"level":"none","pattern":"curved"}}') and not app.bone_levels_ok('{"s1":{"pattern":"mixed"}}')
               and not app.bone_levels_ok('{"s1":{"level":"none","extra":1}}') and not app.bone_levels_ok('{}') and not app.bone_levels_ok('[]')
               and not app.bone_levels_ok('{"s1":"none"}') and not app.bone_levels_ok('{"s1":{"level":3}}'),
  'unknown sextants, levels, patterns and extra keys are refused');
insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on, bone_levels)
  values (:'pi', :'s_dent', 'panoramic', current_date, '{"s1":{"level":"coronal_third","pattern":"horizontal"},"s4":{"level":"middle_third","pattern":"vertical"}}');
select id as pano from public.imaging_studies where patient_id = :'pi' and modality = 'panoramic' \gset
select test.ok((select bone_levels -> 's4' ->> 'level' = 'middle_third' from public.imaging_studies where id = :'pano'), 'a panoramic keeps its bone reading');
select test.throws(format($$update public.imaging_studies set bone_levels = '{"s1":{"level":"gone"}}' where id = %L$$, :'pano'),
  'check constraint|violates', 'the database refuses a bad bone reading');

-- ---------------------------------------------------------------- the dentist's view: whole-mouth images appear
insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on) values (:'pi', :'s_card', 'panoramic', current_date);   -- another specialty
insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on, teeth) values (:'pi', :'s_dent', 'periapical', current_date - 400, array[46]::smallint[]);   -- outside the dates
insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on) values (:'pi', :'s_dent', 'xray', current_date);   -- no teeth, not whole-mouth
insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on) values (:'pi', null, 'cbct', current_date);   -- no specialty
select public.share_create(p_patient => :'pi', p_title => 'Dentist', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_include => array['documents'], p_date_from => current_date - 100,
  p_expires_at => now() + interval '2 days', p_allow_contribute => true, p_contribute_modules => array['imaging_studies', 'medical_documents', 'dental_exams'],
  p_clinician => '{"name":"Dr Abdullah","specialty":"General dentistry","facility":"Smile"}') as dsh \gset
select public.share_create(p_patient => :'pi', p_title => 'Whole file', p_scope_kind => 'full',
  p_expires_at => now() + interval '2 days', p_allow_contribute => true, p_contribute_modules => array['dental_exams'], p_clinician => '{"name":"Dr Full"}') as fsh \gset
select (:'dsh'::jsonb ->> 'token') as d_tok, (:'dsh'::jsonb ->> 'pin') as d_pin, (:'fsh'::jsonb ->> 'token') as f_tok, (:'fsh'::jsonb ->> 'pin') as f_pin \gset
select test.as_service();
select (public.share_open(:'d_tok', :'d_pin', 'ip-i', 'UA') ->> 'session_token') as d_sess \gset
select (public.share_open(:'f_tok', :'f_pin', 'ip-f', 'UA') ->> 'session_token') as f_sess \gset
select public.share_confirm_clinician(:'d_sess');
select public.share_dental(:'d_sess') as chart \gset
select test.ok((select count(*) = 1 from jsonb_array_elements(:'chart'::jsonb -> 'imaging') e where e ->> 'modality' = 'panoramic' and e ->> 'teeth' is null),
  'a panoramic of dentistry with no teeth is in the dental view');
select test.ok((select count(*) from jsonb_array_elements(:'chart'::jsonb -> 'imaging') e where e ->> 'modality' = 'cbct') = 1, 'a CBCT without a specialty stays out of a dentistry-only share (only the dental one is shown)');
select test.ok((select count(*) from jsonb_array_elements(:'chart'::jsonb -> 'imaging') e where e ->> 'modality' = 'cephalometric') = 1
               and (select count(*) from jsonb_array_elements(:'chart'::jsonb -> 'imaging') e where e ->> 'modality' = 'occlusal') = 0,
  'a cephalometric image is whole-mouth; an occlusal one with no teeth is not');
select test.ok((select count(*) from jsonb_array_elements(:'chart'::jsonb -> 'imaging') e where e ->> 'modality' = 'periapical') = 1
               and (select count(*) from jsonb_array_elements(:'chart'::jsonb -> 'imaging') e where e ->> 'modality' = 'bitewing') = 1,
  'images with teeth are still shown, and the date range still applies');
select test.ok((select count(*) from jsonb_array_elements(:'chart'::jsonb -> 'imaging') e where (e ->> 'id')::uuid in
                  (select id from public.imaging_studies where patient_id = :'pi' and specialty_id = :'s_card')) = 0,
  'a whole-mouth image of another specialty is not shown');
select test.ok((select count(*) from jsonb_array_elements(:'chart'::jsonb -> 'imaging') e where e ->> 'modality' = 'xray') = 0, 'a plain X-ray with no teeth is not whole-mouth');
select public.share_dental(:'f_sess') as fchart \gset
select test.ok((select count(*) from jsonb_array_elements(:'fchart'::jsonb -> 'imaging') e where e ->> 'modality' = 'cbct') = 2
               and (select count(*) from jsonb_array_elements(:'fchart'::jsonb -> 'imaging') e where e ->> 'modality' = 'panoramic') = 1,
  'a whole-file share also shows whole-mouth images with no specialty, but not those of another specialty');

-- ---------------------------------------------------------------- findings point at the image they were read on
select test.as_user(:'alice'::uuid);
insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on) values (:'po', :'s_dent', 'panoramic', current_date);
select id as other_img from public.imaging_studies where patient_id = :'po' \gset
select public.dental_exam_create(:'pi', jsonb_build_object('exam_date', current_date, 'kind', 'comprehensive'),
  '[{"tooth":36,"status":"present"}]',
  jsonb_build_array(jsonb_build_object('tooth', 36, 'kind', 'periapical_lesion', 'evidence', 'radiographic', 'imaging_id', :'pano'),
                    jsonb_build_object('tooth', 46, 'kind', 'caries', 'evidence', 'clinical'))) as ex \gset
select test.ok((select imaging_id = :'pano'::uuid from public.dental_findings where exam_id = :'ex' and tooth = 36)
               and (select imaging_id is null from public.dental_findings where exam_id = :'ex' and tooth = 46), 'a radiographic finding keeps the image it was read on');
select test.throws(format($$select public.dental_exam_create(%L, '{"exam_date":"2024-01-01"}', '[]', %L::jsonb)$$, :'pi',
  jsonb_build_array(jsonb_build_object('tooth', 36, 'kind', 'caries', 'evidence', 'clinical', 'imaging_id', :'pano'))::text),
  'imaging_needs_radiographic_evidence', 'only a radiographic finding names an image');
select test.throws(format($$select public.dental_exam_create(%L, '{"exam_date":"2024-01-01"}', '[]', %L::jsonb)$$, :'pi',
  jsonb_build_array(jsonb_build_object('tooth', 36, 'kind', 'caries', 'evidence', 'radiographic', 'imaging_id', :'other_img'))::text),
  'imaging_invalid', 'a finding cannot name another patient''s image');
select test.throws(format($$insert into public.dental_findings (patient_id, tooth, kind, evidence, observed_on, imaging_id) values (%L, 36, 'caries', 'radiographic', current_date, %L)$$, :'pi', :'other_img'),
  'foreign key|violates', 'the foreign key also refuses another patient''s image');
select test.throws(format($$insert into public.dental_findings (patient_id, tooth, kind, evidence, observed_on, imaging_id) values (%L, 36, 'caries', 'clinical', current_date, %L)$$, :'pi', :'pano'),
  'check constraint|violates', 'the table itself requires radiographic evidence for a linked image');

-- the dentist through the link: only an image the link shows
select test.as_service();
select public.share_contribute_dental_exam(:'d_sess', jsonb_build_object('exam_date', current_date, 'kind', 'comprehensive'), '[]',
  jsonb_build_array(jsonb_build_object('tooth', 16, 'kind', 'bone_loss', 'evidence', 'radiographic', 'imaging_id', :'pano'))) as r1 \gset
select test.ok(:'r1'::jsonb ->> 'status' = 'ok' and (select imaging_id = :'pano'::uuid and contributed_by is not null from public.dental_findings where id =
  (select id from public.dental_findings where tooth = 16 and kind = 'bone_loss' and patient_id = :'pi')), 'the dentist links a finding to the panoramic through the link');
select test.throws(format($$select public.share_contribute_dental_exam(%L, jsonb_build_object('exam_date', current_date), '[]', %L::jsonb)$$, :'d_sess',
  jsonb_build_array(jsonb_build_object('tooth', 16, 'kind', 'bone_loss', 'evidence', 'radiographic', 'imaging_id', :'other_img'))::text),
  'imaging_invalid', 'a doctor cannot link another patient''s image');
select id as card_img from public.imaging_studies where patient_id = :'pi' and specialty_id = :'s_card' \gset
select test.throws(format($$select public.share_contribute_dental_exam(%L, jsonb_build_object('exam_date', current_date), '[]', %L::jsonb)$$, :'d_sess',
  jsonb_build_array(jsonb_build_object('tooth', 16, 'kind', 'bone_loss', 'evidence', 'radiographic', 'imaging_id', :'card_img'))::text),
  'imaging_invalid', 'a doctor cannot link an image of the patient that the link does not show');
select id as old_img from public.imaging_studies where patient_id = :'pi' and teeth = array[46]::smallint[] \gset
select test.throws(format($$select public.share_contribute_dental_exam(%L, jsonb_build_object('exam_date', current_date), '[]', %L::jsonb)$$, :'d_sess',
  jsonb_build_array(jsonb_build_object('tooth', 46, 'kind', 'bone_loss', 'evidence', 'radiographic', 'imaging_id', :'old_img'))::text),
  'imaging_invalid', 'nor one outside the dates of the link');
select test.ok(public.share_dental_imaging_extras(:'d_sess') -> 'finding_images' ->>
  (select id::text from public.dental_findings where tooth = 16 and kind = 'bone_loss' and patient_id = :'pi') = :'pano',
  'the dentist''s view tells which image each finding was read on');
select test.ok(public.share_dental_imaging_extras(:'d_sess') -> 'images' -> :'pano' -> 'bone_levels' -> 's1' ->> 'level' = 'coronal_third',
  'the bone reading reaches the dentist''s view');

-- ---------------------------------------------------------------- the dentist records a panoramic with its bone reading
select public.share_contribute(:'d_sess', 'imaging_studies', jsonb_build_object('modality', 'panoramic', 'performed_on', current_date, 'impression', 'generalised horizontal bone loss',
  'bone_levels', jsonb_build_object('s5', jsonb_build_object('level', 'apical_third', 'pattern', 'vertical')), 'test_order_id', null)) as r2 \gset
select test.ok(:'r2'::jsonb ->> 'status' = 'ok' and (select bone_levels -> 's5' ->> 'pattern' = 'vertical' and contributed_by is not null from public.imaging_studies where id = (:'r2'::jsonb ->> 'id')::uuid),
  'a doctor records the bone reading with a study');
select test.ok((select public.share_contribute(:'d_sess', 'imaging_studies', jsonb_build_object('modality', 'panoramic', 'performed_on', current_date, 'bone_levels', '{"s9":{"level":"none"}}'::jsonb))
                 ) ->> 'status' = 'invalid', 'a doctor''s bad bone reading is refused');

-- ---------------------------------------------------------------- a study fulfils the request
select test.as_user(:'alice'::uuid);
insert into public.test_orders (patient_id, specialty_id, kind, name, status) values (:'pi', :'s_dent', 'imaging', 'Panoramic X-ray', 'requested');
insert into public.test_orders (patient_id, specialty_id, kind, name, status) values (:'pi', null, 'lab', 'CBC', 'requested');
insert into public.test_orders (patient_id, specialty_id, kind, name, status) values (:'po', null, 'imaging', 'Chest X-ray', 'requested');
select id as ord from public.test_orders where patient_id = :'pi' and kind = 'imaging' \gset
select id as lab_ord from public.test_orders where patient_id = :'pi' and kind = 'lab' \gset
select id as other_ord from public.test_orders where patient_id = :'po' \gset
select test.throws(format($$insert into public.imaging_studies (patient_id, modality, performed_on, test_order_id) values (%L, 'panoramic', current_date, %L)$$, :'pi', :'lab_ord'),
  'order_not_open', 'a lab request is not fulfilled by an image');
select test.throws(format($$insert into public.imaging_studies (patient_id, modality, performed_on, test_order_id) values (%L, 'panoramic', current_date, %L)$$, :'pi', :'other_ord'),
  'foreign key|violates', 'another patient''s request cannot be linked');
insert into public.imaging_studies (patient_id, specialty_id, modality, performed_on, test_order_id) values (:'pi', :'s_dent', 'panoramic', current_date - 3, :'ord');
select id as fulfil from public.imaging_studies where test_order_id = :'ord' \gset
select test.ok((select status = 'done' and done_on = current_date - 3 from public.test_orders where id = :'ord'), 'recording the study closes the request');
select test.throws(format($$insert into public.imaging_studies (patient_id, modality, performed_on, test_order_id) values (%L, 'panoramic', current_date, %L)$$, :'pi', :'ord'),
  'order_not_open', 'a closed request is not fulfilled twice');
select test.ok((select count(*) >= 1 from public.audit_logs where table_name = 'test_orders' and record_id = :'ord' and action = 'update'), 'closing the request is audited');
update public.imaging_studies set record_status = 'entered_in_error', invalidated_reason = 'wrong patient''s film' where id = :'fulfil';
select test.ok((select status = 'requested' and done_on is null from public.test_orders where id = :'ord'), 'invalidating the study opens the request again');

-- ---------------------------------------------------------------- annotations on an image file
select id as study from public.imaging_studies where patient_id = :'pi' and modality = 'periapical' and teeth = array[36]::smallint[] \gset
select public.register_document(:'pi', 'Periapical 36', 'dental_image', :'pi' || '/peri.png', 'peri.png', 'image/png', 2000, repeat('a', 64),
  :'s_dent', null, current_date, 'standard', null, null, :'study') as doc \gset
select public.register_document(:'pi', 'Report', 'imaging_report', :'pi' || '/report.pdf', 'report.pdf', 'application/pdf', 2000, repeat('b', 64),
  :'s_dent', null, current_date, 'standard', null, null, :'study') as pdf \gset
select public.register_document(:'pi', 'Unlinked', 'dental_image', :'pi' || '/free.png', 'free.png', 'image/png', 2000, repeat('c', 64), :'s_dent') as free_doc \gset

select test.ok(app.annotation_shapes_ok('[{"type":"arrow","x1":0.1,"y1":0.2,"x2":0.5,"y2":0.6},{"type":"circle","cx":0.5,"cy":0.5,"r":0.1,"color":"red"},{"type":"rect","x":0.1,"y":0.1,"w":0.2,"h":0.2},{"type":"text","x":0.4,"y":0.4,"text":"RCT?"}]'),
  'arrows, circles, rectangles and text with 0-1 coordinates are valid');
select test.ok(not app.annotation_shapes_ok('[{"type":"arrow","x1":1.2,"y1":0,"x2":0,"y2":0}]') and not app.annotation_shapes_ok('[{"type":"line","x1":0,"y1":0}]')
               and not app.annotation_shapes_ok('[{"type":"circle","cx":0.5,"cy":0.5}]') and not app.annotation_shapes_ok('[{"type":"circle","cx":0.5,"cy":0.5,"r":0}]')
               and not app.annotation_shapes_ok('[{"type":"text","x":0.1,"y":0.1,"text":""}]') and not app.annotation_shapes_ok('[]') and not app.annotation_shapes_ok('{}')
               and not app.annotation_shapes_ok('[{"type":"rect","x":0.1,"y":0.1,"w":0.2,"h":0.2,"onclick":"x"}]')
               and not app.annotation_shapes_ok('[{"type":"rect","x":0.1,"y":0.1,"w":0.2,"h":0.2,"color":"pink"}]')
               and not app.annotation_shapes_ok('[{"type":"rect","x":-0.1,"y":0.1,"w":0.2,"h":0.2}]'), 'out-of-range, unknown, incomplete or extra shape data is refused');

insert into public.imaging_annotations (patient_id, imaging_id, document_id, shapes)
  values (:'pi', :'study', :'doc', '[{"type":"circle","cx":0.4,"cy":0.6,"r":0.08,"color":"yellow"},{"type":"text","x":0.45,"y":0.5,"text":"apical lesion"}]');
select id as ann from public.imaging_annotations where patient_id = :'pi' \gset
select test.ok((select recorded_by = :'alice'::uuid and verification = 'reported' and contributed_by is null and record_status = 'active' from public.imaging_annotations where id = :'ann'),
  'an annotation is kept apart from the image, with its author');
select test.throws(format($$insert into public.imaging_annotations (patient_id, imaging_id, document_id, shapes) values (%L, %L, %L, '[{"type":"arrow","x1":2,"y1":0,"x2":0,"y2":0}]')$$, :'pi', :'study', :'doc'),
  'check constraint|violates', 'bad shapes are refused by the database');
select test.throws(format($$insert into public.imaging_annotations (patient_id, imaging_id, document_id, shapes) values (%L, %L, %L, '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]')$$, :'pi', :'study', :'free_doc'),
  'annotation_target_invalid', 'an annotation is drawn on an image attached to its own study');
select test.throws(format($$insert into public.imaging_annotations (patient_id, imaging_id, document_id, shapes) values (%L, %L, %L, '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]')$$, :'pi', :'study', :'pdf'),
  'annotation_target_invalid', 'a PDF cannot be annotated');
select test.throws(format($$insert into public.imaging_annotations (patient_id, imaging_id, document_id, shapes) values (%L, %L, %L, '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]')$$, :'po', :'other_img', :'doc'),
  'row-level security|foreign key|violates', 'nothing is drawn across patients');
select test.throws(format($$update public.imaging_annotations set shapes = '[{"type":"text","x":0.1,"y":0.1,"text":"changed"}]' where id = %L$$, :'ann'),
  'permission denied', 'an annotation is never edited');
select test.throws(format($$delete from public.imaging_annotations where id = %L$$, :'ann'), 'permission denied|row-level', 'nor deleted');
select test.ok((select count(*) >= 1 from public.audit_logs where table_name = 'imaging_annotations' and record_id = :'ann'), 'annotations are audited');

-- isolation
select test.as_user(:'bob'::uuid);
select test.ok((select count(*) = 0 from public.imaging_annotations where patient_id = :'pi'), 'another account sees no annotation');
select test.throws(format($$insert into public.imaging_annotations (patient_id, imaging_id, document_id, shapes) values (%L, %L, %L, '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]')$$, :'pi', :'study', :'doc'),
  'row-level security', 'another account cannot annotate');
with u as (update public.imaging_annotations set record_status = 'entered_in_error', invalidated_reason = 'mine now' where id = :'ann' returning 1)
  select test.ok((select count(*) = 0 from u), 'another account cannot invalidate');
select test.ok((select count(*) = 0 from public.imaging_studies where patient_id = :'pi'), 'nor see the images');
select test.as_anon();
select test.throws(format($$select count(*) from public.imaging_annotations where patient_id = %L$$, :'pi'), 'permission denied', 'a signed-out visitor reads nothing');

-- the dentist through the link
select test.as_service();
select public.share_dental_imaging_extras(:'d_sess') as xi \gset
select test.ok(jsonb_array_length(:'xi'::jsonb -> 'images' -> :'study' -> 'documents') = 1
               and :'xi'::jsonb -> 'images' -> :'study' -> 'documents' -> 0 ->> 'id' = :'doc'
               and jsonb_array_length(:'xi'::jsonb -> 'annotations') = 1 and :'xi'::jsonb -> 'annotations' -> 0 ->> 'id' = :'ann',
  'the dentist sees the image files of a study (not the PDF) and the annotations on them');
select public.share_add_annotation(:'d_sess', :'study', :'doc', '[{"type":"arrow","x1":0.2,"y1":0.2,"x2":0.4,"y2":0.45,"color":"red"}]') as ra \gset
select test.ok(:'ra'::jsonb ->> 'status' = 'ok' and (select contributed_by is not null and source = 'clinic' and verification = 'confirmed' and source_detail like 'Dr Abdullah%'
                from public.imaging_annotations where id = (:'ra'::jsonb ->> 'id')::uuid), 'the dentist draws an annotation under his name');
select test.ok(public.share_add_annotation(:'d_sess', :'study', :'doc', '[{"type":"arrow","x1":9,"y1":0,"x2":0,"y2":0}]') ->> 'status' = 'invalid', 'bad shapes through the link are refused');
select test.ok(public.share_add_annotation(:'d_sess', :'study', :'free_doc', '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]') ->> 'status' = 'not_found', 'only an image of the study can be annotated through the link');
select test.ok(public.share_add_annotation(:'d_sess', :'study', :'pdf', '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]') ->> 'status' = 'not_found', 'a PDF cannot be annotated through the link');
select test.ok(public.share_add_annotation(:'d_sess', :'other_img', :'doc', '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]') ->> 'status' = 'not_found', 'nor another patient''s image');
select test.ok(public.share_add_annotation(:'d_sess', :'card_img', :'doc', '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]') ->> 'status' = 'not_found', 'nor an image the link does not show');
select public.share_confirm_clinician(:'f_sess');
select test.ok(public.share_add_annotation(:'f_sess', :'study', :'doc', '[{"type":"text","x":0.1,"y":0.1,"text":"x"}]') ->> 'status' = 'forbidden', 'a link that may not add images cannot annotate');
select test.ok((select count(*) = 2 from jsonb_array_elements(public.share_dental_imaging_extras(:'d_sess') -> 'annotations') a)
               and (select count(*) = 1 from jsonb_array_elements(public.share_dental_imaging_extras(:'d_sess') -> 'annotations') a where (a ->> 'mine')::boolean),
  'the dentist''s own annotation is marked as his');
-- the dentist attaches an image file to a study and cannot attach one to what the link does not show
select public.share_register_document(:'d_sess', 'Bitewing file', 'dental_image', :'pi' || '/bw.jpg', 'bw.jpg', 'image/jpeg', 100, repeat('d', 64), null, current_date, null, null,
  (select id from public.imaging_studies where patient_id = :'pi' and modality = 'bitewing')) as rd \gset
select test.ok(:'rd'::jsonb ->> 'status' = 'ok' and (select imaging_id is not null and contributed_by is not null from public.medical_documents where id = (:'rd'::jsonb ->> 'id')::uuid),
  'the dentist attaches an image file to a study');
select test.ok(public.share_register_document(:'d_sess', 'Wrong', 'dental_image', :'pi' || '/x.jpg', 'x.jpg', 'image/jpeg', 100, repeat('e', 64), null, current_date, null, null, :'card_img') ->> 'status' = 'invalid',
  'not to a study the link does not cover');
select test.ok(public.share_register_document(:'d_sess', 'Wrong', 'dental_image', :'pi' || '/y.jpg', 'y.jpg', 'image/jpeg', 100, repeat('f', 64), null, current_date, null, null, :'other_img') ->> 'status' = 'invalid',
  'nor to another patient''s study');
-- withdrawal and the patient's bulk invalidation know annotations
select test.ok(public.share_retract(:'d_sess', 'imaging_annotations', (:'ra'::jsonb ->> 'id')::uuid, 'drew on the wrong film') ->> 'status' = 'ok', 'the dentist withdraws his annotation');
select test.ok(public.share_retract(:'d_sess', 'imaging_annotations', :'ann', 'not mine to withdraw') ->> 'status' = 'not_found', 'but not the patient''s');
select test.ok((select count(*) = 1 from jsonb_array_elements(public.share_dental_imaging_extras(:'d_sess') -> 'annotations') a), 'a withdrawn annotation is no longer shown');
select public.share_add_annotation(:'d_sess', :'study', :'doc', '[{"type":"rect","x":0.3,"y":0.3,"w":0.1,"h":0.1}]') as rb \gset
select test.ok(exists (select 1 from jsonb_array_elements(public.share_contrib_state(:'d_sess') -> 'items') i where i ->> 'table' = 'imaging_annotations'), 'the clinician''s list shows the annotations');

-- a share without 'documents' cannot reach the files, so it cannot annotate or list them
select test.as_user(:'alice'::uuid);
select public.share_create(p_patient => :'pi', p_title => 'No files', p_scope_kind => 'specialty', p_specialty_ids => array[:'s_dent'::uuid],
  p_include => array['specialty_records'], p_expires_at => now() + interval '2 days', p_allow_contribute => true, p_contribute_modules => array['imaging_studies'],
  p_clinician => '{"name":"Dr Nofiles"}') as nsh \gset
select (:'nsh'::jsonb ->> 'token') as n_tok, (:'nsh'::jsonb ->> 'pin') as n_pin \gset
select test.as_service();
select (public.share_open(:'n_tok', :'n_pin', 'ip-n', 'UA') ->> 'session_token') as n_sess \gset
select test.ok(jsonb_array_length(public.share_dental_imaging_extras(:'n_sess') -> 'images' -> :'study' -> 'documents') = 0
               and jsonb_array_length(public.share_dental_imaging_extras(:'n_sess') -> 'annotations') = 0, 'without the documents module the link lists no file and no annotation');

-- the patient invalidates one annotation, then everything one dentist added
select test.as_user(:'alice'::uuid);
update public.imaging_annotations set record_status = 'entered_in_error', invalidated_reason = 'drawn on the wrong tooth' where id = :'ann';
select test.ok((select record_status = 'entered_in_error' and invalidated_by = :'alice'::uuid from public.imaging_annotations where id = :'ann'), 'the patient invalidates an annotation with the reason');
select test.throws(format($$update public.imaging_annotations set record_status = 'active' where id = %L$$, :'ann'), 'permission denied|cannot be modified', 'an invalidated annotation stays invalidated');
select id as ctr from public.share_contributors where patient_id = :'pi' and full_name = 'Dr Abdullah' \gset
select public.share_invalidate_contributions(:'ctr', 'not my dentist') as n_inv \gset
select test.ok(:'n_inv'::int >= 1, 'invalidating everything a clinician added counts what was added', :'n_inv');
select test.ok((select count(*) = 0 from public.imaging_annotations where contributed_by = :'ctr' and record_status = 'active')
               and (select count(*) >= 1 from public.imaging_annotations where contributed_by = :'ctr' and record_status = 'entered_in_error'),
  'and includes the annotations');

-- ---------------------------------------------------------------- purge
select public.patient_request_deletion(:'pi', 'Imaging Patient');
select test.as_service();
select public.patient_purge(:'pi', true);
select test.ok((select count(*) = 0 from public.imaging_annotations where patient_id = :'pi')
               and (select count(*) = 0 from public.imaging_studies where patient_id = :'pi'), 'annotations are purged with the file');
select test.as_super();
