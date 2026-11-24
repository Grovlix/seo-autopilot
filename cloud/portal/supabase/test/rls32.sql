-- Job guards (20261126000000_job_guards.sql, D66). Run after rls31.sql.
-- Covers: a gated job cannot be inserted as authorized/queued, nor updated to authorized or queued, without an approval
-- row (direct SQL, not only through the job functions); with an "approve" row it can; ungated jobs are unaffected; a job
-- inserted directly gets a "proposed"-style event and a job.insert_direct audit row; create_job adds neither.
\set ON_ERROR_STOP on
create temp table k_ids (k text primary key, v uuid);
grant all on k_ids to authenticated, service_role, anon;

do $$ declare site uuid := (select v from ids where k = 'alice_site'); org uuid; refused boolean; begin
  select org_id into org from public.sites where id = site;
  -- Inserted already authorized, gated, no approval: refused.
  begin
    insert into public.jobs (org_id, site_id, kind, title, source, risk, requires_approval, status) values (org, site, 'agent:seo-technical-fixer', 'Direct', 'seo_god', 'low', true, 'authorized');
    refused := false;
  exception when others then refused := sqlerrm like '%agency approval first%'; end;
  assert refused, 'gated job inserted as authorized must be refused';
  -- Inserted waiting for approval: allowed (and traced at commit).
  with x as (insert into public.jobs (org_id, site_id, kind, title, source, risk, requires_approval, status) values (org, site, 'agent:seo-technical-fixer', 'Direct gated', 'seo_god', 'low', true, 'awaiting_approval') returning id) insert into k_ids select 'gated', id from x;
  with x as (insert into public.jobs (org_id, site_id, kind, title, source, risk, status) values (org, site, 'scan', 'Direct free', 'seo_god', 'low', 'queued') returning id) insert into k_ids select 'free', id from x;
end $$;

-- Traced at commit (the block above committed): one event and one audit row each, naming the database role.
do $$ begin
  assert (select count(*) from public.job_events where job_id = (select v from k_ids where k = 'gated') and actor = 'direct-insert') = 1, 'direct insert gets an event';
  assert (select count(*) from public.audit_log where action = 'job.insert_direct' and target = (select v from k_ids where k = 'gated')::text and data ? 'session_user') = 1, 'direct insert audited';
  assert (select count(*) from public.job_events where job_id = (select v from k_ids where k = 'free') and actor = 'direct-insert') = 1, 'ungated direct insert traced too';
end $$;

-- A direct UPDATE to authorized or queued without an approval row: refused. Ungated work moves freely.
do $$ declare refused boolean; begin
  begin update public.jobs set status = 'authorized' where id = (select v from k_ids where k = 'gated'); refused := false;
  exception when others then refused := sqlerrm like '%agency approval first%'; end;
  assert refused, 'direct update to authorized refused';
  begin update public.jobs set status = 'queued' where id = (select v from k_ids where k = 'gated'); refused := false;
  exception when others then refused := sqlerrm like '%agency approval first%'; end;
  assert refused, 'direct update to queued refused';
  update public.jobs set status = 'running' where id = (select v from k_ids where k = 'free');
  update public.jobs set title = 'Renamed' where id = (select v from k_ids where k = 'gated'); -- other columns are untouched by the guard
end $$;

-- Alice approves through approve_job: the normal path still works, and later moves are allowed.
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare j public.jobs; begin
  j := public.approve_job((select v from k_ids where k = 'gated'), 'approve', 'ok');
  assert j.status = 'authorized', 'approved: ' || j.status;
end $$;
reset role;
set role service_role; set request.jwt.claim.role = 'service_role'; set request.jwt.claim.sub = '';
do $$ declare j public.jobs; site uuid := (select v from ids where k = 'alice_site'); begin
  j := public.transition_job((select v from k_ids where k = 'gated'), 'queued', 'test', 'run it');
  assert j.status = 'queued', 'queued after approval';
  -- create_job writes its own "proposed" event: no direct-insert trace.
  j := public.create_job(site, 'scan', 'Through create_job', 'seo_god');
  insert into k_ids values ('fn', j.id);
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.job_events where job_id = (select v from k_ids where k = 'fn') and actor = 'direct-insert'), 'create_job is not traced as direct';
  assert not exists (select 1 from public.audit_log where action = 'job.insert_direct' and target = (select v from k_ids where k = 'fn')::text), 'create_job not audited as direct';
end $$;
delete from public.jobs where id in (select v from k_ids);
\echo rls32 ok
