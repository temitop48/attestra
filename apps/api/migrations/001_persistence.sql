create table if not exists attest_execution_records (
  execution_id text primary key,
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists attest_execution_records_created_at_idx on attest_execution_records (created_at desc);

create table if not exists attest_verifier_submissions (
  idempotency_key text primary key,
  execution_id text not null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists attest_verifier_submissions_execution_idx on attest_verifier_submissions (execution_id);
