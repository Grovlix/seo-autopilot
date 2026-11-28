// Origin header on EmDash requests with a body. Astro's security.checkOrigin refuses a form-content-type POST/PUT/PATCH/
// DELETE whose Origin is missing or foreign (403 "Cross-site POST form submissions are forbidden"); the multipart media
// upload is one, and Node's fetch sends no Origin. The in-memory stand-in refuses exactly like Astro, so the offline
// proof catches a client that forgets the header. Synthetic content only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeEmDash } from "./fixtures/fake-emdash.mjs";
import { createClient } from "../src/cms/emdash.mjs";

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const upload = (c) => c.uploadMedia({ filename: "a.jpg", type: "image/jpeg", bytes: jpeg });
/** Wraps the stand-in's fetch and records the headers of every request. */
const spy = (fake) => { const seen = []; return { seen, fetch: (url, init) => { seen.push({ method: init?.method || "GET", headers: { ...(init?.headers || {}) } }); return fake.fetch(url, init); } }; };

test("the multipart upload carries Origin and passes the stand-in's origin check", async () => {
  const fake = fakeEmDash(); const s = spy(fake);
  const c = createClient({ url: "https://cms.example.test", token: "t", fetch: s.fetch });
  const r = await upload(c);
  assert.equal(r.item.mimeType, "image/jpeg");
  assert.equal(s.seen.at(-1).method, "POST");
  assert.equal(s.seen.at(-1).headers.origin, "https://cms.example.test");
});

test("the stand-in refuses a form POST without a matching Origin, like Astro (text/plain 403)", async () => {
  const fake = fakeEmDash();
  const form = () => { const f = new FormData(); f.set("file", new Blob([jpeg], { type: "image/jpeg" }), "a.jpg"); return f; };
  const post = (headers) => fake.fetch("https://cms.example.test/_emdash/api/media", { method: "POST", headers: { authorization: "Bearer t", ...headers }, body: form() });
  for (const headers of [{}, { origin: "https://evil.example.test" }, { origin: "https://cms.example.test:8443" }, { origin: "null" }]) {
    const res = await post(headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(await res.text(), "Cross-site POST form submissions are forbidden");
  }
  assert.equal((await post({ origin: "https://cms.example.test" })).status, 201);
  // url-encoded and text/plain bodies are form content types too; JSON is not checked
  const enc = (ct, origin) => fake.fetch("https://cms.example.test/_emdash/api/content/posts", { method: "POST", headers: { authorization: "Bearer t", "content-type": ct, ...(origin ? { origin } : {}) }, body: "{}" });
  assert.equal((await enc("application/x-www-form-urlencoded")).status, 403);
  assert.equal((await enc("text/plain;charset=UTF-8")).status, 403);
  assert.notEqual((await enc("application/x-www-form-urlencoded", "https://cms.example.test")).status, 403);
  const json = await fake.fetch("https://cms.example.test/_emdash/api/content/posts", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ slug: "x", data: {} }) });
  assert.equal(json.status, 201);
});

test("a client that sends no Origin fails the upload with the CSRF text (the R19 failure, reproduced offline)", async () => {
  const fake = fakeEmDash();
  const noOrigin = (url, init) => { const { origin, ...headers } = init.headers || {}; return fake.fetch(url, { ...init, headers }); };
  const c = createClient({ url: "https://cms.example.test", token: "t", fetch: noOrigin });
  await assert.rejects(() => upload(c), (e) => e.status === 403 && /Cross-site POST form submissions are forbidden/.test(e.message));
});

test("the origin comes from the base URL: path, trailing slash, query and default port are ignored", async () => {
  for (const [url, origin] of [
    ["https://cms.example.test", "https://cms.example.test"],
    ["https://cms.example.test/", "https://cms.example.test"],
    ["https://cms.example.test/sub/path///", "https://cms.example.test"],
    ["https://cms.example.test:443/x/", "https://cms.example.test"],
    ["http://localhost:4321/admin/", "http://localhost:4321"],
  ]) {
    const seen = [];
    const c = createClient({ url, token: "t", fetch: async (u, init) => { seen.push(init.headers.origin); return new Response(JSON.stringify({ data: { item: {} } }), { status: 200, headers: { "content-type": "application/json" } }); } });
    await upload(c);
    assert.deepEqual(seen, [origin], url);
  }
});

test("JSON writes carry Origin too; reads (no body) and the media file read-back do not need it", async () => {
  const fake = fakeEmDash({ posts: [{ slug: "p", data: { title: "P" } }] }); const s = spy(fake);
  const c = createClient({ url: "https://cms.example.test/", token: "t", fetch: s.fetch });
  await c.createDraft("posts", { slug: "new-one", data: { title: "N" } });
  await c.get("posts", "p");
  const post = s.seen.find((x) => x.method === "POST"), get = s.seen.find((x) => x.method === "GET");
  assert.equal(post.headers.origin, "https://cms.example.test");
  assert.equal(get.headers.origin, undefined);
});
