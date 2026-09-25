-- Run this once in your Supabase project: Dashboard > SQL Editor > New query > paste > Run.
-- Choose an EU region (e.g. Frankfurt) when you create the project.

create table if not exists public.pirads_reads (
    study_id            text not null,
    reader              text not null,
    case_id             text not null,           -- pseudonymized case ID (folder name)
    status              text not null,           -- in_progress | completed
    stage               int  not null,           -- 1 = image-only, 2 = with PSA/volume
    image_only_pirads   int,
    final_pirads        int,
    image_only_read     jsonb,                   -- lesions + scores frozen at stage-1 submit
    final_read          jsonb,                   -- lesions + scores at final submit
    draft               jsonb,                   -- current work for unfinished cases
    stage1_seconds      numeric,
    stage2_seconds      numeric,
    started_at          timestamptz,
    stage1_submitted_at timestamptz,
    completed_at        timestamptz,
    updated_at          timestamptz,
    received_at         timestamptz default now(),
    primary key (study_id, reader, case_id)
);

-- Row Level Security on and no policies: only the service_role key (kept on the
-- clinic PC) can read or write. Nobody with the public anon key can see anything.
alter table public.pirads_reads enable row level security;

-- One row per lesion, convenient for analysis (Table editor > pirads_lesions)
create or replace view public.pirads_lesions with (security_invoker = true) as
select r.study_id, r.reader, r.case_id, s.read_stage,
       l ->> 'id'                  as lesion,
       (l ->> 'pirads')::int       as pirads,
       l ->> 'zone'                as zone,
       l ->> 'level'               as level,
       l ->> 'side'                as side,
       (l -> 'ras' ->> 0)::numeric as ras_x,
       (l -> 'ras' ->> 1)::numeric as ras_y,
       (l -> 'ras' ->> 2)::numeric as ras_z,
       l ->> 'comment'             as comment
from public.pirads_reads r
cross join lateral (values ('image_only', r.image_only_read), ('final', r.final_read)) as s(read_stage, doc)
cross join lateral jsonb_array_elements(coalesce(s.doc -> 'lesions', '[]'::jsonb)) as l;
