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
  SUPABASE_URL: 'https://mmwymuxutgmwfmvkvxzw.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_tSgaTLZRuwluENMxA2Nlgw_XVwFFrWy',

  /* Free key for USDA FoodData Central, used to search foods by name.
     Optional: barcode scanning uses Open Food Facts and needs no key at
     all. Sign up at fdc.nal.usda.gov/api-key-signup.html — instant, no
     card. It is a rate-limit identifier, not a credential, but it is
     yours: a key in a public repo is a key strangers can spend, so
     leaving this blank and entering it under Setup → Food lookup is the
     safer choice unless the repo is private. */
  USDA_API_KEY: ''
};
