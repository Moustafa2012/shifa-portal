-- 0033: strict validation of everything a doctor sends through a share link (the database layer of three).
--
-- The web tier (src/lib/share-validation.ts) and the forms apply the same rules first; these are the rules that still hold when a
-- request skips them. Every share_* function that takes free text, a date, a number or a jsonb payload now
--   * refuses unknown keys, wrong JSON types, control characters, markup-looking text, blank text and over-long text,
--   * checks calendar dates (not before 1900 or the patient's birth, not in the future unless it is a scheduled thing,
--     inside the period the share covers), orders (end >= start) and numbers (hard ranges, bounded precision),
--   * checks the enumerations and the teeth (FDI, for the dentition),
--   * does all of that BEFORE anything is written, so a refused request never uses up one of the share's additions.
-- The earlier functions keep their bodies: they move to schema app as *_impl and a validating function of the same name in
-- schema public calls them. Added here too: a burst limit (30 additions a minute per doctor), claim/release of a submission key
-- (a double click saves once), per-share upload caps, and the limits a form needs (share_limits).
--
-- Reasons come back as "field:code" (for example "onset_date:date_future"); the web tier turns them into words and puts them
-- under the field. No SQL text is ever shown.

-- ---------------------------------------------------------------- 1. helpers (pure)
create function app.v_text(p text, p_min int, p_max int, p_kind text default 'line', p_required boolean default false) returns text
language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  if p is null then return case when p_required then 'required' end; end if;
  if p_kind = 'text' then
    if p ~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]' then return 'control'; end if;
  elsif p ~ '[\u0001-\u001f\u007f\u0085  ]' then
    return 'control';
  end if;
  if p ~ '[‪-‮⁦-⁩]' then return 'control'; end if;
  v := btrim(p, E' \t\r\n');
  if v = '' then return case when p = '' then case when p_required then 'required' end else 'blank' end; end if;
  if p_kind = 'name' and v ~ '[<>]' then return 'markup'; end if;
  if p_kind <> 'name' and v ~ '<\s*/?\s*[A-Za-z!?]' then return 'markup'; end if;
  if char_length(v) < p_min then return 'short'; end if;
  if char_length(v) > p_max then return 'long'; end if;
  return null;
end $$;

-- a text field of a jsonb object: "key:code" or null. A missing key is fine unless required; a non-string is a format error.
create function app.v_field(p_obj jsonb, p_key text, p_min int, p_max int, p_kind text default 'line', p_required boolean default false) returns text
language plpgsql immutable set search_path = '' as $$
declare v_code text;
begin
  if not (p_obj ? p_key) or jsonb_typeof(p_obj -> p_key) = 'null' then return case when p_required then p_key || ':required' end; end if;
  if jsonb_typeof(p_obj -> p_key) <> 'string' then return p_key || ':format'; end if;
  v_code := app.v_text(p_obj ->> p_key, p_min, p_max, p_kind, p_required);
  return case when v_code is not null then p_key || ':' || v_code end;
end $$;

create function app.try_date(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then return null;
end $$;

create function app.try_ts(p text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then return null; end if;
  return p::timestamptz;
exception when others then return null;
end $$;

-- a calendar date as an event date. when: past (not after today) | future (today or later, at most ten years ahead) | any.
-- One day of slack either way: the web tier checks against the viewer's own time zone.
create function app.v_date_code(p date, p_when text, p_dob date, p_from date, p_to date, p_ranged boolean default false) returns text
language plpgsql stable set search_path = '' as $$
begin
  if p is null then return 'date_invalid'; end if;
  if p < date '1900-01-01' then return 'date_old'; end if;
  if p_dob is not null and p < p_dob then return 'date_dob'; end if;
  if p_when = 'past' then
    if p > current_date + 1 then return 'date_future'; end if;
  elsif p_when = 'future' then
    if p < current_date - 1 then return 'date_past'; end if;
  end if;
  if p > current_date + 3650 then return 'date_far'; end if;
  if p_ranged and ((p_from is not null and p < p_from) or (p_to is not null and p > p_to)) then return 'date_range'; end if;
  return null;
end $$;

-- a tooth is FDI, and belongs to the dentition of the exam (permanent 11-48, primary 51-85, mixed: either)
create function app.fdi_ok(p jsonb, p_dentition text default 'mixed') returns boolean
language plpgsql immutable set search_path = '' as $$
declare n int;
begin
  if p is null or jsonb_typeof(p) <> 'number' then return false; end if;
  n := (p #>> '{}')::numeric::int;
  if (p #>> '{}')::numeric <> n then return false; end if;
  if not ((n / 10 between 1 and 4 and n % 10 between 1 and 8) or (n / 10 between 5 and 8 and n % 10 between 1 and 5)) then return false; end if;
  return case p_dentition when 'permanent' then n < 50 when 'primary' then n >= 50 else true end;
exception when others then return false;
end $$;

create function app.teeth_ok(p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare x jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 52 then return false; end if;
  for x in select * from jsonb_array_elements(p) loop
    if not app.fdi_ok(x) then return false; end if;
  end loop;
  return true;
end $$;

-- a number of a jsonb value inside a range, optionally integral; false for strings, NaN and anything out of range
create function app.num_in(p jsonb, p_min numeric, p_max numeric, p_int boolean default false) returns boolean
language plpgsql immutable set search_path = '' as $$
declare n numeric;
begin
  if p is null or jsonb_typeof(p) <> 'number' then return false; end if;
  n := (p #>> '{}')::numeric;
  return n between p_min and p_max and (not p_int or n = trunc(n));
exception when others then return false;
end $$;

-- the keys of an object are all in the list
create function app.keys_in(p jsonb, p_keys text[]) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and not exists (select 1 from jsonb_object_keys(p) k where k <> all (p_keys))
$$;

-- the encounter was added through this share (and is still active)
create function app.share_owns_encounter(p_share uuid, p_enc uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.encounters e join public.share_contributors sc on sc.id = e.contributed_by
                  where e.id = p_enc and sc.share_id = p_share and e.record_status = 'active')
$$;

-- the field a constraint belongs to ("encounters_kind_check" on table encounters -> kind)
create function app.constraint_field(p_table text, p_constraint text, p_column text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(p_column, ''), substring(p_constraint from '^' || p_table || '_(.+)_check$'), 'payload')
$$;

-- ---------------------------------------------------------------- 2. what each table lets a doctor fill
-- [kind, ...]: n name (min, max) | l line | t text | d date (when, ranged) | ts instant | b boolean | e enumeration (list, or null: the table's
-- own check decides) | u a visit added through this share | teeth | icd | bone | uuid
create function app.share_field_rules() returns jsonb
language sql immutable set search_path = '' as $$
  select $j${
    "encounters": {
      "kind": ["e"], "status": ["e"], "started_at": ["ts"], "ended_at": ["ts"], "facility_name": ["n", 2, 200], "practitioner_name": ["n", 2, 200],
      "reason": ["l", 2, 300], "symptoms": ["t", 1, 4000], "history_of_present_illness": ["t", 1, 4000], "examination": ["t", 1, 4000],
      "assessment": ["t", 1, 4000], "plan": ["t", 1, 4000], "summary": ["t", 1, 4000], "follow_up_date": ["d", "future"], "teeth": ["teeth"],
      "anesthesia_kind": ["e"], "anesthetic": ["l", 1, 300], "materials": ["l", 1, 1000], "complications": ["t", 1, 4000], "instructions": ["t", 1, 4000]},
    "conditions": {
      "name": ["l", 2, 200], "icd10_code": ["icd"], "category": ["e"], "clinical_status": ["e"], "certainty": ["e"], "severity": ["e"],
      "onset_date": ["d", "past", false], "date_precision": ["e"], "resolved_date": ["d", "past", false], "notes": ["t", 1, 4000], "sensitive": ["b"],
      "encounter_id": ["u"], "teeth": ["teeth"], "evidence": ["e"], "specialty_id": ["uuid"]},
    "procedures": {
      "kind": ["e"], "name": ["l", 2, 200], "performed_on": ["d", "past", true], "date_precision": ["e"], "body_site": ["l", 1, 200],
      "facility_name": ["n", 2, 200], "operator_name": ["n", 2, 200], "anesthesia": ["l", 1, 200], "indication": ["l", 1, 500], "outcome": ["t", 1, 4000],
      "complications": ["t", 1, 4000], "notes": ["t", 1, 4000], "encounter_id": ["u"], "teeth": ["teeth"], "specialty_id": ["uuid"]},
    "clinical_notes": {
      "kind": ["e"], "title": ["l", 1, 200], "body": ["t", 1, 20000], "author_name": ["n", 2, 200], "noted_at": ["ts"], "encounter_id": ["u"], "specialty_id": ["uuid"]},
    "medications": {
      "name_brand": ["l", 2, 200], "name_generic": ["l", 2, 200], "strength": ["l", 1, 60],
      "form": ["e", ["tablet", "capsule", "syrup", "injection", "cream", "drops", "inhaler", "patch", "other"]], "dose": ["l", 1, 100],
      "route": ["e", ["oral", "iv", "im", "sc", "topical", "inhaled", "ophthalmic", "otic", "nasal", "rectal", "sublingual", "other"]],
      "frequency": ["l", 1, 100], "as_needed": ["b"], "origin": ["e"], "status": ["e"], "start_date": ["d", "past", false], "date_precision": ["e"],
      "end_date": ["d", "any", false], "indication": ["l", 1, 500], "prescriber_name": ["n", 2, 200], "instructions": ["t", 1, 2000],
      "adverse_effects": ["t", 1, 2000], "notes": ["t", 1, 4000], "sensitive": ["b"], "encounter_id": ["u"], "specialty_id": ["uuid"]},
    "appointments": {
      "scheduled_at": ["ts"], "status": ["e"], "facility_name": ["n", 2, 200], "practitioner_name": ["n", 2, 200], "reason": ["l", 2, 300],
      "notes": ["t", 1, 4000], "encounter_id": ["u"], "specialty_id": ["uuid"]},
    "test_orders": {
      "kind": ["e"], "name": ["l", 2, 200], "reason": ["t", 1, 2000], "priority": ["e"], "status": ["e"], "ordered_by": ["n", 2, 200],
      "requested_on": ["d", "past", true], "notes": ["t", 1, 4000], "encounter_id": ["u"], "specialty_id": ["uuid"]},
    "imaging_studies": {
      "modality": ["e"], "body_site": ["l", 1, 200], "performed_on": ["d", "past", true], "date_precision": ["e"], "facility_name": ["n", 2, 200],
      "radiologist_name": ["n", 2, 200], "findings": ["t", 1, 4000], "impression": ["t", 1, 4000], "encounter_id": ["u"], "teeth": ["teeth"], "bone_levels": ["bone"],
      "specialty_id": ["uuid"]}
  }$j$::jsonb
$$;

-- "key:code" for the first problem of a record a doctor adds to a table, or null
create function app.share_check_contribution(p_table text, p_payload jsonb, p_share public.medical_shares) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_rules jsonb := app.share_field_rules() -> p_table;
  v_dob date;
  k text; v jsonb; r jsonb; v_code text; v_d date; v_ts timestamptz; v_st text;
  v_from date := (p_share).date_from; v_to date := (p_share).date_to;
  v_start timestamptz; v_end timestamptz;
begin
  if v_rules is null or jsonb_typeof(p_payload) <> 'object' then return 'payload:keys'; end if;
  select date_of_birth into v_dob from public.patients where id = (p_share).patient_id;
  for k, v in select * from jsonb_each(p_payload) loop
    if jsonb_typeof(v) = 'null' then continue; end if;          -- a null says nothing (and is never written)
    r := v_rules -> k;
    if r is null then return k || ':keys'; end if;
    case r ->> 0
      when 'n', 'l', 't' then
        v_code := app.v_field(p_payload, k, (r ->> 1)::int, (r ->> 2)::int, case r ->> 0 when 't' then 'text' when 'n' then 'name' else 'line' end);
        if v_code is not null then return v_code; end if;
      when 'd' then
        if jsonb_typeof(v) <> 'string' then return k || ':format'; end if;
        v_code := app.v_date_code(app.try_date(v #>> '{}'), r ->> 1, v_dob, v_from, v_to, coalesce((r ->> 2)::boolean, false));
        if v_code is not null then return k || ':' || v_code; end if;
      when 'ts' then
        if jsonb_typeof(v) <> 'string' or app.try_ts(v #>> '{}') is null then return k || ':date_invalid'; end if;
      when 'b' then
        if jsonb_typeof(v) <> 'boolean' then return k || ':format'; end if;
      when 'e' then
        if jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 40 then return k || ':enum'; end if;
        if r -> 1 is not null and not (r -> 1) ? (v #>> '{}') then return k || ':enum'; end if;
      when 'u' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or not app.share_owns_encounter((p_share).id, (v #>> '{}')::uuid) then
          return k || ':uuid';
        end if;
      when 'uuid' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return k || ':uuid'; end if;
      when 'teeth' then
        if not app.teeth_ok(v) then return k || ':teeth'; end if;
      when 'icd' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[A-Za-z][0-9]{2}(\.[0-9A-Za-z]{1,4})?$' then return k || ':format'; end if;
      when 'bone' then
        if jsonb_typeof(v) <> 'object' then return k || ':format'; end if;
    end case;
  end loop;

  -- dates that depend on each other or on the status of the record
  v_st := coalesce(p_payload ->> 'status', case p_table when 'encounters' then 'completed' when 'appointments' then 'scheduled' end);
  if p_table = 'encounters' then
    if not (p_payload ? 'started_at') or jsonb_typeof(p_payload -> 'started_at') = 'null' then return 'started_at:required'; end if;
    v_start := app.try_ts(p_payload ->> 'started_at'); v_end := app.try_ts(p_payload ->> 'ended_at');
    if v_st = 'planned' then
      v_code := app.v_date_code((v_start at time zone 'UTC')::date, 'future', v_dob, null, null);
      if v_code is not null then return 'started_at:' || v_code; end if;
    else
      if v_start > now() + interval '5 minutes' then return 'started_at:date_future'; end if;
      v_code := app.v_date_code((v_start at time zone 'UTC')::date, 'past', v_dob, v_from, v_to, true);
      if v_code is not null then return 'started_at:' || v_code; end if;
    end if;
    if v_end is not null then
      if v_end < v_start then return 'ended_at:date_order'; end if;
      if v_st <> 'planned' and v_end > now() + interval '5 minutes' then return 'ended_at:date_future'; end if;
      if v_end > v_start + interval '30 days' then return 'ended_at:range'; end if;
    end if;
    if p_payload ? 'follow_up_date' and app.try_date(p_payload ->> 'follow_up_date') < (v_start at time zone 'UTC')::date - 1 then return 'follow_up_date:date_order'; end if;
  elsif p_table = 'appointments' then
    if not (p_payload ? 'scheduled_at') or jsonb_typeof(p_payload -> 'scheduled_at') = 'null' then return 'scheduled_at:required'; end if;
    v_ts := app.try_ts(p_payload ->> 'scheduled_at');
    if v_st = 'scheduled' then
      v_code := app.v_date_code((v_ts at time zone 'UTC')::date, 'future', v_dob, null, null);
    else
      if v_ts > now() + interval '5 minutes' then return 'scheduled_at:date_future'; end if;
      v_code := app.v_date_code((v_ts at time zone 'UTC')::date, 'past', v_dob, null, null);
    end if;
    if v_code is not null then return 'scheduled_at:' || v_code; end if;
  elsif p_table = 'clinical_notes' and p_payload ? 'noted_at' then
    v_ts := app.try_ts(p_payload ->> 'noted_at');
    if v_ts > now() + interval '5 minutes' then return 'noted_at:date_future'; end if;
    v_code := app.v_date_code((v_ts at time zone 'UTC')::date, 'past', v_dob, v_from, v_to, true);
    if v_code is not null then return 'noted_at:' || v_code; end if;
  elsif p_table = 'conditions' then
    if app.try_date(p_payload ->> 'resolved_date') < app.try_date(p_payload ->> 'onset_date') then return 'resolved_date:date_order'; end if;
  elsif p_table = 'medications' then
    if app.try_date(p_payload ->> 'end_date') < app.try_date(p_payload ->> 'start_date') then return 'end_date:date_order'; end if;
    if p_payload ->> 'name_generic' is null and p_payload ->> 'name_brand' is null then return 'name_generic:required'; end if;
  end if;
  if p_table in ('conditions', 'procedures', 'test_orders') and (p_payload ->> 'name') is null then return 'name:required'; end if;
  if p_table = 'clinical_notes' and (p_payload ->> 'body') is null then return 'body:required'; end if;
  return null;
end $$;

-- ---------------------------------------------------------------- 3. the gate: burst limit, submission keys, limits
-- Every addition is logged as 'contribution_added' as its last step. A doctor cannot add more than 30 a minute: the 31st
-- raises, and the whole call (record, counter, log) is rolled back.
create function app.share_log_burst() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.event = 'contribution_added' and (
       select count(*) from public.medical_share_access_logs l
        where l.share_id = new.share_id and l.event = 'contribution_added' and l.at > now() - interval '1 minute'
          and l.detail ->> 'contributor' is not distinct from new.detail ->> 'contributor') >= 30 then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  return new;
end $$;
create trigger medical_share_access_logs_burst before insert on public.medical_share_access_logs
  for each row execute function app.share_log_burst();

-- a key per submission: the same form sent twice within a few seconds is one submission
create table public.share_submission_keys (
  session_id uuid not null references public.medical_share_sessions (id) on delete cascade,
  key text not null check (key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (session_id, key)
);
create index share_submission_keys_idx on public.share_submission_keys (session_id, created_at desc);
alter table public.share_submission_keys enable row level security;       -- no policy, no grant: only the functions below touch it

create function public.share_claim_submission(p_session_token text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_sid uuid; v_st text; v_open int; v_all int;
begin
  select a.o_session_id, a.o_status into v_sid, v_st from app.resolve_share_session(p_session_token) a;
  if v_st <> 'ok' then return jsonb_build_object('status', 'expired'); end if;
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then return jsonb_build_object('status', 'invalid'); end if;
  delete from public.share_submission_keys where created_at < now() - interval '15 minutes';
  select count(*) filter (where released_at is null), count(*) into v_open, v_all
    from public.share_submission_keys where session_id = v_sid and created_at > now() - interval '1 minute';
  if v_open >= 30 or v_all >= 90 then return jsonb_build_object('status', 'rate_limited'); end if;
  insert into public.share_submission_keys as k (session_id, key) values (v_sid, p_key)
  on conflict (session_id, key) do update set created_at = now(), released_at = null
    where k.released_at is not null or k.created_at < now() - interval '8 seconds';
  if not found then return jsonb_build_object('status', 'duplicate'); end if;
  return jsonb_build_object('status', 'ok');
end $$;

-- a refused or failed submission gives its key back, so a corrected resubmission is never taken for a repeat
create function public.share_release_submission(p_session_token text, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_sid uuid; v_st text;
begin
  select a.o_session_id, a.o_status into v_sid, v_st from app.resolve_share_session(p_session_token) a;
  if v_st = 'ok' and p_key ~ '^[0-9a-f]{64}$' then
    update public.share_submission_keys set released_at = now() where session_id = v_sid and key = p_key;
  end if;
end $$;

-- what a form needs to know to apply the rules: the patient's birth, the period the share covers, how long it lasts, what is left
create function public.share_limits(p_session_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_share uuid; v_sid uuid; v_st text; s public.medical_shares; v_exp timestamptz; v_files int; v_bytes bigint;
begin
  select a.o_share_id, a.o_session_id, a.o_status into v_share, v_sid, v_st from app.resolve_share_session(p_session_token) a;
  if v_st <> 'ok' then return jsonb_build_object('status', 'expired'); end if;
  select * into s from public.medical_shares where id = v_share;
  select expires_at into v_exp from public.medical_share_sessions where id = v_sid;
  select count(*), coalesce(sum(d.size_bytes), 0) into v_files, v_bytes
    from public.medical_documents d join public.share_contributors sc on sc.id = d.contributed_by where sc.share_id = s.id;
  return jsonb_build_object('status', 'ok', 'dob', (select date_of_birth from public.patients where id = s.patient_id),
    'date_from', s.date_from, 'date_to', s.date_to, 'created_at', s.created_at, 'expires_at', s.expires_at, 'session_expires_at', v_exp,
    'uploads', v_files, 'upload_bytes', v_bytes, 'max', s.max_contributions,
    'used', (select coalesce(sum(contribution_count), 0) from public.share_contributors where share_id = s.id),
    -- the doctor as the patient named them: the web tier uses these instead of any name a form sends
    'contributor_name', (select full_name from public.share_contributors where session_id = v_sid),
    'facility', coalesce((select facility from public.share_contributors where session_id = v_sid), s.clinician_facility));
end $$;

-- ---------------------------------------------------------------- 4. the generic addition (rewritten: unknown keys refused, rules applied first)
create or replace function public.share_contribute(p_session_token text, p_table text, p_payload jsonb, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  v_cols text[];
  v_used int;
  v_spec uuid;
  v_name text;
  v_payload jsonb;
  v_list text;
  v_id uuid;
  v_reason text;
  v_con text; v_col text;
begin
  select * into c from app.share_contributor_context(p_session_token);
  if c.o_status <> 'ok' then return jsonb_build_object('status', c.o_status); end if;
  if c.o_contributor is null then return jsonb_build_object('status', 'identify_first'); end if;
  if not (p_table = any ((c.o_share).contribute_modules)) or p_table = 'medical_documents' then
    return jsonb_build_object('status', 'forbidden');
  end if;
  v_cols := app.contribution_columns(p_table);
  if v_cols is null or jsonb_typeof(coalesce(p_payload, 'null'::jsonb)) <> 'object' then
    return jsonb_build_object('status', 'invalid', 'reason', 'payload:keys');
  end if;
  v_reason := app.share_check_contribution(p_table, p_payload, c.o_share);
  if v_reason is not null then return jsonb_build_object('status', 'invalid', 'reason', v_reason); end if;
  select coalesce(sum(contribution_count), 0) into v_used from public.share_contributors where share_id = (c.o_share).id;
  if v_used >= (c.o_share).max_contributions then return jsonb_build_object('status', 'limit'); end if;

  -- a specialty share writes into that specialty only
  v_spec := nullif(p_payload ->> 'specialty_id', '')::uuid;
  if (c.o_share).scope_kind = 'specialty' and (v_spec is null or not (v_spec = any ((c.o_share).specialty_ids))) then
    v_spec := ((c.o_share).specialty_ids)[1];
  end if;
  select left(full_name || coalesce(' — ' || facility, ''), 300) into v_name from public.share_contributors where id = c.o_contributor;

  select coalesce(jsonb_object_agg(k, p_payload -> k), '{}'::jsonb) into v_payload
    from unnest(v_cols) k where p_payload ? k;
  v_payload := v_payload || jsonb_build_object('patient_id', (c.o_share).patient_id, 'specialty_id', v_spec,
                                               'contributed_by', c.o_contributor, 'source', 'clinic', 'source_detail', v_name,
                                               'verification', 'confirmed');
  select string_agg(quote_ident(k), ', ') into v_list from jsonb_object_keys(v_payload) k;

  perform set_config('app.share_contributor', c.o_contributor::text, true);
  begin
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning id',
                   p_table, v_list, v_list, p_table)
      into v_id using v_payload;
  exception
    when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range
         or invalid_datetime_format or datetime_field_overflow or string_data_right_truncation or foreign_key_violation then
      get stacked diagnostics v_con = constraint_name, v_col = column_name;
      return jsonb_build_object('status', 'invalid',
        'reason', app.constraint_field(p_table, v_con, v_col) || case when sqlstate = '23502' then ':required' else ':enum' end);
  end;

  update public.share_contributors set contribution_count = contribution_count + 1, last_contribution_at = now()
   where id = c.o_contributor;
  perform app.share_log((c.o_share).id, 'contribution_added', p_ip_hash, p_user_agent,
                        jsonb_build_object('contributor', c.o_contributor, 'table', p_table, 'id', v_id));
  return jsonb_build_object('status', 'ok', 'id', v_id);
end $$;

-- ---------------------------------------------------------------- 5. the other share functions: validate, then the original body
-- Move each original to schema app and put a validating function of the same name in public.
do $$
declare f text;
begin
  foreach f in array array[
    'share_contribute_dental_exam(text, jsonb, jsonb, jsonb, text, text)',
    'share_contribute_treatment_plan(text, jsonb, jsonb, text, text)',
    'share_add_treatment_item(text, uuid, jsonb, text, text)',
    'share_set_cost(text, uuid, numeric, text, text, text, text, text)',
    'share_treatment_item_status(text, uuid, text, date, text, boolean, text, text)',
    'share_amend_note(text, uuid, text, text, text, text)',
    'share_perio_save(text, uuid, jsonb, jsonb, boolean, text, text)',
    'share_prescription_create(text, jsonb, jsonb, text, text)',
    'share_present_consent(text, jsonb, text, text, text)',
    'share_register_document(text, text, text, text, text, text, bigint, text, text, date, text, text, uuid)',
    'share_identify(text, text, text, text, text, text, text, text, text)',
    'share_add_note(text, text, text, text, text)',
    'share_retract(text, text, uuid, text, text, text)',
    'share_retract_prescription(text, uuid, text, text, text)'
  ] loop
    execute format('alter function public.%s set schema app', f);
    execute format('alter function app.%s rename to %s_impl', f, split_part(f, '(', 1));
  end loop;
end $$;

-- who is calling, for a validating function: the status to answer with when the call cannot go on, else null (+ the share)
create function app.share_pre(p_session_token text, p_module text, out o_status jsonb, out o_share public.medical_shares, out o_contributor uuid)
language plpgsql security definer set search_path = '' as $$
declare c record;
begin
  select * into c from app.share_contributor_context(p_session_token);
  if c.o_status <> 'ok' then o_status := jsonb_build_object('status', c.o_status); return; end if;
  o_share := c.o_share; o_contributor := c.o_contributor;
  if c.o_contributor is null then o_status := jsonb_build_object('status', 'identify_first'); return; end if;
  if p_module is not null and not (p_module = any ((c.o_share).contribute_modules)) then o_status := jsonb_build_object('status', 'forbidden'); end if;
end $$;

create function app.invalid(p_reason text) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('status', 'invalid', 'reason', p_reason)
$$;

-- ---- dental exam
create function app.share_check_exam(p_exam jsonb, p_states jsonb, p_findings jsonb, p_share public.medical_shares) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_dob date; v_d date; v_code text; x jsonb; v_dent text; v_n int := 0;
begin
  if jsonb_typeof(p_exam) <> 'object' or jsonb_typeof(coalesce(p_states, '[]')) <> 'array' or jsonb_typeof(coalesce(p_findings, '[]')) <> 'array' then return 'exam:keys'; end if;
  if not app.keys_in(p_exam, array['exam_date', 'kind', 'dentition', 'oral_hygiene', 'examiner_name', 'facility_name', 'chief_complaint', 'notes',
                                  'encounter_id', 'sections', 'pulp_tests', 'is_baseline']) then
    return 'exam:keys';
  end if;
  select date_of_birth into v_dob from public.patients where id = (p_share).patient_id;
  v_d := app.try_date(p_exam ->> 'exam_date');
  v_code := app.v_date_code(v_d, 'past', v_dob, (p_share).date_from, (p_share).date_to, true);
  if v_code is not null then return 'exam_date:' || v_code; end if;
  v_code := coalesce(app.v_field(p_exam, 'examiner_name', 2, 200, 'name'), app.v_field(p_exam, 'facility_name', 2, 200, 'name'),
                     app.v_field(p_exam, 'chief_complaint', 1, 1000, 'text'), app.v_field(p_exam, 'notes', 1, 4000, 'text'));
  if v_code is not null then return v_code; end if;
  if p_exam ? 'is_baseline' and jsonb_typeof(p_exam -> 'is_baseline') <> 'boolean' then return 'is_baseline:format'; end if;
  if p_exam ? 'sections' and (jsonb_typeof(p_exam -> 'sections') <> 'object' or length((p_exam -> 'sections')::text) > 30000) then return 'sections:format'; end if;
  if p_exam ? 'encounter_id' and (jsonb_typeof(p_exam -> 'encounter_id') <> 'string'
       or (p_exam ->> 'encounter_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return 'encounter_id:uuid'; end if;
  v_dent := coalesce(nullif(p_exam ->> 'dentition', ''), 'permanent');
  if v_dent not in ('permanent', 'primary', 'mixed') then return 'dentition:enum'; end if;
  if jsonb_array_length(coalesce(p_states, '[]')) > 60 or jsonb_array_length(coalesce(p_findings, '[]')) > 200 then return 'exam:long'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_states, '[]')) loop
    if not app.keys_in(x, array['tooth', 'status', 'note']) or not app.fdi_ok(x -> 'tooth', v_dent) then return 'teeth:teeth'; end if;
    v_code := app.v_field(x, 'note', 1, 500, 'text', false);
    if v_code is not null then return 'tooth_note:' || split_part(v_code, ':', 2); end if;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_findings, '[]')) loop
    if not app.keys_in(x, array['tooth', 'surfaces', 'kind', 'evidence', 'severity', 'material', 'notes', 'condition_id', 'imaging_id'])
       or not app.fdi_ok(x -> 'tooth', v_dent) then return 'teeth:teeth'; end if;
    if x ? 'surfaces' and (jsonb_typeof(x -> 'surfaces') <> 'array' or jsonb_array_length(x -> 'surfaces') > 5
         or exists (select 1 from jsonb_array_elements(x -> 'surfaces') s where s not in ('"M"', '"D"', '"O"', '"B"', '"L"'))) then return 'surfaces:enum'; end if;
    v_code := app.v_field(x, 'notes', 1, 2000, 'text', false);
    if v_code is not null then return 'finding_notes:' || split_part(v_code, ':', 2); end if;
  end loop;
  if jsonb_typeof(p_exam -> 'pulp_tests') = 'array' then
    if jsonb_array_length(p_exam -> 'pulp_tests') > 200 then return 'pulp_tests:long'; end if;
    for x in select * from jsonb_array_elements(p_exam -> 'pulp_tests') loop
      if not app.keys_in(x, array['tooth', 'test', 'result', 'value', 'note']) or not app.fdi_ok(x -> 'tooth', v_dent) then return 'teeth:teeth'; end if;
      v_code := coalesce(app.v_field(x, 'value', 1, 60, 'line', false), app.v_field(x, 'note', 1, 500, 'text', false));
      if v_code is not null then return 'pulp_note:' || split_part(v_code, ':', 2); end if;
    end loop;
  elsif p_exam ? 'pulp_tests' then
    return 'pulp_tests:format';
  end if;
  return null;
end $$;

create function public.share_contribute_dental_exam(p_session_token text, p_exam jsonb, p_states jsonb, p_findings jsonb,
                                                    p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_reason text;
begin
  select * into pre from app.share_pre(p_session_token, 'dental_exams');
  if pre.o_status is not null then return pre.o_status; end if;
  v_reason := app.share_check_exam(p_exam, p_states, p_findings, pre.o_share);
  if v_reason is not null then return app.invalid(v_reason); end if;
  return app.share_contribute_dental_exam_impl(p_session_token, p_exam, p_states, p_findings, p_ip_hash, p_user_agent);
end $$;

-- ---- treatment
create function app.share_check_item(p_item jsonb, p_dob date) returns text
language plpgsql immutable set search_path = '' as $$
declare v_code text;
begin
  if not app.keys_in(p_item, array['catalog_code', 'name', 'teeth', 'surfaces', 'condition_id', 'phase', 'notes', 'lang']) then return 'item:keys'; end if;
  v_code := coalesce(app.v_field(p_item, 'name', 2, 200, 'line'), app.v_field(p_item, 'notes', 1, 2000, 'text'));
  if v_code is not null then return v_code; end if;
  if p_item ? 'catalog_code' and (jsonb_typeof(p_item -> 'catalog_code') not in ('string', 'null') or (p_item ->> 'catalog_code') !~ '^[a-z][a-z0-9_]{1,59}$') then return 'catalog_code:format'; end if;
  if p_item ? 'teeth' and not app.teeth_ok(p_item -> 'teeth') then return 'teeth:teeth'; end if;
  if p_item ? 'surfaces' and (jsonb_typeof(p_item -> 'surfaces') <> 'array' or jsonb_array_length(p_item -> 'surfaces') > 5
       or exists (select 1 from jsonb_array_elements(p_item -> 'surfaces') s where s not in ('"M"', '"D"', '"O"', '"B"', '"L"'))) then return 'surfaces:enum'; end if;
  if p_item ? 'phase' and not app.num_in(p_item -> 'phase', 1, 20, true) then return 'phase:range'; end if;
  if p_item ? 'condition_id' and (jsonb_typeof(p_item -> 'condition_id') not in ('string', 'null')
       or (p_item ->> 'condition_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return 'condition_id:uuid'; end if;
  if p_item ? 'lang' and (p_item ->> 'lang') not in ('ar', 'en') then return 'lang:enum'; end if;
  return null;
end $$;

create function public.share_contribute_treatment_plan(p_session_token text, p_plan jsonb, p_items jsonb, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text; x jsonb;
begin
  select * into pre from app.share_pre(p_session_token, 'treatment_plans');
  if pre.o_status is not null then return pre.o_status; end if;
  if not app.keys_in(p_plan, array['title', 'lang', 'notes', 'alternative_of']) then return app.invalid('plan:keys'); end if;
  v_code := coalesce(app.v_field(p_plan, 'title', 2, 200, 'line', true), app.v_field(p_plan, 'notes', 1, 4000, 'text'));
  if v_code is not null then return app.invalid(v_code); end if;
  if p_plan ? 'lang' and (p_plan ->> 'lang') not in ('ar', 'en') then return app.invalid('lang:enum'); end if;
  if p_plan ? 'alternative_of' and jsonb_typeof(p_plan -> 'alternative_of') <> 'null'
     and (jsonb_typeof(p_plan -> 'alternative_of') <> 'string' or (p_plan ->> 'alternative_of') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return app.invalid('alternative_of:uuid');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 60 then return app.invalid('items:long'); end if;
  for x in select * from jsonb_array_elements(p_items) loop
    v_code := app.share_check_item(x, null);
    if v_code is not null then return app.invalid(v_code); end if;
  end loop;
  return app.share_contribute_treatment_plan_impl(p_session_token, p_plan, p_items, p_ip_hash, p_user_agent);
end $$;

create function public.share_add_treatment_item(p_session_token text, p_plan uuid, p_item jsonb, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text;
begin
  select * into pre from app.share_pre(p_session_token, 'treatment_plans');
  if pre.o_status is not null then return pre.o_status; end if;
  v_code := app.share_check_item(p_item, null);
  if v_code is not null then return app.invalid(v_code); end if;
  return app.share_add_treatment_item_impl(p_session_token, p_plan, p_item, p_ip_hash, p_user_agent);
end $$;

create function public.share_set_cost(p_session_token text, p_item uuid, p_amount numeric, p_currency text, p_kind text, p_note text,
                                      p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text;
begin
  select * into pre from app.share_pre(p_session_token, 'treatment_plans');
  if pre.o_status is not null then return pre.o_status; end if;
  if p_amount is null or p_amount < 0 or p_amount > 9999999999 or p_amount <> round(p_amount, 2) then return app.invalid('amount:range'); end if;
  if upper(coalesce(nullif(btrim(p_currency), ''), 'SAR')) <> all (array['SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'EGP', 'JOD', 'IQD', 'SYP', 'LBP', 'TRY', 'USD', 'EUR', 'GBP']) then
    return app.invalid('currency:enum');
  end if;
  if coalesce(nullif(p_kind, ''), 'estimate') not in ('estimate', 'quoted', 'final') then return app.invalid('kind:enum'); end if;
  v_code := app.v_text(p_note, 1, 300, 'line');
  if v_code is not null then return app.invalid('note:' || v_code); end if;
  return app.share_set_cost_impl(p_session_token, p_item, p_amount, p_currency, p_kind, p_note, p_ip_hash, p_user_agent);
end $$;

create function public.share_treatment_item_status(p_session_token text, p_item uuid, p_status text, p_date date, p_reason text,
                                                   p_confirm boolean default false, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text; v_dob date;
begin
  select * into pre from app.share_pre(p_session_token, 'treatment_plans');
  if pre.o_status is not null then return pre.o_status; end if;
  if p_status is null or p_status !~ '^[a-z_]{3,20}$' or p_status not in ('proposed', 'planned', 'accepted', 'scheduled', 'in_progress', 'completed', 'referred', 'cancelled', 'deferred') then
    return app.invalid('status:enum');
  end if;
  v_code := app.v_text(p_reason, 1, 500, 'line');
  if v_code is not null then return app.invalid('reason:' || v_code); end if;
  if p_date is not null then
    select date_of_birth into v_dob from public.patients where id = (pre.o_share).patient_id;
    -- a scheduled treatment is today or later; one started or completed has happened
    v_code := app.v_date_code(p_date, case when p_status = 'scheduled' then 'future' else 'past' end, v_dob, null, null);
    if v_code is not null then return app.invalid('date:' || v_code); end if;
  end if;
  return app.share_treatment_item_status_impl(p_session_token, p_item, p_status, p_date, p_reason, p_confirm, p_ip_hash, p_user_agent);
end $$;

-- ---- notes and withdrawals
create function public.share_amend_note(p_session_token text, p_note uuid, p_body text, p_reason text, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text;
begin
  select * into pre from app.share_pre(p_session_token, null);
  if pre.o_status is not null then return pre.o_status; end if;
  v_code := app.v_text(p_reason, 3, 500, 'line', true);
  if v_code in ('required', 'short', 'blank') then return jsonb_build_object('status', 'reason_required'); end if;
  if v_code is not null then return app.invalid('reason:' || v_code); end if;
  v_code := app.v_text(p_body, 1, 20000, 'text', true);
  if v_code is not null then return app.invalid('body:' || v_code); end if;
  return app.share_amend_note_impl(p_session_token, p_note, p_body, p_reason, p_ip_hash, p_user_agent);
end $$;

create function public.share_retract(p_session_token text, p_table text, p_id uuid, p_reason text, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text;
begin
  select * into pre from app.share_pre(p_session_token, null);
  if pre.o_status is not null then return pre.o_status; end if;
  v_code := app.v_text(p_reason, 3, 400, 'line', true);
  if v_code in ('required', 'short', 'blank') then return jsonb_build_object('status', 'reason_required'); end if;
  if v_code is not null then return app.invalid('reason:' || v_code); end if;
  return app.share_retract_impl(p_session_token, p_table, p_id, p_reason, p_ip_hash, p_user_agent);
end $$;

create function public.share_retract_prescription(p_session_token text, p_id uuid, p_reason text, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text;
begin
  select * into pre from app.share_pre(p_session_token, null);
  if pre.o_status is not null then return pre.o_status; end if;
  v_code := app.v_text(p_reason, 3, 400, 'line', true);
  if v_code in ('required', 'short', 'blank') then return jsonb_build_object('status', 'reason_required'); end if;
  if v_code is not null then return app.invalid('reason:' || v_code); end if;
  return app.share_retract_prescription_impl(p_session_token, p_id, p_reason, p_ip_hash, p_user_agent);
end $$;

-- the patient's note box (not part of the record until reviewed)
create function public.share_add_note(p_session_token text, p_author_name text, p_body text, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  v_code := app.v_text(p_author_name, 2, 120, 'name', true);
  if v_code is not null then return app.invalid('author_name:' || v_code); end if;
  v_code := app.v_text(p_body, 1, 4000, 'text', true);
  if v_code is not null then return app.invalid('body:' || v_code); end if;
  return app.share_add_note_impl(p_session_token, p_author_name, p_body, p_ip_hash, p_user_agent);
end $$;

-- ---- the clinician's identity (links that do not name the doctor)
create function public.share_identify(p_session_token text, p_full_name text, p_specialty text, p_license_no text, p_facility text,
                                      p_phone text, p_signature_path text, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_code text; c record;
begin
  select * into c from app.share_contributor_context(p_session_token);
  if c.o_status = 'ok' and (c.o_share).clinician_name is null and c.o_contributor is null then
    v_code := coalesce(app.v_text(p_full_name, 3, 120, 'name', true), null);
    if v_code is not null then return app.invalid('full_name:' || v_code); end if;
    v_code := app.v_text(p_specialty, 1, 120, 'line');
    if v_code is not null then return app.invalid('specialty:' || v_code); end if;
    v_code := app.v_text(p_license_no, 2, 60, 'line');
    if v_code is not null or (p_license_no is not null and btrim(p_license_no) <> '' and btrim(p_license_no) !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{1,59}$') then
      return app.invalid('license_no:' || coalesce(v_code, 'format'));
    end if;
    v_code := app.v_text(p_facility, 2, 200, 'name');
    if v_code is not null then return app.invalid('facility:' || v_code); end if;
    if p_phone is not null and btrim(p_phone) <> '' and (btrim(p_phone) !~ '^\+?[0-9 ()-]{6,24}$' or length(regexp_replace(p_phone, '\D', '', 'g')) not between 7 and 15) then
      return app.invalid('phone:format');
    end if;
    if p_signature_path is null or p_signature_path !~ ('^' || (c.o_share).patient_id::text || '/signatures/[A-Za-z0-9_-]{1,80}\.png$') then return app.invalid('signature:format'); end if;
  end if;
  return app.share_identify_impl(p_session_token, p_full_name, p_specialty, p_license_no, p_facility, p_phone, p_signature_path, p_ip_hash, p_user_agent);
end $$;

-- ---- periodontal chart
create function app.share_check_perio(p_exam jsonb, p_teeth jsonb, p_share public.medical_shares) returns text
language plpgsql stable set search_path = '' as $$
declare v_dob date; v_code text; x jsonb; v_seen int[] := '{}'; v_t int; k text; s jsonb;
begin
  if not app.keys_in(p_exam, array['exam_date', 'notes', 'facility_name', 'encounter_id', 'dx_kind', 'dx_stage', 'dx_grade', 'dx_extent', 'dx_rbl_pct',
                                  'dx_teeth_lost_perio', 'dx_note']) then return 'exam:keys'; end if;
  select date_of_birth into v_dob from public.patients where id = (p_share).patient_id;
  v_code := app.v_date_code(app.try_date(p_exam ->> 'exam_date'), 'past', v_dob, (p_share).date_from, (p_share).date_to, true);
  if v_code is not null then return 'exam_date:' || v_code; end if;
  v_code := coalesce(app.v_field(p_exam, 'notes', 1, 4000, 'text'), app.v_field(p_exam, 'facility_name', 2, 200, 'name'), app.v_field(p_exam, 'dx_note', 1, 2000, 'text'));
  if v_code is not null then return v_code; end if;
  foreach k in array array['dx_kind', 'dx_stage', 'dx_grade', 'dx_extent'] loop
    if p_exam ? k and jsonb_typeof(p_exam -> k) = 'string' and char_length(p_exam ->> k) > 40 then return k || ':enum'; end if;
  end loop;
  if p_exam ? 'dx_rbl_pct' and jsonb_typeof(p_exam -> 'dx_rbl_pct') <> 'null' and not app.num_in(p_exam -> 'dx_rbl_pct', 0, 100, true) then return 'dx_rbl_pct:range'; end if;
  if p_exam ? 'dx_teeth_lost_perio' and jsonb_typeof(p_exam -> 'dx_teeth_lost_perio') <> 'null' and not app.num_in(p_exam -> 'dx_teeth_lost_perio', 0, 32, true) then return 'dx_teeth_lost_perio:range'; end if;
  if jsonb_typeof(p_teeth) <> 'array' or jsonb_array_length(p_teeth) > 32 then return 'teeth:long'; end if;
  for x in select * from jsonb_array_elements(p_teeth) loop
    if not app.keys_in(x, array['tooth', 'missing', 'implant', 'mobility', 'furcation_b', 'furcation_l', 'furcation_m', 'furcation_d', 'pd', 'gm', 'bop', 'plaque',
                               'suppuration', 'note', 'cal']) or not app.fdi_ok(x -> 'tooth', 'permanent') then return 'teeth:teeth'; end if;
    v_t := (x ->> 'tooth')::int;
    if v_t = any (v_seen) then return 'teeth:teeth'; end if;
    v_seen := v_seen || v_t;
    foreach k in array array['mobility', 'furcation_b', 'furcation_l', 'furcation_m', 'furcation_d'] loop
      if x ? k and jsonb_typeof(x -> k) <> 'null' and not app.num_in(x -> k, 0, 3, true) then return 'depth:range'; end if;
    end loop;
    foreach k in array array['pd', 'gm', 'bop', 'plaque', 'suppuration'] loop
      if x ? k and jsonb_typeof(x -> k) <> 'null' then
        if jsonb_typeof(x -> k) <> 'array' or jsonb_array_length(x -> k) <> 6 then return 'depth:format'; end if;
        for s in select * from jsonb_array_elements(x -> k) loop
          if jsonb_typeof(s) = 'null' then continue; end if;
          if k = 'pd' and not app.num_in(s, 0, 20, true) then return 'depth:range'; end if;
          if k = 'gm' and not app.num_in(s, -15, 15, true) then return 'depth:range'; end if;
          if k in ('bop', 'plaque', 'suppuration') and jsonb_typeof(s) <> 'boolean' then return 'depth:format'; end if;
        end loop;
      end if;
    end loop;
    v_code := app.v_field(x, 'note', 1, 500, 'text');
    if v_code is not null then return 'tooth_note:' || split_part(v_code, ':', 2); end if;
  end loop;
  return null;
end $$;

create function public.share_perio_save(p_session_token text, p_exam_id uuid, p_exam jsonb, p_teeth jsonb, p_finalize boolean default false,
                                        p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_reason text;
begin
  select * into pre from app.share_pre(p_session_token, 'perio_exams');
  if pre.o_status is not null then return pre.o_status; end if;
  v_reason := app.share_check_perio(coalesce(p_exam, 'null'::jsonb), coalesce(p_teeth, '[]'::jsonb), pre.o_share);
  if v_reason is not null then return app.invalid(v_reason); end if;
  return app.share_perio_save_impl(p_session_token, p_exam_id, p_exam, p_teeth, p_finalize, p_ip_hash, p_user_agent);
end $$;

-- ---- prescription: every line is complete (name, dose or strength, frequency, a sane duration)
create function public.share_prescription_create(p_session_token text, p_rx jsonb, p_lines jsonb, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text; v_dob date; l jsonb; n int := 0; k text;
begin
  select * into pre from app.share_pre(p_session_token, 'prescriptions');
  if pre.o_status is not null then return pre.o_status; end if;
  if not app.keys_in(p_rx, array['prescriber_name', 'prescriber_license', 'facility_name', 'issued_on', 'notes', 'encounter_id']) then return app.invalid('rx:keys'); end if;
  select date_of_birth into v_dob from public.patients where id = (pre.o_share).patient_id;
  v_code := app.v_date_code(app.try_date(coalesce(p_rx ->> 'issued_on', to_char(current_date, 'YYYY-MM-DD'))), 'past', v_dob, (pre.o_share).date_from, (pre.o_share).date_to, true);
  if v_code is not null then return app.invalid('issued_on:' || v_code); end if;
  v_code := coalesce(app.v_field(p_rx, 'notes', 1, 2000, 'text'), app.v_field(p_rx, 'facility_name', 2, 200, 'name'), app.v_field(p_rx, 'prescriber_license', 2, 60, 'line'));
  if v_code is not null then return app.invalid(v_code); end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 20 then return app.invalid('lines:long'); end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    if not app.keys_in(l, array['name_generic', 'name_brand', 'strength', 'form', 'dose', 'route', 'frequency', 'as_needed', 'quantity', 'duration_days', 'refills',
                               'instructions', 'indication']) then return app.invalid('l' || (n - 1) || '_name_generic:keys'); end if;
    for k in select * from unnest(array['name_generic', 'name_brand', 'strength', 'dose', 'frequency', 'quantity', 'indication', 'instructions']) loop
      v_code := app.v_field(l, k, case when k like 'name%' then 2 else 1 end,
                            case k when 'strength' then 60 when 'dose' then 100 when 'frequency' then 100 when 'quantity' then 60 when 'indication' then 500 when 'instructions' then 2000 else 200 end,
                            case when k = 'instructions' then 'text' else 'line' end);
      if v_code is not null then return app.invalid('l' || (n - 1) || '_' || v_code); end if;
    end loop;
    if l ? 'form' and not (array['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'patch', 'other'] @> array[l ->> 'form']) then return app.invalid('l' || (n - 1) || '_form:enum'); end if;
    if l ? 'route' and not (array['oral', 'iv', 'im', 'sc', 'topical', 'inhaled', 'ophthalmic', 'otic', 'nasal', 'rectal', 'sublingual', 'other'] @> array[l ->> 'route']) then return app.invalid('l' || (n - 1) || '_route:enum'); end if;
    if l ? 'as_needed' and jsonb_typeof(l -> 'as_needed') <> 'boolean' then return app.invalid('l' || (n - 1) || '_as_needed:format'); end if;
    if l ? 'refills' and not app.num_in(l -> 'refills', 0, 24, true) then return app.invalid('l' || (n - 1) || '_refills:range'); end if;
    if not (l ? 'duration_days') or not app.num_in(l -> 'duration_days', 1, 3650, true) then return app.invalid('l' || (n - 1) || '_duration_days:range'); end if;
    if (l ->> 'name_generic') is null and (l ->> 'name_brand') is null then return app.invalid('l' || (n - 1) || '_name_generic:required'); end if;
    if (l ->> 'dose') is null and (l ->> 'strength') is null then return app.invalid('l' || (n - 1) || '_dose:required'); end if;
    if (l ->> 'frequency') is null and coalesce((l ->> 'as_needed')::boolean, false) is false then return app.invalid('l' || (n - 1) || '_frequency:required'); end if;
  end loop;
  return app.share_prescription_create_impl(p_session_token, p_rx, p_lines, p_ip_hash, p_user_agent);
end $$;

-- ---- consent: kind, signer, title, text, and the drawn signature's place
create function public.share_present_consent(p_session_token text, p_consent jsonb, p_signature_path text, p_ip_hash text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text; k text;
begin
  select * into pre from app.share_pre(p_session_token, 'consents');
  if pre.o_status is not null then return pre.o_status; end if;
  if not app.keys_in(p_consent, array['kind', 'title', 'body', 'signer_name', 'signer_role', 'witness_name', 'treatment_plan_id', 'treatment_item_id', 'supersedes']) then
    return app.invalid('consent:keys');
  end if;
  if coalesce(p_consent ->> 'kind', '') not in ('treatment', 'surgery', 'anesthesia', 'imaging', 'sedation', 'other') then return app.invalid('kind:enum'); end if;
  if coalesce(p_consent ->> 'signer_role', '') not in ('patient', 'guardian', 'representative') then return app.invalid('signer_role:enum'); end if;
  v_code := coalesce(app.v_field(p_consent, 'title', 2, 200, 'line', true), app.v_field(p_consent, 'body', 10, 20000, 'text', true),
                     app.v_field(p_consent, 'signer_name', 2, 200, 'name', true), app.v_field(p_consent, 'witness_name', 2, 200, 'name'));
  if v_code is not null then return app.invalid(v_code); end if;
  foreach k in array array['treatment_plan_id', 'treatment_item_id', 'supersedes'] loop
    if p_consent ? k and jsonb_typeof(p_consent -> k) <> 'null'
       and (jsonb_typeof(p_consent -> k) <> 'string' or (p_consent ->> k) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      return app.invalid(k || ':uuid');
    end if;
  end loop;
  if p_signature_path is null or p_signature_path !~ ('^' || (pre.o_share).patient_id::text || '/signatures/[A-Za-z0-9_-]{1,80}\.png$') then return app.invalid('signature:format'); end if;
  return app.share_present_consent_impl(p_session_token, p_consent, p_signature_path, p_ip_hash, p_user_agent);
end $$;

-- ---- an uploaded document: its metadata, and what one link may upload in all (25 files, 100 MB)
create function public.share_register_document(p_session_token text, p_title text, p_doc_type text, p_storage_path text, p_filename text,
                                               p_mime text, p_size bigint, p_sha256 text, p_description text default null,
                                               p_document_date date default null, p_ip_hash text default null, p_user_agent text default null,
                                               p_imaging uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pre record; v_code text; v_dob date; v_files int; v_bytes bigint;
begin
  select * into pre from app.share_pre(p_session_token, 'medical_documents');
  if pre.o_status is not null then return pre.o_status; end if;
  v_code := app.v_text(p_title, 1, 200, 'line', true);
  if v_code is not null then return app.invalid('title:' || v_code); end if;
  v_code := app.v_text(p_description, 1, 1000, 'text');
  if v_code is not null then return app.invalid('description:' || v_code); end if;
  v_code := app.v_text(p_filename, 1, 255, 'line', true);
  if v_code is not null or p_filename ~ '[/\\]' then return app.invalid('file:bad_name'); end if;
  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then return app.invalid('file:bad_type'); end if;
  if p_size is null or p_size < 1 or p_size > 20 * 1024 * 1024 then return app.invalid('file:too_large'); end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then return app.invalid('file:format'); end if;
  if p_storage_path is null or p_storage_path !~ ('^' || (pre.o_share).patient_id::text || '/[A-Za-z0-9_-]{1,80}\.(pdf|jpg|png|webp)$') then return app.invalid('file:format'); end if;
  if p_doc_type is null or p_doc_type not in ('doctor_report', 'lab_report', 'imaging_image', 'imaging_report', 'dental_image', 'prescription', 'operative_report',
                                              'discharge_summary', 'vaccination_record', 'external_record', 'insurance', 'other') then
    return app.invalid('doc_type:enum');
  end if;
  if p_document_date is not null then
    select date_of_birth into v_dob from public.patients where id = (pre.o_share).patient_id;
    v_code := app.v_date_code(p_document_date, 'past', v_dob, null, null);
    if v_code is not null then return app.invalid('document_date:' || v_code); end if;
  end if;
  select count(*), coalesce(sum(d.size_bytes), 0) into v_files, v_bytes
    from public.medical_documents d join public.share_contributors sc on sc.id = d.contributed_by where sc.share_id = (pre.o_share).id;
  if v_files >= 25 then return jsonb_build_object('status', 'limit_files'); end if;
  if v_bytes + p_size > 100 * 1024 * 1024 then return jsonb_build_object('status', 'limit_bytes'); end if;
  return app.share_register_document_impl(p_session_token, p_title, p_doc_type, p_storage_path, p_filename, p_mime, p_size, p_sha256, p_description,
                                          p_document_date, p_ip_hash, p_user_agent, p_imaging);
end $$;

-- ---------------------------------------------------------------- 6. tables
-- the doctor who identified themselves: no markup, no control characters, a real phone number (only new rows are held to it)
alter table public.share_contributors
  add constraint share_contributors_text_chk check (
    full_name !~ '[<>\u0001-\u001f\u007f‪-‮⁦-⁩]'
    and coalesce(specialty, '') !~ '[\u0001-\u001f\u007f]' and coalesce(license_no, '') !~ '[\u0001-\u001f\u007f]'
    and coalesce(facility, '') !~ '[<>\u0001-\u001f\u007f]' and coalesce(phone, '') !~ '[\u0001-\u001f\u007f]') not valid;
alter table public.share_notes
  add constraint share_notes_text_chk check (
    author_name !~ '[<>\u0001-\u001f\u007f‪-‮⁦-⁩]' and body !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]') not valid;

-- ---------------------------------------------------------------- 7. grants
do $$
declare f text;
begin
  foreach f in array array[
    'public.share_contribute(text, text, jsonb, text, text)',
    'public.share_contribute_dental_exam(text, jsonb, jsonb, jsonb, text, text)',
    'public.share_contribute_treatment_plan(text, jsonb, jsonb, text, text)',
    'public.share_add_treatment_item(text, uuid, jsonb, text, text)',
    'public.share_set_cost(text, uuid, numeric, text, text, text, text, text)',
    'public.share_treatment_item_status(text, uuid, text, date, text, boolean, text, text)',
    'public.share_amend_note(text, uuid, text, text, text, text)',
    'public.share_perio_save(text, uuid, jsonb, jsonb, boolean, text, text)',
    'public.share_prescription_create(text, jsonb, jsonb, text, text)',
    'public.share_present_consent(text, jsonb, text, text, text)',
    'public.share_register_document(text, text, text, text, text, text, bigint, text, text, date, text, text, uuid)',
    'public.share_identify(text, text, text, text, text, text, text, text, text)',
    'public.share_add_note(text, text, text, text, text)',
    'public.share_retract(text, text, uuid, text, text, text)',
    'public.share_retract_prescription(text, uuid, text, text, text)',
    'public.share_claim_submission(text, text)',
    'public.share_release_submission(text, text)',
    'public.share_limits(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
-- the original bodies are reachable only through the validating functions
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname like 'share\_%\_impl' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;
revoke all on function app.share_pre(text, text) from public;
revoke all on function app.share_log_burst() from public;
