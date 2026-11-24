-- D66: the approval rule holds even for rows changed outside the job functions, and such rows are traceable.
-- Production 2026-11-19: three gated jobs were inserted straight into public.jobs (no "proposed" event, no audit row, no
-- idempotency key, $0 budget), and two were later set to "authorized" with no approval row. private.move_job refuses
-- that move, but a direct UPDATE bypassed it, and every planning run for the site then failed on those rows.

-- 1. Work that needs approval cannot be queued, run, authorized or deployed unless the latest agency decision is
--    "approve", whichever way the row is written (same rule as private.move_job, which stays the normal path).
create or replace function private.jobs_approval_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.requires_approval and new.status in ('queued', 'running', 'authorized', 'deploying')
     and (tg_op = 'INSERT' or new.status is distinct from old.status)
     and not coalesce((select a.decision = 'approve' from public.approvals a where a.job_id = new.id order by a.id desc limit 1), false) then
    raise exception 'job needs agency approval first';
  end if;
  return new;
end;
$$;
drop trigger if exists jobs_approval_guard on public.jobs;
create trigger jobs_approval_guard before insert or update of status on public.jobs
  for each row execute function private.jobs_approval_guard();

-- 2. A job inserted without the job functions (they always write a "proposed" event in the same transaction) gets that
--    event and an audit row at commit, naming the database role and client, so its origin can be traced.
create or replace function private.jobs_trace_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_who jsonb := jsonb_build_object('session_user', session_user::text, 'application_name', current_setting('application_name', true),
  'jwt_role', current_setting('request.jwt.claim.role', true), 'jwt_sub', nullif(current_setting('request.jwt.claim.sub', true), ''));
begin
  if exists (select 1 from public.jobs where id = new.id) and not exists (select 1 from public.job_events e where e.job_id = new.id) then
    insert into public.job_events (job_id, org_id, actor_kind, actor, to_status, note, data)
      values (new.id, new.org_id, 'system', 'direct-insert', new.status, 'inserted outside the job functions', v_who);
    insert into public.audit_log (org_id, site_id, actor, action, target, data)
      values (new.org_id, new.site_id, null, 'job.insert_direct', new.id::text, v_who);
  end if;
  return null;
end;
$$;
drop trigger if exists jobs_trace_insert on public.jobs;
create constraint trigger jobs_trace_insert after insert on public.jobs deferrable initially deferred
  for each row execute function private.jobs_trace_insert();
revoke all on function private.jobs_approval_guard(), private.jobs_trace_insert() from public, anon, authenticated;
