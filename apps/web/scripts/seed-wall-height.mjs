/**
 * One-off: fix invalid wallHeight so roof tests are not blocked by OPENING_HEIGHT.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env.local");
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

async function main() {
  const admin = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  if (linkErr) throw linkErr;
  const anon = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: verified, error: verifyErr } = await anon.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (verifyErr) throw verifyErr;

  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const payload = {
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: "bearer",
  };
  const b64 = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const cookie = `sb-${ref}-auth-token=base64-${b64}`;

  const { data: before } = await admin
    .from("building_revisions")
    .select("revision,model")
    .eq("project_id", PROJECT_ID)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(
    "before",
    before.revision,
    before.model.shell?.wallHeight,
    before.model.shell?.roof,
  );

  const res = await fetch("http://localhost:3000/api/design-agent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      message:
        "Set the exterior wall height to 9 feet only. Do not change width, depth, roof type, pitch, overhang, ridge direction, openings, spaces, or walls.",
    }),
  });
  const text = await res.text();
  const { data: after } = await admin
    .from("building_revisions")
    .select("revision,model")
    .eq("project_id", PROJECT_ID)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(
    "after",
    after.revision,
    after.model.shell?.wallHeight,
    after.model.shell?.roof,
  );
  console.log("status", res.status, "bytes", text.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
