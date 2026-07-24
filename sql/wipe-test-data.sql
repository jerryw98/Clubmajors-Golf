-- ClubMajors: wipe ALL test data, keep only the two owner accounts.
-- Run in Supabase SQL editor. Transaction-wrapped: all-or-nothing.
begin;

delete from entries;
delete from pool_results;
delete from pools;
delete from club_invites;
delete from payments;
delete from giftcard_log;
delete from validation_alerts;
delete from signup_requests;

delete from profiles
where id not in (
  '652f9860-7c23-434e-95c0-ae0b3c46f4ac',   -- jerryw20180314@gmail.com
  '3981e91e-b2c4-467f-95fd-8ddb3ace11ba'    -- 0wangxinquan0@gmail.com
);

update profiles set club_id = null
where id in (
  '652f9860-7c23-434e-95c0-ae0b3c46f4ac',
  '3981e91e-b2c4-467f-95fd-8ddb3ace11ba'
);
delete from clubs;

delete from auth.users
where id not in (
  '652f9860-7c23-434e-95c0-ae0b3c46f4ac',
  '3981e91e-b2c4-467f-95fd-8ddb3ace11ba'
);

commit;

-- verify:
select (select count(*) from clubs) clubs, (select count(*) from auth.users) users;
