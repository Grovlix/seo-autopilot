-- Pilot (D67): what a paying pilot client and the agency running it need from the reports that already exist.
-- 1. The monthly work report gains search results: clicks and impressions this month to date against the same days of
--    the month before, from the Search Console history the engine already stores (report "history", daily rows).
-- 2. agency_usage: per website and month, AI cost and work done, for the agency to invoice a pilot by hand.
-- 3. agency_quality: how many AI reports finished on their own and how many needed a person, this week and last.

-- Sum of [clicks, impressions] over daily rows {"YYYY-MM-DD": [clicks, impressions, position]} between two dates.
create or replace function private.history_sum(p_daily jsonb, p_from date, p_to date)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('clicks', coalesce(sum((d.value->>0)::numeric), 0), 'impressions', coalesce(sum((d.value->>1)::numeric), 0), 'days', count(*))
  from jsonb_each(coalesce(p_daily, '{}'::jsonb)) d
  where d.key ~ '^\d{4}-\d{2}-\d{2}$' and d.key::date >= p_from and d.key::date <= p_to and jsonb_typeof(d.value) = 'array';
$$;

create or replace function public.site_work_report(p_site uuid, p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := date_trunc('month', coalesce(p_month, now()::date)::timestamptz); v_to timestamptz;
  v_daily jsonb; v_last date; v_end date; v_search jsonb := null;
begin
  if not (private.is_member(private.site_org(p_site)) or private.is_client_viewer(p_site)) then raise exception 'not allowed'; end if;
  v_to := v_from + interval '1 month';
  -- Search results: the latest stored history; compare the month's days that have data with the same days a month back.
  select m.value->'daily' into v_daily from public.site_memory m
    where m.site_id = p_site and m.kind = 'report' and m.key = 'history' and m.superseded_at is null order by m.created_at desc limit 1;
  if v_daily is not null then
    select max(k::date) into v_last from jsonb_object_keys(v_daily) k where k ~ '^\d{4}-\d{2}-\d{2}$';
    v_end := least(v_last, (v_to - interval '1 day')::date);
    if v_end >= v_from::date then
      v_search := jsonb_build_object('from', v_from::date, 'to', v_end,
        'now', private.history_sum(v_daily, v_from::date, v_end),
        'before', private.history_sum(v_daily, (v_from - interval '1 month')::date, (v_end - interval '1 month')::date),
        'source', 'Google Search Console');
    end if;
  end if;
  return jsonb_build_object(
    'site', (select jsonb_build_object('name', s.name, 'url', s.url) from public.sites s where s.id = p_site),
    'brand', (select jsonb_build_object('name', coalesce(o.brand_name, o.name), 'color', o.brand_color) from public.sites s join public.orgs o on o.id = s.org_id where s.id = p_site),
    'month', to_char(v_from, 'YYYY-MM'),
    'search', v_search,
    'strategy', (select jsonb_build_object('approved', m.value->>'status' = 'approved', 'objective', m.value->>'objective', 'since', m.created_at)
                   from public.site_memory m where m.site_id = p_site and m.kind = 'strategy' and m.key = 'initial' and m.superseded_at is null limit 1),
    'advice', coalesce((select jsonb_agg(jsonb_build_object('title', j.title, 'at', j.updated_at,
                  'recommendations', (select coalesce(jsonb_agg(jsonb_build_object('title', r->>'title', 'url', r->>'url')), '[]'::jsonb) from jsonb_array_elements(coalesce(j.outputs->'proposal'->'recommendations', '[]'::jsonb)) r))
                  order by j.updated_at)
                from public.jobs j where j.site_id = p_site and j.status = 'completed' and j.kind like 'agent:%' and j.updated_at >= v_from and j.updated_at < v_to), '[]'::jsonb),
    'changes', coalesce((select jsonb_agg(jsonb_build_object('title', j.title, 'status', j.status, 'page', j.outputs->'deploy'->>'url', 'mergedAt', j.outputs->'deploy'->>'mergedAt',
                  'verification', j.outputs->'verification'->>'summary') order by j.updated_at)
                from public.jobs j where j.site_id = p_site and j.kind = 'implement' and j.status in ('completed', 'verifying', 'deploying', 'escalated') and j.updated_at >= v_from and j.updated_at < v_to), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('title', x.title, 'status', x.status, 'note', x.agency_note, 'at', x.decided_at) order by x.decided_at)
                from public.submissions x where x.site_id = p_site and x.decided_at >= v_from and x.decided_at < v_to), '[]'::jsonb),
    'audit', (select jsonb_build_object('generatedAt', m.value->>'generatedAt', 'pages', m.value->'summary'->'pagesCrawled', 'bySeverity', m.value->'summary'->'bySeverity')
                from public.site_memory m where m.site_id = p_site and m.kind = 'report' and m.key = 'audit' and m.created_at < v_to order by m.created_at desc limit 1),
    'auditBefore', (select jsonb_build_object('generatedAt', m.value->>'generatedAt', 'pages', m.value->'summary'->'pagesCrawled', 'bySeverity', m.value->'summary'->'bySeverity')
                from public.site_memory m where m.site_id = p_site and m.kind = 'report' and m.key = 'audit' and m.created_at < v_from order by m.created_at desc limit 1));
end $$;

-- Agency members: one row per website of their agencies for the month (default: this month). Clients never see costs.
create or replace function public.agency_usage(p_month date default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select date_trunc('month', coalesce(p_month, now()::date)::timestamptz) f)
  select coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(m.f, 'YYYY-MM'), 'site', s.name, 'url', s.url, 'client', c.name, 'status', s.status,
      'aiCostUsd', coalesce((select round(sum(x.usd), 2) from public.job_costs x where x.site_id = s.id and x.at >= m.f and x.at < m.f + interval '1 month'), 0),
      'agentRuns', (select count(*) from public.job_events e join public.jobs j on j.id = e.job_id where j.site_id = s.id and j.kind like 'agent:%' and e.to_status = 'running' and e.at >= m.f and e.at < m.f + interval '1 month'),
      'adviceAccepted', (select count(*) from public.jobs j where j.site_id = s.id and j.kind like 'agent:%' and j.status = 'completed' and j.updated_at >= m.f and j.updated_at < m.f + interval '1 month'),
      'workCompleted', (select count(*) from public.jobs j where j.site_id = s.id and j.status = 'completed' and j.updated_at >= m.f and j.updated_at < m.f + interval '1 month'),
      'waitingNow', (select count(*) from public.jobs j where j.site_id = s.id and j.status = 'awaiting_approval'))
      order by s.name), '[]'::jsonb)
  from m, public.sites s left join public.clients c on c.id = s.client_id
  where private.is_member(s.org_id);
$$;

-- Agency members: AI reports in a window, by outcome. "Finished" = reviewed and handed to the agency or accepted;
-- "needed a person" = escalated. Counted on the job's last change, per website and in total, for two windows.
create or replace function public.agency_quality(p_days int default 7)
returns jsonb language sql stable security definer set search_path = '' as $$
  with w as (select make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90)) d),
  j as (select j.site_id, j.status, j.updated_at from public.jobs j join public.sites s on s.id = j.site_id
        where private.is_member(s.org_id) and j.kind like 'agent:%' and j.attempts > 0
          and j.status in ('completed', 'awaiting_approval', 'authorized', 'escalated') and j.updated_at > now() - 2 * (select d from w))
  select jsonb_build_object('days', extract(day from (select d from w))::int,
    'now', jsonb_build_object('finished', count(*) filter (where status <> 'escalated' and updated_at > now() - (select d from w)),
                               'escalated', count(*) filter (where status = 'escalated' and updated_at > now() - (select d from w))),
    'before', jsonb_build_object('finished', count(*) filter (where status <> 'escalated' and updated_at <= now() - (select d from w)),
                                  'escalated', count(*) filter (where status = 'escalated' and updated_at <= now() - (select d from w))))
  from j;
$$;

revoke all on function private.history_sum(jsonb, date, date), public.agency_usage(date), public.agency_quality(int) from public, anon, authenticated;
grant execute on function public.agency_usage(date), public.agency_quality(int) to authenticated;
grant execute on function public.site_work_report(uuid, date) to authenticated;
