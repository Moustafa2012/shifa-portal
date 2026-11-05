-- 0034_extended_lab_catalogs.sql
-- Adds missing observation types: HOMA-IR, LDH, serology titers (Wright & Widal),
-- and microscopic urinalysis crystal types, with unit conversion aliases for common variants.

create temp table _ot_ext (
  code text, category text, lab_group text, name_ar text, name_en text, kind text, unit text,
  conv jsonb, dec int, pmin numeric, pmax numeric, spec text, sort int
);

insert into _ot_ext values
  -- Chemistry: HOMA-IR and LDH
  ('homa_ir', 'lab', 'chemistry', 'مقاومة الإنسولين HOMA-IR', 'HOMA-IR (Insulin resistance index)', 'numeric', null, '{}', 2, 0, 100, 'endocrinology', 1240),
  ('ldh',     'lab', 'chemistry', 'نازعة هيدروجين اللاكتات LDH', 'Lactate dehydrogenase (LDH)', 'numeric', 'U/L', '{"u/l":1}', 1, 0, 10000, 'internal_medicine', 1250),

  -- Urinalysis: specific crystal types
  ('urine_calcium_oxalate', 'lab', 'urinalysis', 'أوكسالات الكالسيوم في البول', 'Urine calcium oxalate', 'text', null, '{}', 0, null, null, 'urology', 2097),
  ('urine_uric_acid',       'lab', 'urinalysis', 'بلورات حمض البول في البول',   'Urine uric acid crystals', 'text', null, '{}', 0, null, null, 'urology', 2098),
  ('urine_urate',           'lab', 'urinalysis', 'بلورات اليورات في البول',       'Urine amorphous urates',   'text', null, '{}', 0, null, null, 'urology', 2099),
  ('urine_phosphate',       'lab', 'urinalysis', 'بلورات الفوسفات في البول',     'Urine phosphate crystals', 'text', null, '{}', 0, null, null, 'urology', 2101),

  -- Infection / Serology: Wright agglutination tests (Brucellosis)
  ('wright_abortus',    'lab', 'infection', 'اختبار رايت - المجهضة (Wright B. abortus)',   'Wright test (B. abortus)',   'text', null, '{}', 0, null, null, 'infectious_disease', 2261),
  ('wright_melitensis', 'lab', 'infection', 'اختبار رايت - المالطية (Wright B. melitensis)', 'Wright test (B. melitensis)', 'text', null, '{}', 0, null, null, 'infectious_disease', 2262),

  -- Infection / Serology: Widal agglutination tests (Enteric fever / Typhoid / Paratyphoid)
  ('widal_typhi_o',      'lab', 'infection', 'اختبار فيدال - تيفي O (Widal S. Typhi O)',           'Widal test (S. Typhi O)',      'text', null, '{}', 0, null, null, 'infectious_disease', 2263),
  ('widal_typhi_h',      'lab', 'infection', 'اختبار فيدال - تيفي H (Widal S. Typhi H)',           'Widal test (S. Typhi H)',      'text', null, '{}', 0, null, null, 'infectious_disease', 2264),
  ('widal_paratyphi_a',  'lab', 'infection', 'اختبار فيدال - نظيرة التيفية A (Widal S. Paratyphi A)', 'Widal test (S. Paratyphi A)', 'text', null, '{}', 0, null, null, 'infectious_disease', 2266),
  ('widal_paratyphi_b',  'lab', 'infection', 'اختبار فيدال - نظيرة التيفية B (Widal S. Paratyphi B)', 'Widal test (S. Paratyphi B)', 'text', null, '{}', 0, null, null, 'infectious_disease', 2267);

insert into public.observation_types (code, category, lab_group, name_ar, name_en, value_kind, default_unit, unit_conversions,
                                      decimals, plausible_min, plausible_max, default_specialty_id, sort)
select o.code, o.category, o.lab_group, o.name_ar, o.name_en, o.kind, o.unit, o.conv, o.dec, o.pmin, o.pmax,
       (select s.id from public.medical_specialties s where s.code = o.spec), o.sort
  from _ot_ext o
on conflict (code) do update set
  lab_group = excluded.lab_group,
  name_ar = excluded.name_ar,
  name_en = excluded.name_en,
  value_kind = excluded.value_kind,
  default_unit = excluded.default_unit,
  unit_conversions = public.observation_types.unit_conversions || excluded.unit_conversions,
  decimals = excluded.decimals,
  plausible_min = excluded.plausible_min,
  plausible_max = excluded.plausible_max,
  sort = excluded.sort;

drop table _ot_ext;

-- Unit conversion aliases and common case variations
update public.observation_types set unit_conversions = unit_conversions || v.conv
  from (values
    ('esr',                 '{"mm":1,"mm/h":1,"mm/hr":1,"mm/1h":1}'::jsonb),
    ('insulin',             '{"uIU/ml":1,"µIU/ml":1,"uIU/mL":1,"mIU/L":1,"pmol/L":0.144}'::jsonb),
    ('hemoglobin',          '{"g/dl":1,"g/L":0.1}'::jsonb),
    ('vitamin_d',           '{"ng/ml":1,"nmol/L":0.4006}'::jsonb),
    ('vitamin_b12',         '{"pg/ml":1,"pmol/L":1.355}'::jsonb),
    ('iron',                '{"µg/dl":1,"ug/dl":1,"ug/dL":1,"µmol/L":5.585}'::jsonb),
    ('ferritin',            '{"ng/ml":1,"µg/L":1}'::jsonb),
    ('crp',                 '{"mg/l":1,"mg/dL":10}'::jsonb),
    ('tsh',                 '{"µIU/ml":1,"uIU/ml":1,"µIU/mL":1,"uIU/mL":1,"mIU/L":1}'::jsonb),
    ('ft4',                 '{"ng/l":0.1,"ng/L":0.1,"pmol/L":0.0777}'::jsonb),
    ('urea',                '{"mg/dl":1,"mmol/L":6.006}'::jsonb),
    ('creatinine',          '{"mg/dl":1,"µmol/L":0.011312}'::jsonb),
    ('glucose_fasting_lab', '{"mg/dl":1,"mmol/L":18.0182}'::jsonb),
    ('alt',                 '{"u/l":1,"U/L":1}'::jsonb),
    ('ige_total',           '{"IU/ml":1,"IU/mL":1}'::jsonb),
    ('igg',                 '{"mg/dl":1,"g/L":100}'::jsonb),
    ('iga',                 '{"mg/dl":1,"g/L":100}'::jsonb),
    ('igm',                 '{"mg/dl":1,"g/L":100}'::jsonb)
  ) as v(code, conv)
 where observation_types.code = v.code;

