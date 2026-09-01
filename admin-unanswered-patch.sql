-- NIGHTON 관리자 상담목록 미답변 표시 패치
drop function if exists public.admin_list_nighton_conversations();

create function public.admin_list_nighton_conversations()
returns table (
  id uuid,
  visitor_id text,
  anonymous_name text,
  source text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  last_message text,
  last_sender text
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
    ) as last_message,
    (
      select m.sender
      from public.messages m
      where m.conversation_id = c.id
      order by m.created_at desc
      limit 1
    ) as last_sender
  from public.conversations c
  where public.is_nighton_admin()
  order by c.updated_at desc, c.created_at desc;
$$;

grant execute on function public.admin_list_nighton_conversations()
to authenticated;
