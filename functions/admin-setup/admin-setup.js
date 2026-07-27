/* v2 — step filter via ?only= */
/* TEMPORARY admin function — applies Supabase email branding + schema/deadline
   updates via the Management API, server-side (no browser CORS limits).
   Guarded by a one-time key. REMOVE this function (and revoke the Supabase
   token) in the next deploy once it has run successfully. */

const SUPA_TOKEN = process.env.SUPA_MGMT_TOKEN || "";
const REF = "tocnkbgxbnvznhwpfgpa";
const GUARD = process.env.SETUP_KEY || "";
const API = "https://api.supabase.com/v1/projects/" + REF;

function shell(title, intro, button, href) {
  return '<div style="background:#F7F2E4;padding:32px 0;font-family:Georgia,serif;">' +
    '<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E2DCC8;">' +
    '<div style="background:#15382B;padding:22px 28px;">' +
    '<div style="color:#D8B45A;font-family:Courier,monospace;font-size:13px;letter-spacing:0.3em;">CLUBMAJORS</div>' +
    '<div style="color:#F7F2E4;font-size:11px;font-family:Courier,monospace;letter-spacing:0.12em;margin-top:4px;">GOLF TOURNAMENT POOLS FOR PRIVATE CLUBS</div>' +
    '</div>' +
    '<div style="padding:28px;">' +
    '<h2 style="margin:0 0 12px;font-size:19px;color:#15382B;">' + title + '</h2>' +
    '<p style="font-size:14px;line-height:1.6;color:#333;margin:0 0 22px;">' + intro + '</p>' +
    '<a href="' + href + '" style="display:inline-block;background:#15382B;color:#F7F2E4;text-decoration:none;padding:12px 26px;font-size:14px;letter-spacing:0.06em;">' + button + '</a>' +
    '<p style="font-size:12px;color:#888;margin:26px 0 0;line-height:1.6;">If you didn\'t request this email, you can safely ignore it. This link expires shortly and can only be used once.</p>' +
    '</div>' +
    '<div style="border-top:1px solid #E2DCC8;padding:14px 28px;font-size:11px;color:#999;">ClubMajors · pool software for entertainment purposes only · we never handle entry fees or prizes</div>' +
    '</div></div>';
}

const TPL_MAGIC = shell("Sign in to your club's admin tools", "Tap the button below to sign straight in to ClubMajors. For golf shop admins only — members never need an account.", "Sign in to ClubMajors", "{{ .ConfirmationURL }}");
const TPL_RECOVERY = shell("Reset your password", "Someone (hopefully you) asked to reset the password for this ClubMajors admin account. Tap below to choose a new one.", "Reset my password", "{{ .ConfirmationURL }}");
const TPL_CONFIRM = shell("Confirm your email", "You're nearly set up. Confirm this email address to activate your ClubMajors club admin account.", "Confirm my email", "{{ .ConfirmationURL }}");

async function mgmt(path, opts = {}) {
  opts.headers = Object.assign({ Authorization: "Bearer " + SUPA_TOKEN, "Content-Type": "application/json" }, opts.headers || {});
  const r = await fetch(API + path, opts);
  const text = await r.text();
  if (!r.ok) throw new Error((opts.method || "GET") + " " + path + " -> HTTP " + r.status + ": " + text.slice(0, 250));
  return text;
}

async function sql(query) {
  return mgmt("/database/query", { method: "POST", body: JSON.stringify({ query }) });
}

exports.handler = async (event) => {
  const respond = (code, body) => ({
    statusCode: code,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    body: JSON.stringify(body, null, 1),
  });
  const params = (event && event.queryStringParameters) || {};
  if (!GUARD || params.key !== GUARD) return respond(403, { error: "missing or wrong key" });
  if (!SUPA_TOKEN) return respond(500, { error: "SUPA_MGMT_TOKEN env var is not set" });

  const steps = [];
  const only = String(params.only || "").toLowerCase(); /* run a subset: ?only=<substring of step name> — keeps runs under the 10s function limit */
  const step = async (name, fn) => {
    if (only && name.toLowerCase().indexOf(only) === -1) { steps.push({ step: name, skipped: true }); return; }
    try { steps.push({ step: name, ok: true, result: await fn() }); }
    catch (e) { steps.push({ step: name, ok: false, error: String((e && e.message) || e).slice(0, 400) }); }
  };

  await step("verify token + project", async () => {
    await mgmt("/config/auth");
    return "token valid, project reachable";
  });

  await step("brand auth emails", async () => {
    await mgmt("/config/auth", {
      method: "PATCH",
      body: JSON.stringify({
        mailer_subjects_magic_link: "Your ClubMajors sign-in link",
        mailer_templates_magic_link_content: TPL_MAGIC,
        mailer_subjects_recovery: "Reset your ClubMajors password",
        mailer_templates_recovery_content: TPL_RECOVERY,
        mailer_subjects_confirmation: "Welcome to ClubMajors — confirm your email",
        mailer_templates_confirmation_content: TPL_CONFIRM,
      }),
    });
    return "magic link, recovery, and confirmation templates branded";
  });

  await step("point auth links at clubmajorsgolf.com (site URL + redirect allow-list)", async () => {
    const urls = [
      "https://clubmajorsgolf.com", "https://clubmajorsgolf.com/*",
      "https://www.clubmajorsgolf.com", "https://www.clubmajorsgolf.com/*",
      "https://clubmajors-live.netlify.app", "https://clubmajors-live.netlify.app/*",
    ];
    await mgmt("/config/auth", { method: "PATCH", body: JSON.stringify({
      site_url: "https://clubmajorsgolf.com",
      uri_allow_list: urls.join(","),
    }) });
    return "site_url = clubmajorsgolf.com; " + urls.length + " redirect URLs allowed (netlify.app kept as fallback)";
  });

  await step("add pools.tiebreaker_on column", async () => {
    await sql("ALTER TABLE public.pools ADD COLUMN IF NOT EXISTS tiebreaker_on boolean DEFAULT true;");
    return "column present";
  });

  /* REMOVED Jul 2026: a one-time "set Open pool deadline to 1:35 AM ET Thu"
     step lived here. Its ILIKE '%open%' match also hit later events ("3M
     Open"…) and silently reset their deadlines to July 16 on every rerun. */

  await step("pools policies: club admins can create, see, and publish their club's pools", async () => {
    /* the app inserts a draft on first publish, reloads it (unpublished), and
       flips published=true at checkout; the original hand-made policies
       (predating this file) provably missed at least part of that path */
    await sql(`
      DROP POLICY IF EXISTS pools_admin_insert ON public.pools;
      CREATE POLICY pools_admin_insert ON public.pools FOR INSERT
        WITH CHECK (EXISTS (
          SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid()
            AND (pr.role = 'owner' OR (pr.role = 'pro' AND pr.club_id = pools.club_id))
        ));
      DROP POLICY IF EXISTS pools_admin_select ON public.pools;
      CREATE POLICY pools_admin_select ON public.pools FOR SELECT
        USING (published = true OR EXISTS (
          SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid()
            AND (pr.role = 'owner' OR (pr.role = 'pro' AND pr.club_id = pools.club_id))
        ));
      DROP POLICY IF EXISTS pools_admin_update ON public.pools;
      CREATE POLICY pools_admin_update ON public.pools FOR UPDATE
        USING (EXISTS (
          SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid()
            AND (pr.role = 'owner' OR (pr.role = 'pro' AND pr.club_id = pools.club_id))
        ))
        WITH CHECK (EXISTS (
          SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid()
            AND (pr.role = 'owner' OR (pr.role = 'pro' AND pr.club_id = pools.club_id))
        ));
    `);
    return "pools admin insert/select/update policies in place";
  });

  await step("pool format columns: scoring/cut/tiers/entries persist per pool", async () => {
    /* the app scored best-4 and showed default copy for EVERY pool because the
       chosen format only lived in the pro's browser session — never in the DB */
    await sql(`
      ALTER TABLE public.pools ADD COLUMN IF NOT EXISTS scoring text;
      ALTER TABLE public.pools ADD COLUMN IF NOT EXISTS cut_rule text;
      ALTER TABLE public.pools ADD COLUMN IF NOT EXISTS tier_method text;
      ALTER TABLE public.pools ADD COLUMN IF NOT EXISTS max_entries text;
    `);
    return "pools.scoring / cut_rule / tier_method / max_entries columns ready";
  });

  await step("pools diagnostic: latest rows (read-only)", async () => {
    const r = await sql("SELECT id, club_id, event_name, published, paid, plan, created_at FROM public.pools ORDER BY created_at DESC LIMIT 10;");
    return JSON.parse(r);
  });

  await step("create payments table + owner read policy", async () => {
    await sql(`
      CREATE TABLE IF NOT EXISTS public.payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz DEFAULT now(),
        club_id uuid,
        plan text,
        amount_cents integer,
        currency text,
        promo_code text,
        customer_email text,
        stripe_customer text,
        stripe_session_id text UNIQUE
      );
      ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS payments_owner_read ON public.payments;
      CREATE POLICY payments_owner_read ON public.payments FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'owner'));
      ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS plan text;
      ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS paid_until timestamptz;
      ALTER TABLE public.pools ADD COLUMN IF NOT EXISTS paid boolean;
    `);
    return "payments table, owner-read policy, and club/pool columns ready";
  });

  await step("selfserve signup: auto club + pro role RPC", async () => {
    await sql(`
      CREATE OR REPLACE FUNCTION public.self_serve_signup(p_club_name text DEFAULT NULL, p_referred_by text DEFAULT NULL)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
      DECLARE uid uuid := auth.uid(); prof record; new_club_id uuid; base_slug text; final_slug text; nm text;
      BEGIN
        IF uid IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
        /* the platform owner account never self-serves a club */
        IF (SELECT email FROM auth.users WHERE id = uid) = 'support@clubmajorsgolf.com' THEN
          INSERT INTO profiles (id, role, club_id) VALUES (uid, 'owner', NULL)
            ON CONFLICT (id) DO UPDATE SET role = 'owner';
          RETURN jsonb_build_object('ok', true, 'owner', true);
        END IF;
        SELECT * INTO prof FROM profiles WHERE id = uid;
        IF prof.id IS NOT NULL AND (prof.club_id IS NOT NULL OR prof.role IN ('pro','owner','member')) THEN
          RETURN jsonb_build_object('ok', true, 'existing', true);
        END IF;
        nm := COALESCE(NULLIF(trim(p_club_name), ''), 'Your Golf Club');
        base_slug := trim(both '-' from regexp_replace(lower(nm), '[^a-z0-9]+', '-', 'g'));
        IF base_slug = '' THEN base_slug := 'club'; END IF;
        final_slug := base_slug;
        IF EXISTS (SELECT 1 FROM clubs WHERE slug = final_slug) THEN
          final_slug := base_slug || '-' || substr(md5(uid::text || clock_timestamp()::text), 1, 4);
        END IF;
        INSERT INTO clubs (name, slug, theme) VALUES (nm, final_slug, '{}'::jsonb) RETURNING id INTO new_club_id;
        INSERT INTO profiles (id, role, club_id) VALUES (uid, 'pro', new_club_id)
          ON CONFLICT (id) DO UPDATE SET role = 'pro', club_id = EXCLUDED.club_id;
        RETURN jsonb_build_object('ok', true, 'club_id', new_club_id, 'slug', final_slug, 'name', nm);
      END $fn$;
      REVOKE ALL ON FUNCTION public.self_serve_signup(text, text) FROM public, anon;
      GRANT EXECUTE ON FUNCTION public.self_serve_signup(text, text) TO authenticated;
    `);
    return "self_serve_signup RPC ready — fresh signups get a club + pro role instantly";
  });

  await step("backup snapshots: bucket + 2-minute pg_cron schedule", async () => {
    await sql("CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pg_net;");
    await sql("INSERT INTO storage.buckets (id, name, public) VALUES ('db-backups','db-backups', false) ON CONFLICT (id) DO NOTHING;");
    await sql("DO $do$ BEGIN PERFORM cron.unschedule('clubmajors-backup'); EXCEPTION WHEN OTHERS THEN NULL; END $do$;");
    await sql("SELECT cron.schedule('clubmajors-backup', '*/2 * * * *', $cm$ SELECT net.http_get('https://clubmajorsgolf.com/.netlify/functions/backup-cron?key=cm-backup-77133') $cm$);");
    return "db-backups bucket ready; pg_cron job clubmajors-backup runs every 2 minutes";
  });

  await step("schedule automated score validation (every 2 hours)", async () => {
    await sql("CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pg_net;");
    await sql("DO $do$ BEGIN PERFORM cron.unschedule('clubmajors-validate'); EXCEPTION WHEN OTHERS THEN NULL; END $do$;");
    await sql("SELECT cron.schedule('clubmajors-validate', '0 */2 * * *', $cm$ SELECT net.http_get('https://clubmajors-live.netlify.app/.netlify/functions/validate-cron?key=cm-validate-88412') $cm$);");
    return "pg_cron job clubmajors-validate scheduled every 2 hours";
  });

  await step("allow optional tiebreaker as 7th picks element in entry RPCs", async () => {
    await sql(`
      CREATE OR REPLACE FUNCTION public.submit_entry(p_pool_id uuid, p_entry_name text, p_member_name text, p_picks jsonb)
       RETURNS TABLE(entry_id uuid, edit_token text) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
      AS $function$
      declare v_token text; v_id uuid; v_deadline timestamptz; v_published boolean; v_max text; v_count int;
      begin
        select deadline, published, max_entries into v_deadline, v_published, v_max from pools where id = p_pool_id;
        if v_deadline is null then raise exception 'pool not found'; end if;
        if not v_published then raise exception 'pool not open'; end if;
        if now() >= v_deadline then raise exception 'picks are locked'; end if;
        if jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) < 6 or jsonb_array_length(p_picks) > 8 then
          raise exception 'need 6 picks (plus optional tiebreaker and team pick)'; end if;
        /* per-member entry limit, matched on normalized member name */
        if v_max is not null and v_max <> 'unlimited' and v_max ~ '^[0-9]+$' then
          select count(*) into v_count from entries
            where pool_id = p_pool_id
              and lower(btrim(member_name)) = lower(btrim(coalesce(nullif(btrim(p_member_name),''),'Member')));
          if v_count >= v_max::int then
            raise exception 'Entry limit reached — this pool allows % entr% per member.', v_max::int, case when v_max::int = 1 then 'y' else 'ies' end;
          end if;
        end if;
        v_token := replace(gen_random_uuid()::text, '-', '');
        insert into entries (pool_id, entry_name, member_name, picks, edit_token)
        values (p_pool_id, coalesce(nullif(btrim(p_entry_name),''),'My Entry'),
                coalesce(nullif(btrim(p_member_name),''),'Member'), p_picks, v_token)
        returning id into v_id;
        return query select v_id, v_token;
      end $function$;
    `);
    await sql(`
      CREATE OR REPLACE FUNCTION public.update_entry(p_edit_token text, p_entry_name text, p_member_name text, p_picks jsonb)
       RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
      AS $function$
      declare v_deadline timestamptz; v_id uuid; v_pool uuid; v_max text; v_count int; v_newname text;
      begin
        select e.id, e.pool_id, p.deadline, p.max_entries into v_id, v_pool, v_deadline, v_max
        from entries e join pools p on p.id = e.pool_id where e.edit_token = p_edit_token;
        if v_id is null then raise exception 'entry not found or bad code'; end if;
        if now() >= v_deadline then raise exception 'picks are locked'; end if;
        if jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) < 6 or jsonb_array_length(p_picks) > 8 then
          raise exception 'need 6 picks (plus optional tiebreaker and team pick)'; end if;
        /* renaming an entry must not dodge the per-member limit */
        v_newname := nullif(btrim(p_member_name), '');
        if v_newname is not null and v_max is not null and v_max <> 'unlimited' and v_max ~ '^[0-9]+$' then
          select count(*) into v_count from entries
            where pool_id = v_pool and id <> v_id and lower(btrim(member_name)) = lower(v_newname);
          if v_count >= v_max::int then
            raise exception 'Entry limit reached — this pool allows % entr% per member.', v_max::int, case when v_max::int = 1 then 'y' else 'ies' end;
          end if;
        end if;
        update entries set
          entry_name = coalesce(nullif(btrim(p_entry_name),''), entry_name),
          member_name = coalesce(nullif(btrim(p_member_name),''), member_name),
          picks = p_picks
        where id = v_id;
        return true;
      end $function$;
    `);
    await sql(`
      CREATE OR REPLACE FUNCTION public.delete_entry(p_edit_token text)
       RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
      AS $function$
      declare v_id uuid; v_deadline timestamptz;
      begin
        select e.id, p.deadline into v_id, v_deadline
        from entries e join pools p on p.id = e.pool_id where e.edit_token = p_edit_token;
        if v_id is null then raise exception 'entry not found or bad code'; end if;
        if now() >= v_deadline then raise exception 'picks are locked — see the pro shop to remove an entry'; end if;
        delete from entries where id = v_id;
        return true;
      end $function$;
    `);
    return "submit_entry/update_entry: 6-8 pick elements + per-member limit from pools.max_entries; delete_entry (token-gated, pre-deadline) ready";
  });

  await step("referral tracking columns + owner visibility on signups", async () => {
    await sql(`
      ALTER TABLE public.signup_requests ADD COLUMN IF NOT EXISTS referred_by text;
      ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS referred_by text;
      ALTER TABLE public.signup_requests ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS signup_requests_owner_read ON public.signup_requests;
      CREATE POLICY signup_requests_owner_read ON public.signup_requests FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'owner'));
      DROP POLICY IF EXISTS signup_requests_public_insert ON public.signup_requests;
      CREATE POLICY signup_requests_public_insert ON public.signup_requests FOR INSERT WITH CHECK (true);
    `);
    return "referred_by columns added; owner can read signups; public can still insert";
  });

  await step("score cache table (serve-stale during feed outages)", async () => {
    await sql("CREATE TABLE IF NOT EXISTS public.score_cache (cache_key text PRIMARY KEY, payload jsonb, fetched_at timestamptz DEFAULT now());");
    return "score_cache ready";
  });

  await step("pool results archive (past leaderboards for club admins)", async () => {
    await sql(`
      CREATE TABLE IF NOT EXISTS public.pool_results (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pool_id uuid,
        club_id uuid,
        event_name text,
        finalized_at timestamptz DEFAULT now(),
        standings jsonb
      );
      ALTER TABLE public.pool_results ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS pool_results_club_read ON public.pool_results;
      CREATE POLICY pool_results_club_read ON public.pool_results FOR SELECT
        USING (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid()
                       AND (pr.role = 'owner' OR (pr.role = 'pro' AND pr.club_id = pool_results.club_id))));
      DROP POLICY IF EXISTS pool_results_club_insert ON public.pool_results;
      CREATE POLICY pool_results_club_insert ON public.pool_results FOR INSERT
        WITH CHECK (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid()
                       AND (pr.role = 'owner' OR (pr.role = 'pro' AND pr.club_id = pool_results.club_id))));
    `);
    return "pool_results table + club-scoped read/insert policies ready";
  });

  await step("platform config table (score-source switch)", async () => {
    await sql(`
      CREATE TABLE IF NOT EXISTS public.platform_config (
        key text PRIMARY KEY,
        value text,
        updated_at timestamptz DEFAULT now()
      );
      ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS platform_config_owner_all ON public.platform_config;
      CREATE POLICY platform_config_owner_all ON public.platform_config FOR ALL
        USING (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'owner'))
        WITH CHECK (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role = 'owner'));
      INSERT INTO public.platform_config (key, value) VALUES ('score_provider', 'slashgolf') ON CONFLICT (key) DO NOTHING;
      DROP POLICY IF EXISTS platform_config_public_promo ON public.platform_config;
      CREATE POLICY platform_config_public_promo ON public.platform_config FOR SELECT USING (key = 'referral_promo');
      INSERT INTO public.platform_config (key, value) VALUES ('referral_promo', '') ON CONFLICT (key) DO NOTHING;
    `);
    return "platform_config ready; score_provider defaults to slashgolf";
  });

  await step("sync club slugs to current club names (fixes stale members/referral links)", async () => {
    const res = await sql(`
      UPDATE public.clubs c
      SET slug = btrim(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), '-')
      WHERE btrim(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), '-') <> ''
        AND btrim(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), '-') <> c.slug
        AND NOT EXISTS (SELECT 1 FROM public.clubs c2 WHERE c2.id <> c.id
                        AND c2.slug = btrim(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), '-'))
      RETURNING c.name, c.slug;
    `);
    return "slugs resynced: " + JSON.stringify(res).slice(0, 200);
  });

  await step("co-admin invites (invite link, join RPC, admins list)", async () => {
    await sql(`
      CREATE TABLE IF NOT EXISTS public.club_invites (
        club_id uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
        token uuid NOT NULL DEFAULT gen_random_uuid(),
        created_at timestamptz DEFAULT now()
      );
      ALTER TABLE public.club_invites ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS club_invites_admin_read ON public.club_invites;
      CREATE POLICY club_invites_admin_read ON public.club_invites FOR SELECT
        USING (club_id = (SELECT club_id FROM public.profiles WHERE id = auth.uid())
               AND (SELECT role FROM public.profiles WHERE id = auth.uid()) IN ('pro','owner'));
      INSERT INTO public.club_invites (club_id) SELECT id FROM public.clubs ON CONFLICT (club_id) DO NOTHING;
      ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email text;
      ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
      UPDATE public.profiles p SET email = u.email FROM auth.users u WHERE u.id = p.id AND p.email IS NULL;
    `);
    await sql(`
      CREATE OR REPLACE FUNCTION public.join_club_by_invite(p_token uuid)
      RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $inv$
      DECLARE v_club public.clubs%ROWTYPE;
      BEGIN
        IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first, then open the invite link again.'; END IF;
        SELECT c.* INTO v_club FROM public.clubs c JOIN public.club_invites i ON i.club_id = c.id
          WHERE i.token = p_token AND c.status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'This invite link is not valid. Ask the pro who sent it for a fresh one.'; END IF;
        INSERT INTO public.profiles (id, email, role, club_id)
          VALUES (auth.uid(), (SELECT email FROM auth.users WHERE id = auth.uid()), 'pro', v_club.id)
          ON CONFLICT (id) DO UPDATE
            SET role = CASE WHEN public.profiles.role = 'owner' THEN 'owner' ELSE 'pro' END,
                club_id = EXCLUDED.club_id,
                email = COALESCE(public.profiles.email, EXCLUDED.email);
        RETURN json_build_object('club', v_club.name);
      END $inv$;
      GRANT EXECUTE ON FUNCTION public.join_club_by_invite(uuid) TO authenticated;
    `);
    await sql(`
      CREATE OR REPLACE FUNCTION public.list_club_admins()
      RETURNS TABLE(email text, role text, joined timestamptz) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $adm$
        SELECT p.email, p.role, p.created_at FROM public.profiles p
        WHERE p.club_id = (SELECT club_id FROM public.profiles WHERE id = auth.uid())
          AND p.role IN ('pro','owner')
          AND (SELECT role FROM public.profiles WHERE id = auth.uid()) IN ('pro','owner')
        ORDER BY p.created_at;
      $adm$;
      GRANT EXECUTE ON FUNCTION public.list_club_admins() TO authenticated;
    `);
    return "club_invites table + join_club_by_invite + list_club_admins ready";
  });

  await step("owner dashboard backend (owner gate, aggregate RPC, gift-card log)", async () => {
    await sql(`
      CREATE OR REPLACE FUNCTION public.owner_gate() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $og$
      BEGIN
        IF NOT (
          COALESCE(auth.jwt() ->> 'email', '') = 'support@clubmajorsgolf.com'
          OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'owner')
        ) THEN RAISE EXCEPTION 'Owners only.'; END IF;
      END $og$;
      INSERT INTO public.profiles (id, email, role)
        SELECT u.id, u.email, 'owner' FROM auth.users u WHERE u.email = 'support@clubmajorsgolf.com'
        ON CONFLICT (id) DO UPDATE SET role = 'owner';
      /* Jul 2026 ownership transfer: the founding gmail accounts become plain
         test accounts — pro if they own a club, pending (fresh-signup) if not */
      UPDATE public.profiles SET role = CASE WHEN club_id IS NULL THEN 'pending' ELSE 'pro' END
        WHERE role = 'owner'
        AND id IN (SELECT id FROM auth.users WHERE email IN ('jerryw20180314@gmail.com', '0wangxinquan0@gmail.com'));
      CREATE TABLE IF NOT EXISTS public.giftcard_log (
        id bigserial PRIMARY KEY,
        club_id uuid,
        kind text,
        recipient text,
        status text DEFAULT 'sent',
        sent_at timestamptz DEFAULT now(),
        note text,
        created_at timestamptz DEFAULT now()
      );
      ALTER TABLE public.giftcard_log ENABLE ROW LEVEL SECURITY;
      CREATE TABLE IF NOT EXISTS public.validation_alerts (id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), fingerprint text, mismatch_count int, detail text, emailed boolean);
      ALTER TABLE public.validation_alerts ENABLE ROW LEVEL SECURITY;
    `);
    await sql(`
      CREATE OR REPLACE FUNCTION public.owner_dashboard() RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $od$
      BEGIN
        PERFORM public.owner_gate();
        RETURN json_build_object(
          'clubs', COALESCE((SELECT json_agg(row_to_json(cc)) FROM (
            SELECT c.id, c.name, c.slug, c.status, c.created_at, c.plan, c.paid_until,
                   c.theme -> 'pros' AS named_pros,
                   COALESCE((SELECT json_agg(json_build_object('email', p.email, 'role', p.role, 'joined', p.created_at)) FROM public.profiles p WHERE p.club_id = c.id AND p.role IN ('pro','owner')), '[]'::json) AS admins,
                   COALESCE((SELECT SUM(pm.amount_cents) FROM public.payments pm WHERE pm.club_id = c.id), 0) AS revenue_cents,
                   (SELECT row_to_json(x) FROM (SELECT pm2.plan, pm2.created_at, pm2.amount_cents FROM public.payments pm2 WHERE pm2.club_id = c.id ORDER BY pm2.created_at DESC LIMIT 1) x) AS latest_payment
            FROM public.clubs c ORDER BY c.created_at) cc), '[]'::json),
          'pools', COALESCE((SELECT json_agg(row_to_json(pp)) FROM (
            SELECT po.id, po.club_id, po.event_name, po.published, po.created_at, po.deadline, po.entry_fee,
                   (SELECT count(*) FROM public.entries e WHERE e.pool_id = po.id) AS entry_count
            FROM public.pools po ORDER BY po.created_at) pp), '[]'::json),
          'archives', COALESCE((SELECT json_agg(json_build_object('club_id', r.club_id, 'event_name', r.event_name, 'finalized_at', r.finalized_at,
                   'entry_count', CASE WHEN jsonb_typeof(r.standings) = 'array' THEN jsonb_array_length(r.standings) ELSE 0 END)) FROM public.pool_results r), '[]'::json),
          'payments', COALESCE((SELECT json_agg(row_to_json(qq)) FROM (
            SELECT pm.id, pm.created_at, pm.club_id, (SELECT name FROM public.clubs c2 WHERE c2.id = pm.club_id) AS club_name,
                   pm.plan, pm.amount_cents, pm.currency, pm.promo_code, pm.customer_email
            FROM public.payments pm ORDER BY pm.created_at DESC) qq), '[]'::json),
          'giftcards', COALESCE((SELECT json_agg(row_to_json(gg)) FROM (SELECT g.* FROM public.giftcard_log g ORDER BY g.id DESC) gg), '[]'::json),
          'signups', COALESCE((SELECT json_agg(row_to_json(ss)) FROM (SELECT s.* FROM public.signup_requests s) ss), '[]'::json),
          'alerts', COALESCE((SELECT json_agg(row_to_json(aa)) FROM (SELECT a.id, a.created_at, a.mismatch_count, a.detail, a.emailed FROM public.validation_alerts a ORDER BY a.id DESC LIMIT 50) aa), '[]'::json),
          'profiles_total', (SELECT count(*) FROM public.profiles)
        );
      END $od$;
      GRANT EXECUTE ON FUNCTION public.owner_dashboard() TO authenticated;
    `);
    await sql(`
      CREATE OR REPLACE FUNCTION public.owner_mark_giftcard(p_club_id uuid, p_kind text, p_recipient text, p_note text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $mg$
      DECLARE v_id bigint;
      BEGIN
        PERFORM public.owner_gate();
        INSERT INTO public.giftcard_log (club_id, kind, recipient, note) VALUES (p_club_id, p_kind, p_recipient, p_note) RETURNING id INTO v_id;
        RETURN v_id;
      END $mg$;
      GRANT EXECUTE ON FUNCTION public.owner_mark_giftcard(uuid, text, text, text) TO authenticated;
      CREATE OR REPLACE FUNCTION public.owner_unmark_giftcard(p_id bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $ug$
      BEGIN
        PERFORM public.owner_gate();
        DELETE FROM public.giftcard_log WHERE id = p_id;
      END $ug$;
      GRANT EXECUTE ON FUNCTION public.owner_unmark_giftcard(bigint) TO authenticated;
    `);
    return "owner_gate + owner_dashboard + gift-card log ready (access: support@clubmajorsgolf.com or owner role; founding gmails demoted to test accounts)";
  });

  await step("branded sender: auth emails from noreply@clubmajorsgolf.com (SMTP via Resend)", async () => {
    const rk = process.env.RESEND_KEY || "";
    if (!rk) return "skipped — RESEND_KEY env var not set yet";
    await mgmt("/config/auth", { method: "PATCH", body: JSON.stringify({
      external_email_enabled: true,
      smtp_admin_email: "noreply@clubmajorsgolf.com",
      smtp_host: "smtp.resend.com",
      smtp_port: "465",
      smtp_user: "resend",
      smtp_pass: rk,
      smtp_sender_name: "ClubMajors",
      smtp_max_frequency: 1,
    }) });
    return "auth emails now send from ClubMajors <noreply@clubmajorsgolf.com> via Resend";
  });

  await step("read entry RPC definitions", async () => {
    const r = await sql("SELECT proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND proname IN ('submit_entry','update_entry','get_entry_by_code');");
    const rows = JSON.parse(r);
    return rows.map((x) => ({ fn: x.proname, def: String(x.def).slice(0, 3500) }));
  });

  return respond(200, { done: true, reminder: "Remove this function in the next deploy and revoke the Supabase token.", steps });
};
