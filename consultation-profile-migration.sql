-- NIGHTON condition-check -> existing anonymous chat integration.
-- Additive migration only: no existing table/column/data is removed.
create extension if not exists pgcrypto;

create table if not exists public.consultation_profiles (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null unique,
  conversation_id uuid unique references public.conversations(id) on delete set null,
  survey_token_hash text not null,
  adult_confirmed boolean not null default false,
  region text,
  experience text,
  priorities text[] not null default '{}',
  available_time text,
  transport_preference text,
  source text not null default 'condition-check',
  status text not null default 'completed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consultation_profiles_region_check check (region is null or region in ('sillim','gangnam','hongdae','geondae','other')),
  constraint consultation_profiles_experience_check check (experience is null or experience in ('beginner','experienced','researching')),
  constraint consultation_profiles_time_check check (available_time is null or available_time in ('evening','late-night','discuss','undecided')),
  constraint consultation_profiles_transport_check check (transport_preference is null or transport_preference in ('ride-home','own-car','public-transit','nearby','none')),
  constraint consultation_profiles_priority_count check (cardinality(priorities) between 0 and 3)
);

create index if not exists consultation_profiles_conversation_idx on public.consultation_profiles(conversation_id);
create index if not exists consultation_profiles_region_experience_idx on public.consultation_profiles(region,experience);
alter table public.consultation_profiles enable row level security;

-- The browser never reads profiles directly. These narrowly-scoped RPCs validate a random local survey token.
create or replace function public.upsert_nighton_consultation_profile(
  p_visitor_id text,p_survey_token text,p_adult_confirmed boolean,p_region text,p_experience text,
  p_priorities text[],p_available_time text,p_transport_preference text,p_source text default 'condition-check'
) returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare v_id uuid; v_hash text:=encode(digest(p_survey_token,'sha256'),'hex'); v_existing text;
begin
  if p_adult_confirmed is not true or length(p_visitor_id) not between 3 and 80 or length(p_survey_token)<20 then raise exception 'Invalid profile'; end if;
  if p_region not in ('sillim','gangnam','hongdae','geondae','other') or p_experience not in ('beginner','experienced','researching')
    or p_available_time not in ('evening','late-night','discuss','undecided') or p_transport_preference not in ('ride-home','own-car','public-transit','nearby','none')
    or cardinality(p_priorities) not between 1 and 3 or p_priorities <@ array['income','hours','commute','environment','safety','flexibility','unsure']::text[] is not true then raise exception 'Invalid profile values'; end if;
  select survey_token_hash into v_existing from public.consultation_profiles where visitor_id=p_visitor_id;
  if v_existing is not null and v_existing<>v_hash then raise exception 'Not authorized'; end if;
  insert into public.consultation_profiles(visitor_id,survey_token_hash,adult_confirmed,region,experience,priorities,available_time,transport_preference,source)
  values(p_visitor_id,v_hash,true,p_region,p_experience,p_priorities,p_available_time,p_transport_preference,coalesce(nullif(p_source,''),'condition-check'))
  on conflict(visitor_id) do update set adult_confirmed=true,region=excluded.region,experience=excluded.experience,priorities=excluded.priorities,available_time=excluded.available_time,transport_preference=excluded.transport_preference,source=excluded.source,updated_at=now()
  returning id into v_id; return v_id;
end$$;

create or replace function public.link_nighton_consultation_profile(p_visitor_id text,p_survey_token text,p_conversation_id uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
begin
  if not exists(select 1 from public.consultation_profiles p where p.visitor_id=p_visitor_id and p.survey_token_hash=encode(digest(p_survey_token,'sha256'),'hex')) then raise exception 'Not authorized'; end if;
  if not exists(select 1 from public.conversations c where c.id=p_conversation_id and c.visitor_id=p_visitor_id) then raise exception 'Conversation mismatch'; end if;
  update public.consultation_profiles set conversation_id=p_conversation_id,updated_at=now() where visitor_id=p_visitor_id;
end$$;

revoke all on public.consultation_profiles from anon,authenticated;
revoke all on function public.upsert_nighton_consultation_profile(text,text,boolean,text,text,text[],text,text,text) from public;
revoke all on function public.link_nighton_consultation_profile(text,text,uuid) from public;
grant execute on function public.upsert_nighton_consultation_profile(text,text,boolean,text,text,text[],text,text,text) to anon,authenticated;
grant execute on function public.link_nighton_consultation_profile(text,text,uuid) to anon,authenticated;

-- New version avoids changing or dropping the existing admin list RPC.
create or replace function public.admin_list_nighton_conversations_v2()
returns table(id uuid,visitor_id text,anonymous_name text,source text,status text,created_at timestamptz,updated_at timestamptz,last_message text,last_sender text,profile_adult boolean,profile_region text,profile_experience text,profile_priorities text[],profile_available_time text,profile_transport text,profile_source text,profile_completed_at timestamptz)
language sql security definer set search_path=public as $$
 select c.id,c.visitor_id,c.anonymous_name,c.source,c.status,c.created_at,c.updated_at,
  lm.message,lm.sender,p.adult_confirmed,p.region,p.experience,p.priorities,p.available_time,p.transport_preference,p.source,p.updated_at
 from public.conversations c
 left join public.consultation_profiles p on p.conversation_id=c.id
 left join lateral(select m.message,m.sender from public.messages m where m.conversation_id=c.id order by m.created_at desc limit 1) lm on true
 where public.is_nighton_admin() order by c.updated_at desc,c.created_at desc;
$$;
revoke all on function public.admin_list_nighton_conversations_v2() from public;
grant execute on function public.admin_list_nighton_conversations_v2() to authenticated;
