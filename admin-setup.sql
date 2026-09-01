-- NIGHTON 관리자 상담페이지용 SQL
-- 1) Authentication > Users에서 관리자 이메일/비밀번호 계정을 먼저 생성하세요.
-- 2) 생성한 사용자의 UUID를 아래 INSERT에 넣어 실행하세요.

create table if not exists public.nighton_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.nighton_admins enable row level security;

-- 중요: 아래 UUID를 실제 관리자 Auth User UUID로 교체
-- insert into public.nighton_admins(user_id)
-- values ('여기에-관리자-USER-UUID')
-- on conflict (user_id) do nothing;

create or replace function public.is_nighton_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.nighton_admins
    where user_id = auth.uid()
  );
$$;

grant execute on function public.is_nighton_admin() to authenticated;

create or replace function public.admin_list_nighton_conversations()
returns table (
  id uuid,
  visitor_id text,
  anonymous_name text,
  source text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  last_message text
)
language sql
security definer
set search_path = public
as $$
  select
    c.id,
    c.visitor_id,
    c.anonymous_name,
    c.source,
    c.status,
    c.created_at,
    c.updated_at,
    (
      select m.message
      from public.messages m
      where m.conversation_id = c.id
      order by m.created_at desc
      limit 1
    ) as last_message
  from public.conversations c
  where public.is_nighton_admin()
  order by c.updated_at desc, c.created_at desc;
$$;

grant execute on function public.admin_list_nighton_conversations() to authenticated;

create or replace function public.admin_get_nighton_messages(
  p_conversation_id uuid
)
returns table (
  id uuid,
  sender text,
  message text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select m.id, m.sender, m.message, m.created_at
  from public.messages m
  where public.is_nighton_admin()
    and m.conversation_id = p_conversation_id
  order by m.created_at asc;
$$;

grant execute on function public.admin_get_nighton_messages(uuid) to authenticated;

create or replace function public.admin_send_nighton_message(
  p_conversation_id uuid,
  p_message text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_nighton_admin() then
    raise exception 'Not authorized';
  end if;

  if char_length(trim(p_message)) < 1 or char_length(p_message) > 2000 then
    raise exception 'Invalid message';
  end if;

  insert into public.messages(conversation_id,sender,message)
  values(p_conversation_id,'admin',trim(p_message))
  returning id into v_id;

  update public.conversations
  set updated_at=now(),
      status=case when status='new' then 'consulting' else status end
  where id=p_conversation_id;

  return v_id;
end;
$$;

grant execute on function public.admin_send_nighton_message(uuid,text) to authenticated;

create or replace function public.admin_update_nighton_status(
  p_conversation_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_nighton_admin() then
    raise exception 'Not authorized';
  end if;

  if p_status not in ('new','consulting','interview','completed') then
    raise exception 'Invalid status';
  end if;

  update public.conversations
  set status=p_status, updated_at=now()
  where id=p_conversation_id;
end;
$$;

grant execute on function public.admin_update_nighton_status(uuid,text) to authenticated;
