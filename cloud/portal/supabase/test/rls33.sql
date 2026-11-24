-- Pilot reports (20261127000000_pilot_reports.sql, D67). Run after rls32.sql.
-- Covers: the monthly work report's search results (this month to date against the same days a month back, from the
-- stored Search Console history); agency_usage and agency_quality for agency members only, never for another agency.
\set ON_ERROR_STOP on

-- Setup (superuser): Alice's site gets a history with 3 days this month and the same 3 days last month, plus one day
-- after the last day this month has data for (must not count), and two AI jobs: one finished, one escalated, with a cost.
do $$ declare site uuid := (select v from ids where k = 'alice_site'); org uuid; f date := date_trunc('month', now())::date; j1 uuid; j2 uuid; begin
  select org_id into org from public.sites where id = site;
  insert into public.site_memory (org_id, site_id, kind, key, value, basis, created_by) values (org, site, 'report', 'history',
    jsonb_build_object('daily', jsonb_build_object(
      to_char(f, 'YYYY-MM-DD'), jsonb_build_array(10, 100, 5), to_char(f + 1, 'YYYY-MM-DD'), jsonb_build_array(20, 200, 5), to_char(f + 2, 'YYYY-MM-DD'), jsonb_build_array(30, 300, 5),
      to_char((f - interval '1 month')::date, 'YYYY-MM-DD'), jsonb_build_array(5, 50, 6), to_char((f - interval '1 month')::date + 1, 'YYYY-MM-DD'), jsonb_build_array(5, 50, 6),
      to_char((f - interval '1 month')::date + 2, 'YYYY-MM-DD'), jsonb_build_array(5, 50, 6), to_char((f - interval '1 month')::date + 3, 'YYYY-MM-DD'), jsonb_build_array(999, 9999, 6))), 'verified', 'test');
  insert into public.jobs (org_id, site_id, kind, title, source, risk, status, attempts) values (org, site, 'agent:seo-reporter', 'Ok', 'seo_god', 'low', 'completed', 1) returning id into j1;
  insert into public.jobs (org_id, site_id, kind, title, source, risk, status, attempts) values (org, site, 'agent:seo-reporter', 'Stuck', 'seo_god', 'low', 'escalated', 2) returning id into j2;
  insert into public.job_costs (org_id, site_id, job_id, usd) values (org, site, j1, 0.40), (org, site, j2, 0.35);
  create temp table p_ids (k text primary key, v uuid); insert into p_ids values ('j1', j1), ('j2', j2);
end $$;
grant all on p_ids to authenticated;

set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ declare r jsonb; u jsonb; q jsonb; site uuid := (select v from ids where k = 'alice_site'); row jsonb; begin
  r := public.site_work_report(site, null);
  assert r->'search' is not null, 'search results present: ' || coalesce(r::text, 'null');
  assert (r->'search'->'now'->>'clicks')::numeric = 60 and (r->'search'->'now'->>'impressions')::numeric = 600, 'this month: ' || (r->'search')::text;
  assert (r->'search'->'before'->>'clicks')::numeric = 15 and (r->'search'->'before'->>'days')::int = 3, 'same days last month only: ' || (r->'search')::text;
  u := public.agency_usage(null);
  select x into row from jsonb_array_elements(u) x where x->>'site' = (select name from public.sites where id = site);
  assert (row->>'aiCostUsd')::numeric >= 0.75, 'usage cost: ' || coalesce(row::text, 'missing');
  assert (row->>'adviceAccepted')::int >= 1, 'advice accepted counted';
  q := public.agency_quality(7);
  assert (q->'now'->>'finished')::int >= 1 and (q->'now'->>'escalated')::int >= 1, 'quality: ' || q::text;
end $$;
reset role;

-- Bob (another agency) sees none of Alice's websites.
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ declare u jsonb := public.agency_usage(null); begin
  assert not exists (select 1 from jsonb_array_elements(u) x where x->>'site' = (select name from public.sites where id = (select v from ids where k = 'alice_site'))), 'another agency cannot see usage';
end $$;
reset role;

-- Not callable without signing in.
set role anon; set request.jwt.claim.role = 'anon'; set request.jwt.claim.sub = '';
do $$ declare refused boolean; begin
  begin perform public.agency_usage(null); refused := false; exception when others then refused := true; end;
  assert refused, 'anon refused';
end $$;
reset role;
delete from public.jobs where id in (select v from p_ids);
delete from public.site_memory where site_id = (select v from ids where k = 'alice_site') and kind = 'report' and key = 'history' and created_by = 'test';
\echo rls33 ok
