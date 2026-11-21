MAA WELFARE ORGANIZATION - website and submissions server

FILES
  index.html     the website (public pages and the team area)
  worker.js      the small server that receives what donors and help seekers submit
  wrangler.jsonc Cloudflare settings
  .assetsignore  keeps the server files out of the public website

SET UP (once)
1. Upload all four files to your GitHub repository, replacing the old ones.
   Cloudflare builds and publishes the new version by itself.
2. In Cloudflare open: Workers & Pages > maa-welfare > Settings > Variables and Secrets.
   Add a SECRET named ADMIN_KEY. Choose a long key that only the administrators know.
   Save and deploy. This is the key the admin types to unlock the Inbox.
3. If the build says the KV namespace is missing:
   Storage & Databases > KV > Create a namespace (name: maa-welfare-subs).
   Copy its ID and put it in wrangler.jsonc like this:
     "kv_namespaces": [ { "binding": "SUBS", "id": "PASTE-THE-ID-HERE" } ]
   Upload wrangler.jsonc again.
4. Open your website address ending in .workers.dev. On Get help and Give the button now says
   "Submit". Send a test form.
5. Team > Inbox > type the ADMIN_KEY. The test appears with its attachments.

IF THE WEBSITE STAYS ON GITHUB PAGES
  Open index.html in a text editor, find the line   const MW_API_BASE = "";
  and put the .workers.dev address between the quotes, for example
  const MW_API_BASE = "https://maa-welfare.info-maawelfare.workers.dev";

HOW IT WORKS
  Public: fills the form, attaches documents or the payment screenshot, presses Submit.
  Server: stores the details and files privately. Nobody can read them without the ADMIN_KEY.
  Admin: Team > Inbox. Open the attachments, then
     Donation: Confirm donation received  -> it is added to Donations as Accepted and the reports update.
     Help request: Add to Requests        -> it appears in Requests, ready to review and approve.
  Creating team logins needs the account key. That key is separate from the ADMIN_KEY.
