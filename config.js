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
     Barcode scanning uses Open Food Facts and needs no key at all, so
     this only affects the search box.

     Committed on purpose so every device picks it up with nothing to
     type. Know what that means: this repo is public, so the key is
     public. It is a rate-limit identifier rather than a credential —
     it grants nothing but queries against a public database, and the
     allowance is 3,600 an hour against a personal use of maybe thirty
     a day. Worst case someone burns the hour's quota and search is
     briefly unavailable; nothing is exposed and nothing is billed.

     If that ever happens, issue a new one at
     fdc.nal.usda.gov/api-key-signup.html and replace this line. */
  USDA_API_KEY: 'BEfjhfNMgNnVIJdsfTsYGxYIxJqYvgI7SgzrQ5jv'
};
