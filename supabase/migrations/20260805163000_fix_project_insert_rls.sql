-- Split project policies so INSERT + RETURNING is not blocked by SELECT USING.
drop policy if exists "projects_all_access" on public.projects;

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
