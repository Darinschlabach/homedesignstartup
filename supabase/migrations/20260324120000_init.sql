-- Phase 0 schema + RLS for AI Home Design Platform
create extension if not exists "pgcrypto";

create type public.workspace_type as enum ('personal', 'org');
create type public.org_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.building_type as enum ('home', 'barn', 'shop');
create type public.project_status as enum ('draft', 'active', 'archived');
create type public.message_role as enum ('user', 'assistant', 'system', 'tool');
create type public.asset_kind as enum ('render', 'export', 'upload', 'thumbnail', 'document');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.job_type as enum ('render', 'normalize', 'export_pdf', 'export_dxf', 'export_gltf');
create type public.plan_tier as enum ('free', 'pro', 'team', 'enterprise');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan public.plan_tier not null default 'free',
  branding jsonb,
  sso_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  type public.workspace_type not null,
  name text not null,
  owner_user_id uuid references public.profiles (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint workspaces_owner_or_org check (
    (type = 'personal' and owner_user_id is not null and organization_id is null)
    or (type = 'org' and organization_id is not null)
  )
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  building_type public.building_type not null default 'home',
  status public.project_status not null default 'draft',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.org_role not null default 'viewer',
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create table public.building_revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  revision integer not null,
  model jsonb not null,
  checksum text not null,
  created_by uuid references public.profiles (id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),
  unique (project_id, revision)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role public.message_role not null,
  content text not null,
  tool_calls jsonb,
  revision_id uuid references public.building_revisions (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  kind public.asset_kind not null,
  storage_path text not null,
  mime_type text,
  metadata jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  type public.job_type not null,
  status public.job_status not null default 'queued',
  payload jsonb,
  result jsonb,
  error text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan public.plan_tier not null default 'free',
  status text not null default 'inactive',
  seat_count integer not null default 1,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_user_id uuid references public.profiles (id) on delete set null,
  action text not null,
  resource_type text,
  resource_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  key_hash text not null,
  key_prefix text not null,
  scopes jsonb not null default '[]'::jsonb,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index organization_members_user_idx on public.organization_members (user_id);
create index workspaces_owner_idx on public.workspaces (owner_user_id);
create index workspaces_org_idx on public.workspaces (organization_id);
create index projects_workspace_idx on public.projects (workspace_id);
create index building_revisions_project_idx on public.building_revisions (project_id);
create index messages_conversation_idx on public.messages (conversation_id);
create index jobs_project_idx on public.jobs (project_id);
create index audit_logs_org_idx on public.audit_logs (organization_id);
create index api_keys_org_idx on public.api_keys (organization_id);

-- Membership helpers
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_access_workspace(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws_id
      and (
        (w.type = 'personal' and w.owner_user_id = auth.uid())
        or (w.type = 'org' and public.is_org_member(w.organization_id))
      )
  );
$$;

create or replace function public.can_access_project(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_id
      and (
        public.can_access_workspace(p.workspace_id)
        or exists (
          select 1 from public.project_members pm
          where pm.project_id = p.id and pm.user_id = auth.uid()
        )
      )
  );
$$;

-- Auto-provision profile + personal workspace on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );

  insert into public.workspaces (type, name, owner_user_id)
  values ('personal', 'Personal', new.id);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.workspaces enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.conversations enable row level security;
alter table public.building_revisions enable row level security;
alter table public.messages enable row level security;
alter table public.assets enable row level security;
alter table public.jobs enable row level security;
alter table public.subscriptions enable row level security;
alter table public.audit_logs enable row level security;
alter table public.api_keys enable row level security;

create policy "profiles_select_own_or_org"
  on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.organization_members me
      join public.organization_members them on them.organization_id = me.organization_id
      where me.user_id = auth.uid() and them.user_id = profiles.id
    )
  );

create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid());

create policy "orgs_select_member"
  on public.organizations for select
  using (public.is_org_member(id));

create policy "orgs_insert_authenticated"
  on public.organizations for insert
  with check (auth.uid() is not null);

create policy "orgs_update_admin"
  on public.organizations for update
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

create policy "org_members_select"
  on public.organization_members for select
  using (public.is_org_member(organization_id));

create policy "org_members_insert_admin"
  on public.organization_members for insert
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
    or not exists (
      select 1 from public.organization_members m where m.organization_id = organization_id
    )
  );

create policy "workspaces_select"
  on public.workspaces for select
  using (public.can_access_workspace(id));

create policy "workspaces_insert_personal"
  on public.workspaces for insert
  with check (
    (type = 'personal' and owner_user_id = auth.uid())
    or (type = 'org' and public.is_org_member(organization_id))
  );

create policy "projects_select"
  on public.projects for select
  using (public.can_access_project(id));

create policy "projects_insert"
  on public.projects for insert
  with check (public.can_access_workspace(workspace_id));

create policy "projects_update"
  on public.projects for update
  using (public.can_access_project(id))
  with check (public.can_access_workspace(workspace_id));

create policy "projects_delete"
  on public.projects for delete
  using (public.can_access_project(id));

create policy "project_members_select"
  on public.project_members for select
  using (public.can_access_project(project_id));

create policy "conversations_all"
  on public.conversations for all
  using (public.can_access_project(project_id))
  with check (public.can_access_project(project_id));

create policy "revisions_all"
  on public.building_revisions for all
  using (public.can_access_project(project_id))
  with check (public.can_access_project(project_id));

create policy "messages_all"
  on public.messages for all
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and public.can_access_project(c.project_id)
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and public.can_access_project(c.project_id)
    )
  );

create policy "assets_all"
  on public.assets for all
  using (public.can_access_project(project_id))
  with check (public.can_access_project(project_id));

create policy "jobs_all"
  on public.jobs for all
  using (public.can_access_project(project_id))
  with check (public.can_access_project(project_id));

create policy "subscriptions_select"
  on public.subscriptions for select
  using (public.can_access_workspace(workspace_id));

create policy "audit_logs_select_admin"
  on public.audit_logs for select
  using (
    organization_id is not null
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = audit_logs.organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

create policy "api_keys_admin"
  on public.api_keys for all
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = api_keys.organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = api_keys.organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- Storage buckets
insert into storage.buckets (id, name, public)
values
  ('project-assets', 'project-assets', false),
  ('renders', 'renders', false),
  ('exports', 'exports', false),
  ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatar_public_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatar_own_write"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "project_assets_member_read"
  on storage.objects for select
  using (
    bucket_id in ('project-assets', 'renders', 'exports')
    and auth.role() = 'authenticated'
  );

create policy "project_assets_member_write"
  on storage.objects for insert
  with check (
    bucket_id in ('project-assets', 'renders', 'exports')
    and auth.role() = 'authenticated'
  );
