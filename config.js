'use strict';

/* =============================================================
   TRENDLINE — CONFIG

   Cloud sync is OFF until these two values are filled in. The app is
   fully functional without them: everything works locally, forever,
   with no account. Sync is an addition, not a dependency.

   Both values are safe to commit. The anon key is a public,
   publishable key — it identifies the project, it does not grant
   access. Row Level Security in supabase/schema.sql is what actually
   protects the data, and it restricts every row to the user who
   created it. Never put the SERVICE ROLE key here; that one does
   bypass RLS.

   Setup is in the README — about five minutes, no credit card.
   ============================================================= */

var CONFIG = {
  SUPABASE_URL: '',       // https://xxxxxxxxxxxx.supabase.co
  SUPABASE_ANON_KEY: ''   // the "anon / public" key, not the service role key
};
