begin;

alter table companion_private.companion_imports add column request_hash text;
update companion_private.companion_imports
set request_hash=encode(public.digest('legacy-import:'||id::text||':'||original_sha256,'sha256'),'hex')
where request_hash is null;
alter table companion_private.companion_imports
  alter column request_hash set not null,
  add constraint companion_imports_request_hash_check check (request_hash~'^[a-f0-9]{64}$');

alter table companion_private.import_findings add column finding_key text;
update companion_private.import_findings set finding_key=id::text where finding_key is null;
alter table companion_private.import_findings alter column finding_key set not null;
create unique index import_findings_import_key_unique on companion_private.import_findings(import_id,finding_key);

create or replace function companion_private.import_review_payload(p_import companion_private.companion_imports)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id',p_import.id,
    'status',p_import.status,
    'statusHistory',p_import.status_history,
    'originalSha256',p_import.original_sha256,
    'byteLength',p_import.byte_length,
    'parserVersion',p_import.parser_version,
    'policyVersion',p_import.policy_version,
    'sourceFormat',p_import.source_format,
    'draft',p_import.normalized_draft,
    'findings',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',f.finding_key,'type',f.finding_type,'severity',f.severity,
        'sourcePath',f.source_path,'action',f.action,'evidenceHash',f.evidence_hash,
        'safePreview',f.safe_preview
      )) order by f.created_at,f.id)
      from companion_private.import_findings f where f.import_id=p_import.id
    ),'[]'::jsonb),
    'rejectionCode',p_import.rejection_code,
    'approvedIdentityId',p_import.approved_identity_id
  ))
$$;

create or replace function companion_private.identity_payload(p_identity public.companion_identities)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id',p_identity.id,
    'companionId',p_identity.companion_id,
    'version',p_identity.version,
    'displayName',p_identity.display_name,
    'identitySummary',p_identity.identity_document->>'identitySummary',
    'personaTraits',coalesce(p_identity.identity_document->'personaTraits','[]'::jsonb),
    'speakingStyle',coalesce(p_identity.identity_document->'speakingStyle','{}'::jsonb),
    'values',coalesce(p_identity.identity_document->'values','[]'::jsonb),
    'boundaries',coalesce(p_identity.identity_document->'boundaries','[]'::jsonb),
    'aspirations',coalesce(p_identity.identity_document->'aspirations','[]'::jsonb),
    'appearance',coalesce(p_identity.identity_document->'appearance','{}'::jsonb),
    'pronouns',p_identity.identity_document->>'pronouns',
    'togetherSince',p_identity.identity_document->>'togetherSince',
    'sourceManifest',p_identity.source_manifest,
    'contentHash',p_identity.content_hash,
    'createdBy',p_identity.created_by,
    'approvedByOwnerAt',p_identity.approved_by_owner_at,
    'supersedesIdentityId',p_identity.supersedes_identity_id
  ))
$$;

create or replace function public.create_companion_import(
  p_raw_payload text,
  p_original_sha256 text,
  p_byte_length integer,
  p_parser_version text,
  p_policy_version text,
  p_source_format text,
  p_draft jsonb,
  p_findings jsonb,
  p_idempotency_key_hash text,
  p_request_hash text
) returns table(payload jsonb)
language plpgsql security definer set search_path='' as $$
declare actor public.owners%rowtype; existing companion_private.companion_imports%rowtype; created companion_private.companion_imports%rowtype; f jsonb; new_id uuid:=gen_random_uuid();
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_raw_payload is null or p_byte_length<1 or p_byte_length>262144
    or p_original_sha256!~'^[a-f0-9]{64}$' or p_idempotency_key_hash!~'^[a-f0-9]{64}$'
    or p_request_hash!~'^[a-f0-9]{64}$' or p_source_format not in ('CHARACTER_CARD_JSON_V2','LEGACY_CHARACTER_JSON')
    or p_draft is null or jsonb_typeof(p_draft)<>'object' or p_findings is null or jsonb_typeof(p_findings)<>'array' then
    raise exception using errcode='22023',message='invalid sanitized Companion import';
  end if;
  if octet_length(convert_to(p_raw_payload,'UTF8'))<>p_byte_length
    or encode(public.digest(convert_to(p_raw_payload,'UTF8'),'sha256'),'hex')<>p_original_sha256 then
    raise exception using errcode='22023',message='Companion import payload attribution mismatch';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.companion_imports
    where owner_id=actor.id and import_idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.request_hash<>p_request_hash or existing.original_sha256<>p_original_sha256 then
      raise exception using errcode='23505',message='Companion import idempotency key reused with a different request';
    end if;
    return query select companion_private.import_review_payload(existing); return;
  end if;

  insert into companion_private.companion_imports(
    id,owner_id,status,status_history,original_sha256,byte_length,parser_version,policy_version,
    source_format,raw_payload,normalized_draft,import_idempotency_key_hash,request_hash
  ) values(
    new_id,actor.id,'REVIEWABLE','["UPLOADED","QUARANTINED","REVIEWABLE"]'::jsonb,
    p_original_sha256,p_byte_length,p_parser_version,p_policy_version,p_source_format,
    convert_to(p_raw_payload,'UTF8'),p_draft,p_idempotency_key_hash,p_request_hash
  ) returning * into created;

  for f in select * from jsonb_array_elements(p_findings) loop
    if coalesce(f->>'id','')='' or coalesce(f->>'type','')='' or coalesce(f->>'severity','')=''
      or coalesce(f->>'sourcePath','')='' or coalesce(f->>'action','')='' or coalesce(f->>'evidenceHash','')!~'^[a-f0-9]{64}$' then
      raise exception using errcode='22023',message='invalid sanitized import finding';
    end if;
    insert into companion_private.import_findings(
      import_id,finding_key,finding_type,severity,source_path,action,evidence_hash,safe_preview
    ) values(
      new_id,f->>'id',f->>'type',f->>'severity',f->>'sourcePath',f->>'action',f->>'evidenceHash',f->>'safePreview'
    );
  end loop;

  insert into public.audit_events(id,owner_id,actor_type,actor_id,action,target_type,target_id,after_hash,occurred_at)
  values(gen_random_uuid(),actor.id,'OWNER',actor.id,'COMPANION_IMPORT_CREATED','COMPANION_IMPORT',new_id,p_original_sha256,statement_timestamp());

  return query select companion_private.import_review_payload(created);
end $$;

create or replace function public.get_companion_import_review(p_import_id uuid)
returns table(payload jsonb)
language plpgsql stable security definer set search_path='' as $$
declare actor public.owners%rowtype; found_import companion_private.companion_imports%rowtype;
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  select * into found_import from companion_private.companion_imports where id=p_import_id and owner_id=actor.id;
  if not found then return; end if;
  return query select companion_private.import_review_payload(found_import);
end $$;

create or replace function public.approve_companion_import(
  p_import_id uuid,
  p_approved_candidate_ids text[],
  p_companion_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text
) returns table(payload jsonb)
language plpgsql security definer set search_path='' as $$
declare
  actor public.owners%rowtype;
  import_row companion_private.companion_imports%rowtype;
  existing companion_private.approval_idempotency%rowtype;
  companion_row public.companions%rowtype;
  current_identity public.companion_identities%rowtype;
  identity_row public.companion_identities%rowtype;
  candidate jsonb;
  identity_doc jsonb:='{}'::jsonb;
  source_manifest jsonb;
  display_name text;
  next_version integer;
  new_companion_id uuid;
  new_identity_id uuid:=gen_random_uuid();
  content_hash text;
  approved_at timestamptz:=statement_timestamp();
begin
  select * into actor from public.owners where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception using errcode='42501',message='active Owner authentication is required'; end if;
  if p_idempotency_key_hash!~'^[a-f0-9]{64}$' or p_request_hash!~'^[a-f0-9]{64}$'
    or p_approved_candidate_ids is null or cardinality(p_approved_candidate_ids)<1
    or (select count(*) from unnest(p_approved_candidate_ids) x)<>(select count(distinct x) from unnest(p_approved_candidate_ids) x) then
    raise exception using errcode='22023',message='invalid Companion import approval';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor.id::text||':'||p_idempotency_key_hash,0));
  select * into existing from companion_private.approval_idempotency where owner_id=actor.id and idempotency_key_hash=p_idempotency_key_hash;
  if found then
    if existing.request_hash<>p_request_hash then raise exception using errcode='23505',message='Companion approval idempotency key reused with a different request'; end if;
    select * into identity_row from public.companion_identities where id=existing.identity_id and owner_id=actor.id;
    return query select companion_private.identity_payload(identity_row); return;
  end if;

  select * into import_row from companion_private.companion_imports where id=p_import_id and owner_id=actor.id for update;
  if not found then raise exception using errcode='P0001',message='Companion import not found'; end if;
  if import_row.status<>'REVIEWABLE' or import_row.normalized_draft is null then
    raise exception using errcode='55000',message='only a reviewable Companion import may be approved';
  end if;

  foreach candidate in array array(select value from jsonb_array_elements(import_row.normalized_draft->'candidates')) loop
    if (candidate->>'id')=any(p_approved_candidate_ids) then
      if coalesce((candidate->>'approvable')::boolean,false) is not true then
        raise exception using errcode='22023',message='blocked identity candidate cannot be approved';
      end if;
      identity_doc:=identity_doc||jsonb_build_object(candidate->>'field',candidate->'value');
      if candidate->>'field'='displayName' then display_name:=candidate->>'value'; end if;
    end if;
  end loop;

  if display_name is null or btrim(display_name)='' then
    raise exception using errcode='22023',message='display name candidate must be explicitly approved';
  end if;
  if exists(
    select 1 from unnest(p_approved_candidate_ids) requested
    where not exists(select 1 from jsonb_array_elements(import_row.normalized_draft->'candidates') c where c->>'id'=requested)
  ) then raise exception using errcode='22023',message='approval references an unknown candidate'; end if;

  if p_companion_id is null then
    new_companion_id:=gen_random_uuid();
    insert into public.companions(id,owner_id,status,origin_type,private_runtime_enabled)
    values(new_companion_id,actor.id,'ACTIVE','IMPORTED_CARD',false)
    returning * into companion_row;
  else
    select * into companion_row from public.companions where id=p_companion_id and owner_id=actor.id and status not in ('DELETED','QUARANTINED') for update;
    if not found then raise exception using errcode='P0001',message='Companion not found for authenticated Owner'; end if;
    new_companion_id:=companion_row.id;
  end if;

  if companion_row.current_identity_version_id is not null then
    select * into current_identity from public.companion_identities
    where id=companion_row.current_identity_version_id and companion_id=companion_row.id and owner_id=actor.id;
  end if;
  next_version:=coalesce(current_identity.version,0)+1;
  source_manifest:=jsonb_build_object(
    'importId',import_row.id,'originalSha256',import_row.original_sha256,
    'parserVersion',import_row.parser_version,'policyVersion',import_row.policy_version,
    'approvedCandidateIds',(select jsonb_agg(x order by x) from unnest(p_approved_candidate_ids) x)
  );
  content_hash:=encode(public.digest((jsonb_build_object(
    'companionId',new_companion_id,'version',next_version,'displayName',display_name,
    'identityDocument',identity_doc,'sourceManifest',source_manifest
  ))::text,'sha256'),'hex');

  insert into public.companion_identities(
    id,owner_id,companion_id,version,display_name,identity_document,source_manifest,content_hash,
    created_by,approved_by_owner_at,supersedes_identity_id
  ) values(
    new_identity_id,actor.id,new_companion_id,next_version,display_name,identity_doc,source_manifest,content_hash,
    'IMPORT_FIREWALL',approved_at,current_identity.id
  ) returning * into identity_row;

  update public.companions set current_identity_version_id=new_identity_id,updated_at=approved_at
  where id=new_companion_id and owner_id=actor.id;

  update companion_private.companion_imports set
    companion_id=new_companion_id,status='APPROVED',
    status_history=status_history||'"APPROVED"'::jsonb,approved_identity_id=new_identity_id,updated_at=approved_at
  where id=import_row.id and owner_id=actor.id;

  insert into companion_private.approval_idempotency(owner_id,idempotency_key_hash,request_hash,identity_id)
  values(actor.id,p_idempotency_key_hash,p_request_hash,new_identity_id);

  insert into public.audit_events(id,owner_id,companion_id,actor_type,actor_id,action,target_type,target_id,after_hash,occurred_at)
  values(gen_random_uuid(),actor.id,new_companion_id,'OWNER',actor.id,'COMPANION_IDENTITY_APPROVED','COMPANION_IDENTITY',new_identity_id,content_hash,approved_at);

  return query select companion_private.identity_payload(identity_row);
end $$;

revoke all on function companion_private.import_review_payload(companion_private.companion_imports), companion_private.identity_payload(public.companion_identities) from public,anon,authenticated;
grant execute on function companion_private.import_review_payload(companion_private.companion_imports), companion_private.identity_payload(public.companion_identities) to service_role;
revoke all on function public.create_companion_import(text,text,integer,text,text,text,jsonb,jsonb,text,text), public.get_companion_import_review(uuid), public.approve_companion_import(uuid,text[],uuid,text,text) from public,anon;
grant execute on function public.create_companion_import(text,text,integer,text,text,text,jsonb,jsonb,text,text), public.get_companion_import_review(uuid), public.approve_companion_import(uuid,text[],uuid,text,text) to authenticated,service_role;

comment on function public.create_companion_import(text,text,integer,text,text,text,jsonb,jsonb,text,text) is 'Persists only server-sanitized Import Firewall output plus private quarantine bytes; exact replay rejects substitution.';
comment on function public.approve_companion_import(uuid,text[],uuid,text,text) is 'Atomically creates or versions an Owner-approved Companion identity from approvable Import Firewall candidates; failure exposes no half-resident.';

commit;
