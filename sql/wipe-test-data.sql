-- ClubMajors: LAUNCH-DAY wipe. Deletes every club, pool, entry, payment and
-- account EXCEPT the platform owner (support@clubmajorsgolf.com).
--
-- BEFORE running this:
--   1. Set SEED_TEST_ACCOUNTS=0 in ~/clubmajors/.env
--   2. FORCE_ENV=1 node tools/deploy.js   (otherwise the next deploy quietly
--      recreates test1-10@gmail.com via the admin-setup seeding step)
--
-- Run in the Supabase SQL editor. Transaction-wrapped: all-or-nothing.
begin;

delete from entries;
delete from pool_results;
delete from pools;
delete from club_invites;
delete from payments;
delete from giftcard_log;
delete from validation_alerts;
delete from signup_requests;
delete from backup_snapshots;

update profiles set club_id = null;
delete from profiles
where id not in (select id from auth.users where email = 'support@clubmajorsgolf.com');

delete from clubs;

delete from auth.identities
where user_id not in (select id from auth.users where email = 'support@clubmajorsgolf.com');
delete from auth.users where email <> 'support@clubmajorsgolf.com';

commit;

-- verify: expect clubs=0, users=1 (support@), profiles=1 (owner)
select
  (select count(*) from clubs) clubs,
  (select count(*) from auth.users) users,
  (select count(*) from profiles) profiles;
