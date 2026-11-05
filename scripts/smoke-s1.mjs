#!/usr/bin/env node
/**
 * S1 + S2 smoke test. Requires `npx wrangler dev --port 8787` running locally.
 * Usage: node scripts/smoke-s1.mjs
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const canonicalize = require("canonicalize");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const EMAIL = process.env.DEV_EMAIL ?? "admin@example.com";

let failures = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`, extra ?? "");
  }
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("X-Dev-Email", EMAIL);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function rawRequest(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function termsHash(terms) {
  const canonical = canonicalize(terms);
  if (canonical === undefined) throw new Error("terms must be serializable");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function acceptanceProof(agentToken, termsHashValue) {
  const secret = agentToken.slice(agentToken.lastIndexOf(".") + 1);
  return createHmac("sha256", secret).update(termsHashValue, "utf8").digest("base64url");
}

async function expectOk(name, path, init) {
  const { response, body } = await request(path, init);
  check(`${name} (${response.status})`, response.ok, body);
  if (!response.ok) throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  return body;
}

const suffix = Date.now().toString(36);

try {
  console.log(`smoke: ${BASE}`);
  const health = await expectOk("health", "/api/v1/health");
  check("d1 ok", health.d1 === "ok", health);

  const initialSetup = await rawRequest("/api/v1/setup/status");
  check("initial setup status", initialSetup.response.status === 200, initialSetup.body);

  if (initialSetup.body?.needs_setup) {
    const rootBeforeSetup = await rawRequest("/", { redirect: "manual" });
    check(
      "empty instance redirects root to /setup",
      rootBeforeSetup.response.status === 302 &&
        (rootBeforeSetup.response.headers.get("location") ?? "").endsWith("/setup"),
      {
        status: rootBeforeSetup.response.status,
        location: rootBeforeSetup.response.headers.get("location"),
      },
    );
  } else {
    console.log("  skip empty-root redirect (database already initialized)");
  }

  if (initialSetup.body?.needs_setup) {
    const setup = await rawRequest("/api/v1/setup", {
      method: "POST",
      body: JSON.stringify({
        instance_name: "Smoke Instance",
        admin: {
          email: `bootstrap-${suffix}@example.com`,
          password: "bootstrap-password-123",
          display_name: "Bootstrap Admin",
        },
        project: {
          slug: `setup-${suffix}`,
          name: "Setup Project",
          verification_mode: "human",
        },
      }),
    });
    check("setup succeeds on empty database", setup.response.status === 201, setup.body);
    check("setup creates first project", Boolean(setup.body?.project?.id), setup.body);
    check(
      "setup returns enrollment token",
      typeof setup.body?.enrollment_token === "string" &&
        setup.body.enrollment_token.startsWith("kbe1."),
      setup.body,
    );
    const setupCookie = (setup.response.headers.get("set-cookie") ?? "").split(";")[0];
    check("setup sets session cookie", setupCookie.includes("boardroom_session="), setupCookie);
    const setupMe = await rawRequest("/api/v1/auth/me", {
      headers: { Cookie: setupCookie },
    });
    check(
      "setup session authenticates",
      setupMe.response.status === 200 && setupMe.body?.user?.role === "admin",
      setupMe.body,
    );
    const instance = await rawRequest("/api/v1/instance");
    check("instance name saved", instance.body?.instance_name === "Smoke Instance", instance.body);
    await rawRequest("/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: setupCookie },
    });
  } else {
    console.log("  skip setup (database already initialized)");
  }

  const rootAfterSetup = await rawRequest("/", { redirect: "manual" });
  check(
    "configured instance serves root",
    rootAfterSetup.response.status === 200,
    { status: rootAfterSetup.response.status },
  );
  const setupAfterSetup = await rawRequest("/setup", { redirect: "manual" });
  check(
    "configured instance redirects /setup to /",
    setupAfterSetup.response.status === 302 &&
      (setupAfterSetup.response.headers.get("location") ?? "").endsWith("/"),
    {
      status: setupAfterSetup.response.status,
      location: setupAfterSetup.response.headers.get("location"),
    },
  );

  const locale = await expectOk("locale metadata", "/api/v1/locale", {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  check("locale resolves from Accept-Language", locale.locale === "en", locale);

  const zhError = await request("/api/v1/projects/does-not-exist", {
    headers: { "Accept-Language": "zh-CN" },
  });
  check(
    "error message localized (zh)",
    zhError.response.status === 404 && zhError.body?.error?.message === "资源不存在",
    zhError.body,
  );

  const enError = await request("/api/v1/projects/does-not-exist", {
    headers: { "Accept-Language": "en" },
  });
  check(
    "error message localized (en)",
    enError.response.status === 404 && enError.body?.error?.message === "Not found",
    enError.body,
  );

  const setLocale = await request("/api/v1/locale", {
    method: "POST",
    body: JSON.stringify({ locale: "en" }),
  });
  check("locale endpoint sets cookie", setLocale.response.status === 200, setLocale.body);
  check(
    "locale cookie present",
    (setLocale.response.headers.get("set-cookie") ?? "").includes("lang=en"),
    setLocale.response.headers.get("set-cookie"),
  );

  const me = await expectOk("me", "/api/v1/me");
  check("dev user is admin", me.user.role === "admin", me.user);

  const loginEmail = `login-${suffix}@example.com`;
  const initialPassword = "smoke-password-123";
  const nextPassword = "smoke-password-456";
  const createdUser = await expectOk("create user", "/api/v1/users", {
    method: "POST",
    body: JSON.stringify({ email: loginEmail, password: initialPassword, role: "member" }),
  });
  check("created user", createdUser.user.email === loginEmail, createdUser.user);

  const emailStatus = await expectOk("email status", "/api/v1/admin/email/status");
  const consoleEmail = emailStatus.provider === "console";
  check(
    "email status provider",
    ["console", "smtp", "disabled"].includes(emailStatus.provider),
    emailStatus,
  );

  if (consoleEmail) {
    const testEmail = await expectOk("email test", "/api/v1/admin/email/test", {
      method: "POST",
      body: JSON.stringify({ to: loginEmail }),
    });
    check(
      "email test succeeds",
      testEmail.ok === true && testEmail.provider === "console",
      testEmail,
    );
  } else {
    console.log(`  skip email send assertions (provider: ${emailStatus.provider})`);
  }

  const inviteEmail = `invite-${suffix}@example.com`;
  const invited = await expectOk("invite user", "/api/v1/users/invite", {
    method: "POST",
    body: JSON.stringify({ email: inviteEmail, send_email: consoleEmail }),
  });
  check("invite returns temporary password", typeof invited.temporary_password === "string", invited);
  if (consoleEmail) {
    check("invite sends email", invited.email?.provider === "console", invited.email);
  }
  check("invite requires password change", invited.user?.must_change_password === true, invited.user);

  const emailLog = await expectOk("email log", "/api/v1/admin/email/log");
  check(
    "email log responds",
    Array.isArray(emailLog.emails) && (!consoleEmail || emailLog.emails.length >= 2),
    emailLog.emails,
  );

  const filteredUsers = await expectOk(
    "filter users",
    `/api/v1/users?q=${encodeURIComponent("invite-")}`,
  );
  check(
    "user filter finds invited user",
    filteredUsers.users.some((user) => user.email === inviteEmail),
    filteredUsers.users,
  );

  const aliasUsers = await expectOk(
    "admin users alias",
    `/api/v1/admin/users?q=${encodeURIComponent("invite-")}`,
  );
  check(
    "admin users alias works",
    aliasUsers.users.some((user) => user.email === inviteEmail),
    aliasUsers.users,
  );

  const userDetail = await expectOk(
    "user detail",
    `/api/v1/users/${encodeURIComponent(invited.user.id)}`,
  );
  check("user detail returns sessions", Number.isInteger(userDetail.active_sessions), userDetail);

  const revoked = await expectOk(
    "revoke user sessions",
    `/api/v1/users/${encodeURIComponent(invited.user.id)}/revoke-sessions`,
    { method: "POST" },
  );
  check("revoke sessions succeeds", revoked.ok === true, revoked);

  const overview = await expectOk("admin overview", "/api/v1/admin/overview");
  check("admin overview counts users", overview.users >= 2, overview);

  const inviteLogin = await rawRequest("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: inviteEmail, password: invited.temporary_password }),
  });
  check("invited user can login", inviteLogin.response.status === 200, inviteLogin.body);
  check(
    "invited user must change password",
    inviteLogin.body?.must_change_password === true,
    inviteLogin.body,
  );

  const softDeleted = await expectOk(
    "soft delete user",
    `/api/v1/users/${encodeURIComponent(invited.user.id)}`,
    { method: "DELETE" },
  );
  check("soft delete succeeds", softDeleted.soft_deleted === true, softDeleted);
  const disabledLogin = await rawRequest("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: inviteEmail, password: invited.temporary_password }),
  });
  check("soft-deleted user cannot login", disabledLogin.response.status === 403, disabledLogin.body);

  const authStatus = await rawRequest("/api/v1/auth/status");
  check("auth status", authStatus.response.status === 200, authStatus.body);
  check("bootstrap no longer needed", authStatus.body?.needs_bootstrap === false, authStatus.body);

  const bootstrapAgain = await rawRequest("/api/v1/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      email: `bootstrap-${suffix}@example.com`,
      password: "bootstrap-password-123",
    }),
  });
  check("bootstrap rejected after first user", bootstrapAgain.response.status === 409, bootstrapAgain.body);

  const login = await rawRequest("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: loginEmail, password: initialPassword }),
  });
  check("login succeeds", login.response.status === 200, login.body);
  const loginCookie = (login.response.headers.get("set-cookie") ?? "").split(";")[0];
  check("session cookie set", loginCookie.includes("boardroom_session="), loginCookie);

  const sessionMe = await rawRequest("/api/v1/me", { headers: { Cookie: loginCookie } });
  check(
    "session authenticates /me",
    sessionMe.response.status === 200 && sessionMe.body?.user?.email === loginEmail,
    sessionMe.body,
  );

  const changed = await rawRequest("/api/v1/auth/password", {
    method: "POST",
    headers: { Cookie: loginCookie },
    body: JSON.stringify({ current_password: initialPassword, new_password: nextPassword }),
  });
  check("password change succeeds", changed.response.status === 200, changed.body);

  const oldLogin = await rawRequest("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: loginEmail, password: initialPassword }),
  });
  check("old password rejected", oldLogin.response.status === 401, oldLogin.body);

  const newLogin = await rawRequest("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: loginEmail, password: nextPassword }),
  });
  check("new password accepted", newLogin.response.status === 200, newLogin.body);
  const newCookie = (newLogin.response.headers.get("set-cookie") ?? "").split(";")[0];

  const logout = await rawRequest("/api/v1/auth/logout", {
    method: "POST",
    headers: { Cookie: newCookie },
  });
  check("logout succeeds", logout.response.status === 200, logout.body);

  const afterLogout = await rawRequest("/api/v1/me", { headers: { Cookie: newCookie } });
  check("revoked session rejected", afterLogout.response.status === 401, afterLogout.body);


  const createdProject = await expectOk("create project", "/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      slug: `smoke-${suffix}`,
      name: `Smoke ${suffix}`,
      verification_mode: "human",
    }),
  });
  const project = createdProject.project;
  const enrollmentToken = createdProject.enrollment_token;
  check("project id", project.id.startsWith("prj_"), project);
  check("enrollment token", enrollmentToken.startsWith("kbe1."), enrollmentToken);

  const addedMember = await expectOk(
    "add existing project member",
    `/api/v1/projects/${project.id}/members`,
    {
      method: "POST",
      body: JSON.stringify({ email: loginEmail, role: "member" }),
    },
  );
  check(
    "project member added",
    addedMember.member?.email === loginEmail && addedMember.member?.role === "member",
    addedMember.member,
  );

  const membersBefore = await expectOk(
    "list project members",
    `/api/v1/projects/${project.id}/members`,
  );
  check(
    "project member list includes added user",
    membersBefore.members.some((member) => member.email === loginEmail),
    membersBefore.members,
  );

  // ---------- Single project owner + ownership transfer (issue #14) ----------
  const promoteRefused = await request(
    `/api/v1/projects/${project.id}/members/${addedMember.member.id}`,
    { method: "PATCH", body: JSON.stringify({ role: "owner" }) },
  );
  check(
    "promoting a second owner is refused",
    promoteRefused.response.status === 409 && promoteRefused.body?.error?.code === "SINGLE_OWNER",
    promoteRefused.body,
  );
  const addOwnerRefused = await request(`/api/v1/projects/${project.id}/members`, {
    method: "POST",
    body: JSON.stringify({ email: loginEmail, role: "owner" }),
  });
  check(
    "adding a member as owner is refused",
    addOwnerRefused.response.status === 409 && addOwnerRefused.body?.error?.code === "SINGLE_OWNER",
    addOwnerRefused.body,
  );

  const transferred = await expectOk(
    "transfer project ownership",
    `/api/v1/projects/${project.id}/owner`,
    { method: "POST", body: JSON.stringify({ user_id: addedMember.member.id }) },
  );
  check(
    "transfer makes the member the only owner",
    transferred.owner?.id === addedMember.member.id &&
      transferred.owner?.role === "owner" &&
      transferred.previous_owner_id === me.user.id,
    transferred,
  );
  const membersAfterTransfer = await expectOk(
    "list members after transfer",
    `/api/v1/projects/${project.id}/members`,
  );
  check(
    "exactly one owner after transfer, previous owner kept as member",
    membersAfterTransfer.members.filter((member) => member.role === "owner").length === 1 &&
      membersAfterTransfer.members.some((member) => member.id === me.user.id && member.role === "member"),
    membersAfterTransfer.members,
  );
  const formerOwnerRemoves = await request(
    `/api/v1/projects/${project.id}/members/${addedMember.member.id}`,
    { method: "DELETE" },
  );
  check(
    "former owner can no longer remove the new owner",
    formerOwnerRemoves.response.status === 403,
    formerOwnerRemoves.body,
  );

  // Hand ownership back using the new owner's own session.
  const ownerLogin = await rawRequest("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: loginEmail, password: nextPassword }),
  });
  const ownerCookie = (ownerLogin.response.headers.get("set-cookie") ?? "").split(";")[0];
  const transferBack = await rawRequest(`/api/v1/projects/${project.id}/owner`, {
    method: "POST",
    headers: { Cookie: ownerCookie },
    body: JSON.stringify({ user_id: me.user.id }),
  });
  check(
    "new owner transfers ownership back",
    transferBack.response.status === 200 && transferBack.body?.owner?.id === me.user.id,
    transferBack.body,
  );

  // ---------- Admin visibility matches implicit owner rights (issue #5) ----------
  const createdHidden = await expectOk("create project for admin visibility", "/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ slug: `adminvis-${suffix}`, name: `Admin vis ${suffix}`, verification_mode: "human" }),
  });
  const hiddenProject = createdHidden.project;
  const hiddenMember = await expectOk("add member to visibility project", `/api/v1/projects/${hiddenProject.id}/members`, {
    method: "POST",
    body: JSON.stringify({ email: loginEmail }),
  });
  await expectOk("hand visibility project to member", `/api/v1/projects/${hiddenProject.id}/owner`, {
    method: "POST",
    body: JSON.stringify({ user_id: hiddenMember.member.id }),
  });
  const adminLeaves = await rawRequest(`/api/v1/projects/${hiddenProject.id}/members/${me.user.id}`, {
    method: "DELETE",
    headers: { Cookie: ownerCookie },
  });
  check("owner removes the admin from the project", adminLeaves.response.status === 200, adminLeaves.body);
  const adminProjects = await expectOk("admin lists projects", "/api/v1/projects");
  const adminListed = adminProjects.projects.find((item) => item.id === hiddenProject.id);
  check(
    "admin sees non-member project as implicit owner",
    adminListed?.role === "owner" && adminListed?.access === "admin",
    adminListed,
  );
  const adminMe = await expectOk("admin me lists projects", "/api/v1/me");
  check(
    "admin /me matches /projects",
    adminMe.projects.some((item) => item.id === hiddenProject.id && item.access === "admin"),
    adminMe.projects,
  );
  const adminOpens = await expectOk("admin opens non-member project", `/api/v1/projects/${hiddenProject.id}`);
  check("project detail reports admin access", adminOpens.project?.access === "admin", adminOpens.project);
  const memberProjects = await rawRequest("/api/v1/projects", { headers: { Cookie: ownerCookie } });
  check(
    "non-admin list is unchanged (memberships only)",
    memberProjects.body?.projects?.every((item) => item.access === "member"),
    memberProjects.body,
  );

  const lastOwnerDemote = await request(
    `/api/v1/projects/${project.id}/members/${me.user.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    },
  );
  check(
    "cannot demote the last project owner",
    lastOwnerDemote.response.status === 409 &&
      lastOwnerDemote.body?.error?.code === "LAST_OWNER",
    lastOwnerDemote.body,
  );

  const unknownMember = await request(
    `/api/v1/projects/${project.id}/members`,
    {
      method: "POST",
      body: JSON.stringify({ email: `missing-${suffix}@example.com`, role: "member" }),
    },
  );
  check(
    "adding an unknown user is rejected",
    unknownMember.response.status === 404 &&
      unknownMember.body?.error?.code === "USER_NOT_FOUND",
    unknownMember.body,
  );

  const removedMember = await expectOk(
    "remove project member",
    `/api/v1/projects/${project.id}/members/${addedMember.member.id}`,
    { method: "DELETE" },
  );
  check("project member removed", removedMember.ok === true, removedMember);

  const joinRequest = await rawRequest(
    `/api/v1/projects/${project.id}/join-requests`,
    {
      method: "POST",
      headers: { "X-Dev-Email": loginEmail },
      body: JSON.stringify({ note: "smoke join request" }),
    },
  );
  check(
    "join request submitted",
    joinRequest.response.status === 201 &&
      joinRequest.body?.join_request?.status === "pending",
    joinRequest.body,
  );

  const myJoinRequests = await rawRequest("/api/v1/join-requests", {
    headers: { "X-Dev-Email": loginEmail },
  });
  check(
    "my join requests includes pending request",
    myJoinRequests.body?.join_requests?.some(
      (request) => request.project_id === project.id && request.status === "pending",
    ),
    myJoinRequests.body,
  );

  const ownerJoinRequests = await expectOk(
    "list project join requests",
    `/api/v1/projects/${project.id}/join-requests`,
  );
  check(
    "owner sees pending join request",
    ownerJoinRequests.join_requests.some(
      (request) => request.user_id === addedMember.member.id,
    ),
    ownerJoinRequests.join_requests,
  );

  const approvedJoin = await expectOk(
    "approve join request",
    `/api/v1/projects/${project.id}/join-requests/${addedMember.member.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "approved" }),
    },
  );
  check(
    "join request approved",
    approvedJoin.join_request?.status === "approved",
    approvedJoin.join_request,
  );

  const joinedProjects = await rawRequest("/api/v1/projects", {
    headers: { "X-Dev-Email": loginEmail },
  });
  check(
    "approved user can see the project",
    joinedProjects.body?.projects?.some(
      (item) => item.id === project.id && item.role === "member",
    ),
    joinedProjects.body,
  );

  const duplicateJoin = await rawRequest(
    `/api/v1/projects/${project.id}/join-requests`,
    {
      method: "POST",
      headers: { "X-Dev-Email": loginEmail },
      body: JSON.stringify({}),
    },
  );
  check(
    "existing member cannot submit another join request",
    duplicateJoin.response.status === 409 &&
      duplicateJoin.body?.error?.code === "ALREADY_MEMBER",
    duplicateJoin.body,
  );

  await expectOk("set execution target", `/api/v1/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      exec_targets: [
        {
          provider: "github_actions",
          owner: "acme",
          repo: "etl-jobs",
          workflows: ["normalize.yml"],
        },
      ],
    }),
  });

  const createdCard = await expectOk("create card", `/api/v1/projects/${project.id}/cards`, {
    method: "POST",
    body: JSON.stringify({
      title: "归一化日志",
      body: "S1 smoke card",
      priority: 10,
      criteria: [{ key: "row_count", op: "eq", value: 30000 }],
    }),
  });
  const card = createdCard.card;
  check("card starts open", card.status === "open", card);
  check("card version 1", card.version === 1, card);
  check("card requester is human", card.requester_type === "user", card);
  check("card requester name", card.requester_name === EMAIL.toLowerCase(), card);
  check(
    "card creator is human",
    card.creator_type === "user" && card.creator_id === card.created_by_id,
    card,
  );

  const board = await expectOk("board", `/api/v1/projects/${project.id}/board`);
  const boardCard = board.columns.open.find((item) => item.id === card.id);
  check("board has card", Boolean(boardCard), board.columns.open);
  check("board card requester name", boardCard?.requester_name === EMAIL.toLowerCase(), boardCard);
  check("board seq", Number.isInteger(board.seq), board.seq);

  const cardDetail = await expectOk("card detail", `/api/v1/cards/${card.id}`);
  check(
    "card detail requester name",
    cardDetail.card.requester_name === EMAIL.toLowerCase(),
    cardDetail.card,
  );

  const parallel = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      request(`/api/v1/projects/${project.id}/cards`, {
        method: "POST",
        body: JSON.stringify({ title: `parallel-${index}`, priority: 0 }),
      }),
    ),
  );
  check(
    "parallel creates all succeed",
    parallel.every(({ response }) => response.status === 201),
    parallel.map(({ response, body }) => ({ status: response.status, body })),
  );
  const boardAfterParallel = await expectOk("board after parallel", `/api/v1/projects/${project.id}/board`);
  check(
    "seq increments once per event",
    boardAfterParallel.seq === board.seq + parallel.length,
    { before: board.seq, after: boardAfterParallel.seq, created: parallel.length },
  );

  const patched = await expectOk("patch card", `/api/v1/cards/${card.id}`, {
    method: "PATCH",
    headers: { "If-Match": String(card.version) },
    body: JSON.stringify({ title: "归一化日志（改）", priority: 20 }),
  });
  check("version incremented", patched.card.version === card.version + 1, patched.card);

  const stale = await request(`/api/v1/cards/${card.id}`, {
    method: "PATCH",
    headers: { "If-Match": String(card.version) },
    body: JSON.stringify({ title: "stale" }),
  });
  check("stale If-Match -> 409", stale.response.status === 409, stale.body);

  const closed = await expectOk("close card", `/api/v1/cards/${card.id}/close`, {
    method: "POST",
    headers: { "If-Match": String(patched.card.version) },
    body: JSON.stringify({ reason: "smoke test close reason" }),
  });
  check("closed outcome", closed.card.status === "closed" && closed.card.outcome === "cancelled", closed.card);

  const reopened = await expectOk("reopen card", `/api/v1/cards/${card.id}/reopen`, {
    method: "POST",
    headers: { "If-Match": String(closed.card.version) },
    body: JSON.stringify({ reason: "smoke test reopen reason" }),
  });
  check("reopened round 2", reopened.card.status === "open" && reopened.card.round === 2, reopened.card);

  const requestedAgentId = `${project.id}:smoke-agent`;
  const registered = await expectOk("register agent", "/agent/register", {
    method: "POST",
    headers: { Authorization: `Bearer ${enrollmentToken}` },
    body: JSON.stringify({
      id: requestedAgentId,
      harness: "opencode-cli",
      harness_version: "1.0.3",
      name: "smoke agent",
      card: { max_concurrency: 2, skills: [{ key: "log_normalize", level: "expert" }] },
    }),
  });
  check("agent token issued", typeof registered.agent_token === "string" && registered.agent_token.startsWith("kbt1."), registered);
  const agentToken = registered.agent_token;
  // The server returns the canonical project-scoped id; use it for every later call.
  const agentId = registered.id;

  const activated = await expectOk(
    "activate agent",
    `/api/v1/projects/${project.id}/agents/${encodeURIComponent(agentId)}/status`,
    { method: "POST", body: JSON.stringify({ status: "active" }) },
  );
  check("agent active", activated.agent.status === "active", activated.agent);

  const agentMe = await expectOk("agent me", "/agent/me", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  check("agent me project", agentMe.agent.project_id === project.id, agentMe);
  // Cards store the internal agent key; the public identity stays scoped per project.
  const agentInternalId = agentMe.agent.internal_id;

  const projectAgents = await expectOk("project agents", `/api/v1/projects/${project.id}/agents`);
  check(
    "project agents includes active agent",
    projectAgents.agents.some((item) => item.id === agentId && item.status === "active"),
    projectAgents.agents,
  );

  const agentCards = await expectOk("agent cards", "/agent/cards?status=open", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  check("agent sees open card", agentCards.cards.some((item) => item.id === card.id), agentCards.cards);

  const agentCard = await expectOk("agent creates own card", "/agent/cards", {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      title: "Agent-created card",
      body: "created by agent",
      priority: 5,
      criteria: [{ key: "ok", op: "eq", value: true }],
    }),
  });
  check("agent card ownership", agentCard.card.created_by_type === "agent", agentCard.card);
  check("agent card creator", agentCard.card.created_by_id === agentInternalId, agentCard.card);

  const emptyNegotiation = await expectOk(
    "requester reads empty negotiation",
    `/agent/cards/${agentCard.card.id}/negotiation`,
    { headers: { Authorization: `Bearer ${agentToken}` } },
  );
  check(
    "no session yet -> null session",
    emptyNegotiation.session === null && emptyNegotiation.proposals.length === 0,
    emptyNegotiation,
  );

  const agentClose = await expectOk(
    "agent closes own card",
    `/agent/cards/${agentCard.card.id}/close`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "If-Match": String(agentCard.card.version),
      },
      body: JSON.stringify({ reason: "agent no longer needs this card" }),
    },
  );
  check("agent card closed", agentClose.card.status === "closed", agentClose.card);

  const agentReopen = await expectOk(
    "agent reopens own card",
    `/agent/cards/${agentCard.card.id}/reopen`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "If-Match": String(agentClose.card.version),
      },
      body: JSON.stringify({ reason: "agent resumes this card" }),
    },
  );
  check("agent card reopened", agentReopen.card.status === "open", agentReopen.card);

  const requestedAgent2Id = `${project.id}:smoke-agent-2`;
  const registered2 = await expectOk("register second agent", "/agent/register", {
    method: "POST",
    headers: { Authorization: `Bearer ${enrollmentToken}` },
    body: JSON.stringify({
      id: requestedAgent2Id,
      harness: "opencode",
      harness_version: "1.0.3",
      name: "smoke agent 2",
      card: { max_concurrency: 1 },
    }),
  });
  check("second agent token issued", typeof registered2.agent_token === "string", registered2);
  const agent2Token = registered2.agent_token;
  const agent2Id = registered2.id;
  await expectOk(
    "activate second agent",
    `/api/v1/projects/${project.id}/agents/${encodeURIComponent(agent2Id)}/status`,
    { method: "POST", body: JSON.stringify({ status: "active" }) },
  );
  const agent2Me = await expectOk("agent me (second agent)", "/agent/me", {
    headers: { Authorization: `Bearer ${agent2Token}` },
  });
  const agent2InternalId = agent2Me.agent.internal_id;

  const terms = {
    scope: ["normalize logs"],
    out_of_scope: ["upload to warehouse"],
    estimate_minutes: 30,
    cost_credits: 2,
    requires: [{ kind: "input", ref: "map.yaml" }],
    risks: [{ code: "ENCODING", mitigation: "sample first" }],
    deliverables: [{ kind: "artifact", media_type: "text/csv" }],
    acceptance: [{ key: "row_count", op: "eq", value: 30000 }],
  };
  const proposalHash = termsHash(terms);
  const proposalMessageId = randomUUID();
  const proposal = await expectOk(
    "agent 2 submits proposal",
    `/agent/cards/${agentCard.card.id}/negotiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({
        message_id: proposalMessageId,
        type: "proposal",
        card_id: agentCard.card.id,
        terms,
        terms_hash: proposalHash,
      }),
    },
  );
  check("proposal opens session", typeof proposal.session_id === "string", proposal);
  const duplicateProposal = await expectOk(
    "duplicate proposal is idempotent",
    `/agent/cards/${agentCard.card.id}/negotiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({
        message_id: proposalMessageId,
        type: "proposal",
        card_id: agentCard.card.id,
        terms,
        terms_hash: proposalHash,
      }),
    },
  );
  check("duplicate proposal flagged", duplicateProposal.duplicate === true, duplicateProposal);

  // Regression (#8): the requester must be able to read the proposal it is expected to accept.
  const requesterView = await expectOk(
    "requester reads negotiation",
    `/agent/cards/${agentCard.card.id}/negotiation`,
    { headers: { Authorization: `Bearer ${agentToken}` } },
  );
  check(
    "requester sees open session",
    requesterView.session?.id === proposal.session_id && requesterView.session?.state === "open",
    requesterView.session,
  );
  check(
    "requester reads latest proposal terms and hash",
    requesterView.latest_proposal?.terms_hash === proposalHash &&
      requesterView.latest_proposal?.terms?.estimate_minutes === terms.estimate_minutes,
    requesterView.latest_proposal,
  );
  const readHash = requesterView.latest_proposal?.terms_hash;
  check("requester read yields a usable terms_hash", typeof readHash === "string", readHash);

  const forgedCommit = await request(`/agent/cards/${agentCard.card.id}/negotiate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      message_id: randomUUID(),
      type: "commit",
      card_id: agentCard.card.id,
      session_id: requesterView.session?.id,
      terms_hash: readHash,
      proof: { by: agentId, alg: "HMAC-SHA256", value: "not-a-valid-proof" },
    }),
  });
  check(
    "forged acceptance proof rejected",
    forgedCommit.response.status === 422 && forgedCommit.body?.error?.code === "INVALID_PROOF",
    forgedCommit.body,
  );

  const commit = await expectOk(
    "agent 1 commits to proposal",
    `/agent/cards/${agentCard.card.id}/negotiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({
        message_id: randomUUID(),
        type: "commit",
        card_id: agentCard.card.id,
        session_id: requesterView.session?.id,
        terms: requesterView.latest_proposal?.terms,
        terms_hash: readHash,
        proof: {
          by: agentId,
          alg: "HMAC-SHA256",
          value: acceptanceProof(agentToken, readHash),
        },
      }),
    },
  );
  check(
    "agent contract engaged",
    commit.status === "engaged" && typeof commit.contract_id === "string",
    commit,
  );

  // #8: an agent-created card may also be accepted by the project owner on the agent's behalf.
  const ownerAcceptCard = await expectOk(
    "agent creates card for owner acceptance",
    "/agent/cards",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({
        title: "Agent card accepted by owner",
        body: "owner accepts on behalf of the requester agent",
        priority: 3,
        criteria: [{ key: "ok", op: "eq", value: true }],
      }),
    },
  );
  const ownerAcceptHash = termsHash(terms);
  await expectOk(
    "agent 2 proposes on owner-accept card",
    `/agent/cards/${ownerAcceptCard.card.id}/negotiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({
        message_id: randomUUID(),
        type: "proposal",
        card_id: ownerAcceptCard.card.id,
        terms,
        terms_hash: ownerAcceptHash,
      }),
    },
  );
  const memberCannotAccept = await rawRequest(
    `/api/v1/cards/${ownerAcceptCard.card.id}/commit`,
    {
      method: "POST",
      headers: { "X-Dev-Email": loginEmail },
      body: JSON.stringify({ message_id: randomUUID(), terms_hash: ownerAcceptHash }),
    },
  );
  check(
    "non-owner member cannot accept agent card",
    memberCannotAccept.response.status === 403,
    memberCannotAccept.body,
  );
  const ownerAccepts = await expectOk(
    "project owner accepts agent card",
    `/api/v1/cards/${ownerAcceptCard.card.id}/commit`,
    {
      method: "POST",
      body: JSON.stringify({ message_id: randomUUID(), terms_hash: ownerAcceptHash }),
    },
  );
  check(
    "owner-accepted agent card engaged",
    ownerAccepts.card.status === "engaged" && ownerAccepts.card.assignee_agent_id === agent2InternalId,
    ownerAccepts.card,
  );

  const ticket = await expectOk(
    "request execution ticket",
    `/agent/cards/${agentCard.card.id}/tickets`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({ provider: "github_actions" }),
    },
  );
  check(
    "ticket issued with allow-listed target",
    typeof ticket.ticket_id === "string" &&
      ticket.target?.owner === "acme" &&
      ticket.target?.workflow === "normalize.yml",
    ticket,
  );

  const lease = await expectOk(
    "acquire lease",
    `/agent/cards/${agentCard.card.id}/lease`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({ ttl_minutes: 30 }),
    },
  );
  check("lease acquired", lease.lease_owner === agent2InternalId, lease);
  const leaseReleased = await expectOk(
    "release lease",
    `/agent/cards/${agentCard.card.id}/lease`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${agent2Token}` },
    },
  );
  check("lease released", leaseReleased.released === true, leaseReleased);

  const emptyReport = await request(`/agent/cards/${agentCard.card.id}/runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${agent2Token}` },
    body: JSON.stringify({
      ticket_id: ticket.ticket_id,
      provider: "github_actions",
      run: {
        run_id: 1,
        run_attempt: 1,
        html_url: "https://github.com/acme/etl-jobs/actions/runs/1",
      },
      artifacts: [],
    }),
  });
  const stillRunning = await request(`/agent/cards?status=running`, {
    headers: { Authorization: `Bearer ${agent2Token}` },
  });
  check(
    "report without artifacts rejected and card stays running",
    emptyReport.response.status === 422 &&
      emptyReport.body?.error?.code === "EVIDENCE_REQUIRED" &&
      (stillRunning.body?.cards ?? []).some((item) => item.id === agentCard.card.id),
    { status: emptyReport.response.status, body: emptyReport.body },
  );

  const runWithoutVerification = await request(
    `/agent/cards/${agentCard.card.id}/runs`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({
        ticket_id: ticket.ticket_id,
        provider: "github_actions",
        run: {
          run_id: 1,
          run_attempt: 1,
          html_url: "https://github.com/acme/etl-jobs/actions/runs/1",
        },
        artifacts: [{ name: "normalized.csv", sha256: "abc12345", size_bytes: 10 }],
      }),
    },
  );
  check(
    "invalid or unverifiable run rejected",
    [422, 503].includes(runWithoutVerification.response.status),
    runWithoutVerification.body,
  );

  const humanNegotiationCard = await expectOk(
    "create human card for negotiation",
    `/api/v1/projects/${project.id}/cards`,
    {
      method: "POST",
      body: JSON.stringify({ title: "Human negotiation card", priority: 2 }),
    },
  );
  const humanProposalHash = termsHash(terms);
  const humanProposal = await expectOk(
    "agent 2 proposes on human card",
    `/agent/cards/${humanNegotiationCard.card.id}/negotiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({
        message_id: randomUUID(),
        type: "proposal",
        card_id: humanNegotiationCard.card.id,
        terms,
        terms_hash: humanProposalHash,
      }),
    },
  );
  const outsiderView = await request(
    `/agent/cards/${humanNegotiationCard.card.id}/negotiation`,
    { headers: { Authorization: `Bearer ${agentToken}` } },
  );
  check(
    "non-participant cannot read negotiation",
    outsiderView.response.status === 403,
    outsiderView.body,
  );
  const humanCommit = await expectOk(
    "human accepts agent proposal",
    `/api/v1/cards/${humanNegotiationCard.card.id}/commit`,
    {
      method: "POST",
      body: JSON.stringify({
        message_id: randomUUID(),
        session_id: humanProposal.session_id,
        terms_hash: humanProposalHash,
      }),
    },
  );
  check(
    "human contract engaged",
    humanCommit.card.status === "engaged" &&
      humanCommit.card.assignee_agent_id === agent2InternalId,
    humanCommit,
  );

  const cancelledContractCard = await expectOk(
    "close contracted human card",
    `/api/v1/cards/${humanNegotiationCard.card.id}/close`,
    {
      method: "POST",
      headers: { "If-Match": String(humanCommit.card.version) },
      body: JSON.stringify({ reason: "replace the negotiated contract" }),
    },
  );
  const reopenedContractCard = await expectOk(
    "reopen contracted human card",
    `/api/v1/cards/${humanNegotiationCard.card.id}/reopen`,
    {
      method: "POST",
      headers: { "If-Match": String(cancelledContractCard.card.version) },
      body: JSON.stringify({ reason: "negotiate a replacement contract" }),
    },
  );
  check("reopened contract starts a new round", reopenedContractCard.card.round > humanCommit.card.round);
  const historicalCommit = await request(`/api/v1/cards/${humanNegotiationCard.card.id}/commit`, {
    method: "POST",
    body: JSON.stringify({
      message_id: randomUUID(),
      session_id: humanProposal.session_id,
      proposal_id: humanProposal.proposal_id,
      terms_hash: humanProposalHash,
    }),
  });
  check("historical negotiation cannot be accepted after reopen", historicalCommit.response.status === 409, historicalCommit.body);

  const replacementProposal = await expectOk(
    "propose after closing and reopening a contracted card",
    `/agent/cards/${humanNegotiationCard.card.id}/negotiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({
        message_id: randomUUID(),
        type: "proposal",
        card_id: humanNegotiationCard.card.id,
        terms,
        terms_hash: humanProposalHash,
      }),
    },
  );
  const revisedTerms = { ...terms, estimate_minutes: terms.estimate_minutes + 1 };
  const revisedTermsHash = termsHash(revisedTerms);
  const revisedProposal = await expectOk(
    "counter replacement proposal",
    `/agent/cards/${humanNegotiationCard.card.id}/negotiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agent2Token}` },
      body: JSON.stringify({
        message_id: randomUUID(),
        type: "counter",
        card_id: humanNegotiationCard.card.id,
        session_id: replacementProposal.session_id,
        terms: revisedTerms,
        terms_hash: revisedTermsHash,
      }),
    },
  );
  const supersededCommit = await request(`/api/v1/cards/${humanNegotiationCard.card.id}/commit`, {
    method: "POST",
    body: JSON.stringify({
      message_id: randomUUID(),
      session_id: replacementProposal.session_id,
      proposal_id: replacementProposal.proposal_id,
      terms_hash: humanProposalHash,
    }),
  });
  check("countered offer cannot be accepted", supersededCommit.response.status === 409, supersededCommit.body);
  const recommitted = await expectOk(
    "accept latest replacement proposal after reopen",
    `/api/v1/cards/${humanNegotiationCard.card.id}/commit`,
    {
      method: "POST",
      body: JSON.stringify({
        message_id: randomUUID(),
        session_id: revisedProposal.session_id,
        proposal_id: revisedProposal.proposal_id,
        terms_hash: revisedTermsHash,
      }),
    },
  );
  check("replacement contract engages reopened card", recommitted.card.status === "engaged", recommitted);

  const humanCard = await expectOk("create human card for permission test", `/api/v1/projects/${project.id}/cards`, {
    method: "POST",
    body: JSON.stringify({ title: "Human-owned card", priority: 1 }),
  });
  const agentCannotCloseHuman = await request(
    `/agent/cards/${humanCard.card.id}/close`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "If-Match": String(humanCard.card.version),
      },
      body: JSON.stringify({ reason: "agent must not close human cards" }),
    },
  );
  check(
    "agent cannot close human card",
    agentCannotCloseHuman.response.status === 403,
    agentCannotCloseHuman.body,
  );

  const paused = await expectOk(
    "pause card",
    `/api/v1/cards/${humanCard.card.id}/intervene`,
    {
      method: "POST",
      body: JSON.stringify({ type: "pause", reason: "smoke pause reason" }),
    },
  );
  check("card paused", Boolean(paused.card.paused_at), paused.card);

  const resumed = await expectOk(
    "resume card",
    `/api/v1/cards/${humanCard.card.id}/intervene`,
    {
      method: "POST",
      body: JSON.stringify({ type: "resume", reason: "smoke resume reason" }),
    },
  );
  check("card resumed", resumed.card.paused_at === null, resumed.card);

  const redirected = await expectOk(
    "redirect card",
    `/api/v1/cards/${humanCard.card.id}/intervene`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "redirect",
        reason: "smoke redirect reason",
        payload: { priority: 9 },
      }),
    },
  );
  check(
    "card redirected",
    redirected.card.status === "open" && redirected.card.priority === 9,
    redirected.card,
  );

  const rejectedProposal = await expectOk(
    "reject open proposal",
    `/api/v1/cards/${humanCard.card.id}/intervene`,
    {
      method: "POST",
      body: JSON.stringify({ type: "reject", reason: "smoke reject reason" }),
    },
  );
  check("card stays open after proposal reject", rejectedProposal.card.status === "open", rejectedProposal.card);

  const flushed = await expectOk("audit flush", `/api/v1/projects/${project.id}/audit/flush`, {
    method: "POST",
  });
  check("audit flush returns a valid count", Number.isInteger(flushed.flushed) && flushed.flushed >= 0, flushed);

  const audit = await expectOk("audit list", `/api/v1/projects/${project.id}/audit`);
  check("audit entries present", audit.entries.length > 0, audit.entries);

  const verified = await expectOk("audit verify", `/api/v1/projects/${project.id}/audit/verify`);
  check("audit chain ok", verified.ok === true, verified);
  check("audit covers the complete accepted boundary", verified.complete === true && verified.pending === 0 && verified.checked === verified.as_of_seq && (verified.head?.seq ?? 0) === verified.as_of_seq, verified);
  const auditBoard = await expectOk("board at verified audit boundary", `/api/v1/projects/${project.id}/board`);
  check("event and audit heads agree", auditBoard.seq === verified.as_of_seq, { event_seq: auditBoard.seq, audit_seq: verified.as_of_seq });

  // SSE: read until hello, then abort.
  const controller = new AbortController();
  const sse = await fetch(
    `${BASE}/api/v1/projects/${project.id}/events?since=0&dev_email=${encodeURIComponent(EMAIL)}`,
    { signal: controller.signal },
  );
  check("sse status 200", sse.status === 200, sse.status);
  const reader = sse.body.getReader();
  let sseText = "";
  const decoder = new TextDecoder();
  while (!sseText.includes("\"t\":\"hello\"")) {
    const { value, done } = await reader.read();
    if (done) break;
    sseText += decoder.decode(value, { stream: true });
    if (sseText.length > 200_000) break;
  }
  controller.abort();
  check("sse hello received", sseText.includes("\"t\":\"hello\""), sseText.slice(0, 400));
  check("sse replayed event", sseText.includes("\"t\":\"event\""), sseText.slice(0, 400));

  // ---------- Agent global identity + multi-project membership ----------
  const createdProjectB = await expectOk("create project B", "/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      slug: `multi-b-${suffix}`,
      name: `Multi B ${suffix}`,
      verification_mode: "human",
    }),
  });
  const projectB = createdProjectB.project;
  const enrollmentB = createdProjectB.enrollment_token;

  const joinedB = await expectOk("agent joins project B", "/agent/projects", {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ enrollment_token: enrollmentB }),
  });
  check(
    "agent membership pending in B",
    joinedB.membership?.status === "pending",
    joinedB,
  );
  check(
    "joining B issues a project-scoped credential",
    typeof joinedB.agent_token === "string" && joinedB.agent_token.startsWith("kbt1."),
    joinedB,
  );
  const agentBToken = joinedB.agent_token;

  const multiMe = await expectOk("agent me after joining B", "/agent/me", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  check(
    "agent me lists both projects",
    multiMe.projects?.some((item) => item.id === project.id) &&
      multiMe.projects?.some((item) => item.id === projectB.id),
    multiMe.projects,
  );

  const activatedB = await expectOk(
    "activate agent in project B",
    `/api/v1/projects/${projectB.id}/agents/${encodeURIComponent(joinedB.membership.agent_id)}/status`,
    { method: "POST", body: JSON.stringify({ status: "active" }) },
  );
  check("project B membership active", activatedB.agent?.status === "active", activatedB.agent);

  const cardB = await expectOk("agent creates card in B", "/agent/cards", {
    method: "POST",
    headers: { Authorization: `Bearer ${agentBToken}` },
    body: JSON.stringify({
      project_id: projectB.id,
      title: "Agent card in B",
      priority: 1,
    }),
  });
  check("card B belongs to B", cardB.card?.project_id === projectB.id, cardB.card);

  // Credentials are project-scoped: the project A token only ever sees A,
  // even while the agent is an active member of B.
  const aScopedCards = await expectOk("project A token lists cards", "/agent/cards?limit=200", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  check(
    "project A token sees only project A cards",
    aScopedCards.cards?.length > 0 &&
      aScopedCards.cards.every((item) => item.project_id === project.id),
    aScopedCards.cards?.map((item) => item.project_id),
  );
  const crossScope = await request(
    `/agent/cards?project_id=${encodeURIComponent(projectB.id)}`,
    { headers: { Authorization: `Bearer ${agentToken}` } },
  );
  check(
    "active project A credential cannot list project B",
    crossScope.response.status === 403 &&
      crossScope.body?.error?.code === "CREDENTIAL_SCOPE_MISMATCH",
    crossScope.body,
  );
  const crossCard = await request(`/agent/cards/${cardB.card.id}/negotiation`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  check(
    "active project A credential cannot read a project B card",
    crossCard.response.status === 404,
    crossCard.body,
  );
  const crossCreate = await request("/agent/cards", {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ project_id: projectB.id, title: "cross-scope write", priority: 1 }),
  });
  check(
    "active project A credential cannot create cards in project B",
    crossCreate.response.status === 403,
    crossCreate.body,
  );
  const crossPeers = await request(`/agent/peers?project_id=${encodeURIComponent(projectB.id)}`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  check(
    "active project A credential cannot list project B peers",
    crossPeers.response.status === 403,
    crossPeers.body,
  );

  const bOnlyCards = await expectOk(
    "agent lists project B cards",
    `/agent/cards?project_id=${encodeURIComponent(projectB.id)}`,
    { headers: { Authorization: `Bearer ${agentBToken}` } },
  );
  check(
    "explicit project filter works",
    bOnlyCards.cards?.length > 0 &&
      bOnlyCards.cards.every((item) => item.project_id === projectB.id),
    bOnlyCards.cards,
  );

  await expectOk(
    "disable agent in project A",
    `/api/v1/projects/${project.id}/agents/${encodeURIComponent(agentId)}/status`,
    { method: "POST", body: JSON.stringify({ status: "disabled" }) },
  );
  const blockedA = await request(
    `/agent/cards?project_id=${encodeURIComponent(project.id)}`,
    { headers: { Authorization: `Bearer ${agentToken}` } },
  );
  check(
    "disabled membership blocks project A",
    blockedA.response.status === 403,
    blockedA.body,
  );
  const stillB = await expectOk(
    "project B unaffected by A disable",
    `/agent/cards?project_id=${encodeURIComponent(projectB.id)}`,
    { headers: { Authorization: `Bearer ${agentBToken}` } },
  );
  check(
    "project B still accessible with its own credential",
    stillB.cards?.some((item) => item.project_id === projectB.id),
    stillB.cards,
  );
  await expectOk(
    "re-enable agent in project A",
    `/api/v1/projects/${project.id}/agents/${encodeURIComponent(agentId)}/status`,
    { method: "POST", body: JSON.stringify({ status: "active" }) },
  );

  // ---------- Project archive / restore / permanent delete ----------
  const createdProjectD = await expectOk("create archive project", "/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      slug: `archive-${suffix}`,
      name: `Archive ${suffix}`,
      verification_mode: "human",
    }),
  });
  const projectD = createdProjectD.project;
  const enrollmentD = createdProjectD.enrollment_token;

  const joinD = await rawRequest(
    `/api/v1/projects/${projectD.id}/join-requests`,
    {
      method: "POST",
      headers: { "X-Dev-Email": loginEmail },
      body: JSON.stringify({ note: "archive smoke request" }),
    },
  );
  check("archive project join request submitted", joinD.response.status === 201, joinD.body);

  const joinedD = await expectOk("agent joins archive project", "/agent/projects", {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ enrollment_token: enrollmentD }),
  });
  await expectOk(
    "activate agent in archive project",
    `/api/v1/projects/${projectD.id}/agents/${encodeURIComponent(joinedD.membership.agent_id)}/status`,
    { method: "POST", body: JSON.stringify({ status: "active" }) },
  );
  const cardD = await expectOk(
    "create archive project card",
    `/api/v1/projects/${projectD.id}/cards`,
    {
      method: "POST",
      body: JSON.stringify({ title: "Archive project card", priority: 1 }),
    },
  );

  const wrongArchive = await request(
    `/api/v1/projects/${projectD.id}/archive`,
    { method: "POST", body: JSON.stringify({ confirm_slug: "not-the-slug" }) },
  );
  check(
    "archive rejects wrong slug",
    wrongArchive.response.status === 400 &&
      wrongArchive.body?.error?.code === "CONFIRM_SLUG_MISMATCH",
    wrongArchive.body,
  );

  const archivedD = await expectOk(
    "archive project",
    `/api/v1/projects/${projectD.id}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ confirm_slug: projectD.slug, reason: "smoke archive" }),
    },
  );
  const archivedSlugD = archivedD.project?.slug;
  check(
    "archive renames slug",
    typeof archivedSlugD === "string" && archivedSlugD.startsWith("archived-"),
    archivedD.project,
  );

  const projectsAfterArchive = await expectOk("list projects after archive", "/api/v1/projects");
  check(
    "archived project hidden from project list",
    !projectsAfterArchive.projects.some((item) => item.id === projectD.id),
    projectsAfterArchive.projects,
  );

  const archivedList = await expectOk("list archived projects", "/api/v1/projects/archived");
  const archivedEntry = archivedList.projects.find((item) => item.id === projectD.id);
  check(
    "archived list includes project and reason",
    Boolean(archivedEntry) && archivedEntry.archive_reason === "smoke archive",
    archivedEntry,
  );

  const archivedBoard = await request(`/api/v1/projects/${projectD.id}/board`);
  check("archived project board returns 404", archivedBoard.response.status === 404, archivedBoard.body);

  // Use the credential issued for D: the project A token is refused for D
  // regardless of archive state (credential scope).
  const archivedAgentAccess = await request(
    `/agent/cards?project_id=${encodeURIComponent(projectD.id)}`,
    { headers: { Authorization: `Bearer ${joinedD.agent_token}` } },
  );
  check(
    "agent access to archived project returns 403",
    archivedAgentAccess.response.status === 403 &&
      archivedAgentAccess.body?.error?.code === "PROJECT_ARCHIVED",
    archivedAgentAccess.body,
  );

  const myRequestsAfterArchive = await rawRequest("/api/v1/join-requests", {
    headers: { "X-Dev-Email": loginEmail },
  });
  check(
    "pending join requests are rejected on archive",
    !myRequestsAfterArchive.body?.join_requests?.some(
      (item) => item.project_id === projectD.id && item.status === "pending",
    ),
    myRequestsAfterArchive.body,
  );

  const reusedSlug = await expectOk("reuse archived project slug", "/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      slug: projectD.slug,
      name: `Reused slug ${suffix}`,
      verification_mode: "human",
    }),
  });
  check(
    "original slug is released for reuse",
    reusedSlug.project?.slug === projectD.slug,
    reusedSlug.project,
  );

  const memberLogin = await rawRequest("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: loginEmail, password: nextPassword }),
  });
  const memberCookie = (memberLogin.response.headers.get("set-cookie") ?? "").split(";")[0];
  const memberPurge = await rawRequest(`/api/v1/projects/${projectD.id}`, {
    method: "DELETE",
    headers: { Cookie: memberCookie },
    body: JSON.stringify({ confirm_slug: archivedSlugD }),
  });
  check(
    "non-admin cannot permanently delete a project",
    memberPurge.response.status === 403,
    memberPurge.body,
  );

  const restoredD = await expectOk(
    "restore archived project",
    `/api/v1/projects/${projectD.id}/restore`,
    { method: "POST" },
  );
  check(
    "restored project gets a free slug",
    restoredD.project?.slug !== projectD.slug,
    restoredD.project,
  );
  const projectsAfterRestore = await expectOk("list projects after restore", "/api/v1/projects");
  check(
    "restored project is visible again",
    projectsAfterRestore.projects.some((item) => item.id === projectD.id),
    projectsAfterRestore.projects,
  );

  await expectOk("archive project again", `/api/v1/projects/${projectD.id}/archive`, {
    method: "POST",
    body: JSON.stringify({ confirm_slug: restoredD.project.slug, reason: "smoke purge" }),
  });
  const archivedAgain = await expectOk("list archived projects again", "/api/v1/projects/archived");
  const archivedAgainEntry = archivedAgain.projects.find((item) => item.id === projectD.id);
  check("project archived again", Boolean(archivedAgainEntry), archivedAgainEntry);

  const wrongPurge = await request(`/api/v1/projects/${projectD.id}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm_slug: "not-the-slug" }),
  });
  check(
    "permanent delete rejects wrong slug",
    wrongPurge.response.status === 400 &&
      wrongPurge.body?.error?.code === "CONFIRM_SLUG_MISMATCH",
    wrongPurge.body,
  );

  const purged = await expectOk("permanently delete project", `/api/v1/projects/${projectD.id}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm_slug: archivedAgainEntry.slug }),
  });
  check(
    "permanent delete returns events_purged flag",
    purged.ok === true && typeof purged.events_purged === "boolean",
    purged,
  );

  const archivedAfterPurge = await expectOk("archived list after purge", "/api/v1/projects/archived");
  check(
    "purged project is gone from archived list",
    !archivedAfterPurge.projects.some((item) => item.id === projectD.id),
    archivedAfterPurge.projects,
  );

  const purgedBoard = await request(`/api/v1/projects/${projectD.id}/board`);
  check("purged project board returns 404", purgedBoard.response.status === 404, purgedBoard.body);

  // Permanent deletion must preserve agents that still belong to other projects
  // even when the deleted project is their registration project.
  const createdProjectE = await expectOk("create origin purge project", "/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      slug: `origin-e-${suffix}`,
      name: `Origin E ${suffix}`,
      verification_mode: "human",
    }),
  });
  const projectE = createdProjectE.project;
  const requestedAgentEId = `${projectE.id}:multi-origin`;
  const registeredE = await expectOk("register multi-project origin agent", "/agent/register", {
    method: "POST",
    headers: { Authorization: `Bearer ${createdProjectE.enrollment_token}` },
    body: JSON.stringify({
      id: requestedAgentEId,
      harness: "smoke",
      harness_version: "1.0",
      name: "multi origin agent",
    }),
  });
  const agentEToken = registeredE.agent_token;
  check("origin agent token issued", typeof agentEToken === "string", registeredE);
  const agentEId = registeredE.id;

  const joinedE = await expectOk("origin agent joins project B", "/agent/projects", {
    method: "POST",
    headers: { Authorization: `Bearer ${agentEToken}` },
    body: JSON.stringify({ enrollment_token: enrollmentB }),
  });
  const agentEBToken = joinedE.agent_token;
  check(
    "origin agent receives a project B credential",
    typeof agentEBToken === "string" && agentEBToken.startsWith("kbt1."),
    joinedE,
  );
  await expectOk(
    "activate origin agent in project B",
    `/api/v1/projects/${projectB.id}/agents/${encodeURIComponent(joinedE.membership.agent_id)}/status`,
    { method: "POST", body: JSON.stringify({ status: "active" }) },
  );

  await expectOk("archive origin project", `/api/v1/projects/${projectE.id}/archive`, {
    method: "POST",
    body: JSON.stringify({ confirm_slug: projectE.slug }),
  });
  const archivedOriginList = await expectOk(
    "list archived projects before origin purge",
    "/api/v1/projects/archived",
  );
  const originEntry = archivedOriginList.projects.find((item) => item.id === projectE.id);
  check("origin project listed as archived", Boolean(originEntry), originEntry);

  await expectOk("purge origin project", `/api/v1/projects/${projectE.id}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm_slug: originEntry.slug }),
  });

  const originTokenAfterPurge = await request("/agent/me", {
    headers: { Authorization: `Bearer ${agentEToken}` },
  });
  check(
    "credential of the purged project is revoked",
    [401, 403].includes(originTokenAfterPurge.response.status),
    originTokenAfterPurge.body,
  );

  const originAgentMe = await expectOk("origin agent survives project purge", "/agent/me", {
    headers: { Authorization: `Bearer ${agentEBToken}` },
  });
  check(
    "origin agent keeps project B membership",
    originAgentMe.projects?.some((item) => item.id === projectB.id && item.status === "active"),
    originAgentMe.projects,
  );
  check(
    "agent credential is bound to project B",
    originAgentMe.agent?.project_id === projectB.id,
    originAgentMe.agent,
  );

  console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error("\nSMOKE ERROR", error);
  process.exit(1);
}
