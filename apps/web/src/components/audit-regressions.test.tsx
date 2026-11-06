// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { I18nProvider } from "../i18n";
import { App } from "../App";
import type { Card, Project, ProjectMember, UserProfile } from "../types";
import { CardDrawer } from "./CardDrawer";
import { ProjectParticipantsPanel } from "./ProjectParticipantsPanel";
import { SetupWizard } from "./SetupWizard";
import { AdminPanel } from "./AdminPanel";

const clients: QueryClient[] = [];
const admin: UserProfile = { id: "usr_admin", email: "admin@example.com", display_name: null, role: "admin" };
const card: Card = { id: "c_test", project_id: "prj_test", title: "Original title", body: "Original body", status: "open", outcome: null, version: 1, round: 1, priority: 10, criteria_json: "[]", assignee_agent_id: null, requester_agent_id: null, deadline_at: null, created_at: "2026-11-04T00:00:00.000Z", updated_at: "2026-11-04T00:00:00.000Z" };
const project: Project = { id: "prj_test", slug: "alpha", name: "Alpha", role: "owner", verification_mode: "human", exec_targets_json: "[]", created_at: card.created_at };
function mount(ui: React.ReactElement, client?: QueryClient) {
  const queries = client ?? new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, gcTime: 0 } } });
  clients.push(queries);
  return { ...render(<QueryClientProvider client={queries}><I18nProvider>{ui}</I18nProvider></QueryClientProvider>), client: queries };
}
beforeEach(() => {
  localStorage.setItem("boardroom.locale", "zh");
  vi.stubGlobal("EventSource", class { close() {} });
  vi.spyOn(api, "getCardNegotiation").mockResolvedValue({ session: null, proposals: [], contract: null, attempts: [], evidence: [] });
});
afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
function completeWizard(container: HTMLElement) {
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  fireEvent.change(container.querySelector("input[type=email]")!, { target: { value: admin.email } });
  container.querySelectorAll("input[type=password]").forEach((input) => fireEvent.change(input, { target: { value: "long-password-123" } }));
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: "Alpha" } });
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
}

describe("audit UI contracts", () => {
  it("shows the admin action panel to a project owner who is not an instance admin", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    client.setQueryData(["card", card.id], { card, events: [] });
    vi.spyOn(api, "getProjectAgents").mockResolvedValue({ agents: [] });
    const owner: UserProfile = { ...admin, id: "usr_owner", email: "owner@example.com", role: "member" };
    mount(
      <CardDrawer
        cardId={card.id}
        projectId={project.id}
        projectRole="owner"
        agentNameMap={new Map()}
        currentUser={owner}
        onClose={vi.fn()}
      />,
      client,
    );
    expect(await screen.findByText("管理员操作")).toBeTruthy();
    expect(screen.getByText("项目级")).toBeTruthy();
  });

  it("shows the admin action panel to a project admin who is not an instance admin", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    client.setQueryData(["card", card.id], { card, events: [] });
    vi.spyOn(api, "getProjectAgents").mockResolvedValue({ agents: [] });
    const projectAdmin: UserProfile = { ...admin, id: "usr_padmin", email: "padmin@example.com", role: "member" };
    mount(
      <CardDrawer
        cardId={card.id}
        projectId={project.id}
        projectRole="admin"
        agentNameMap={new Map()}
        currentUser={projectAdmin}
        onClose={vi.fn()}
      />,
      client,
    );
    expect(await screen.findByText("管理员操作")).toBeTruthy();
    expect(screen.getByText("项目级")).toBeTruthy();
  });

  it("lets the project owner change a member's project permissions", async () => {
    const members: ProjectMember[] = [
      { id: "usr_owner", email: "owner@example.com", display_name: null, global_role: "member", global_status: "active", role: "owner", added_at: card.created_at },
      { id: "usr_member", email: "member@example.com", display_name: null, global_role: "member", global_status: "active", role: "member", added_at: card.created_at },
    ];
    vi.spyOn(api, "getProjectJoinRequests").mockResolvedValue({ join_requests: [] });
    const update = vi.spyOn(api, "updateProjectMemberRole").mockResolvedValue({ member: { ...members[1], role: "admin" } });
    mount(
      <ProjectParticipantsPanel
        projectId={project.id}
        currentUserId="usr_owner"
        canManage
        members={members}
        membersLoading={false}
        membersError={null}
        agents={[]}
        agentsLoading={false}
        agentsError={null}
        onRefreshMembers={vi.fn()}
        onRefreshAgents={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const select = await screen.findByLabelText("修改权限");
    fireEvent.change(select, { target: { value: "admin" } });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(project.id, "usr_member", "admin"),
    );
  });

  it("keeps the edit version frozen when a newer card snapshot arrives", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    client.setQueryData(["card", card.id], { card, events: [] });
    vi.spyOn(api, "getCardDetail").mockResolvedValue({ card: { ...card, version: 2 }, events: [] });
    const patch = vi.spyOn(api, "patchCard").mockRejectedValue(new ApiError({ status: 409, code: "VERSION_CONFLICT", message: "changed" }));
    mount(<CardDrawer cardId={card.id} projectId={project.id} agentNameMap={new Map()} currentUser={admin} onClose={vi.fn()} />, client);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "My draft" } });
    await act(async () => { client.setQueryData(["card", card.id], { card: { ...card, title: "Their edit", version: 2 }, events: [] }); });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(card.id, 1, expect.objectContaining({ title: "My draft" })));
    expect(screen.getByText(/编辑期间卡片已有更新/)).toBeTruthy();
  });

  it("acknowledges a saved edit whose event is still pending without offering a retry", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    client.setQueryData(["card", card.id], { card, events: [] });
    vi.spyOn(api, "getCardDetail").mockResolvedValue({ card: { ...card, version: 2 }, events: [] });
    const patch = vi.spyOn(api, "patchCard").mockResolvedValue({ card: { ...card, version: 2 }, seq: null, event_pending: true, event_id: "event_pending" });
    mount(<CardDrawer cardId={card.id} projectId={project.id} agentNameMap={new Map()} currentUser={admin} onClose={vi.fn()} />, client);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    const notice = await screen.findByText("已保存，事件同步中；无需重复提交。");
    expect(notice.closest(".alert")?.className).toContain("alert-warning");
    expect(patch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "保存修改" })).toBeNull();
  });

  it("preserves a 202 publication receipt as a successful API result", async () => {
    const receipt = { card, seq: null, event_pending: true, event_id: "event_pending" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(receipt), { status: 202 })));
    await expect(api.closeCard(card.id, card.version, "cancel this card")).resolves.toEqual(receipt);
  });

  it("requires explicit submission after navigating to setup review", async () => {
    const setup = vi.spyOn(api, "setup").mockResolvedValue({ user: admin, instance_name: "Boardroom", project, enrollment_token: "kbe1.prj_test.setup-test" });
    const done = vi.fn(); const { container } = mount(<SetupWizard onComplete={done} />);
    completeWizard(container);
    expect(setup).not.toHaveBeenCalled();
    fireEvent.submit(container.querySelector("form")!);
    expect(await screen.findByText("kbe1.prj_test.setup-test")).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
  });

  it("retains the setup token across setup status refresh without starting the board", async () => {
    const status = vi.spyOn(api, "getSetupStatus").mockResolvedValue({ needs_setup: true, instance_name: "Boardroom", auth_mode: "session" });
    const me = vi.spyOn(api, "getMe").mockResolvedValue({ user: admin, projects: [] });
    vi.spyOn(api, "getProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(api, "setup").mockResolvedValue({ user: admin, instance_name: "Boardroom", project, enrollment_token: "kbe1.prj_test.reconnect-test" });
    const { container, client } = mount(<App />);
    await screen.findByText("配置 Boardroom 实例");
    completeWizard(container); fireEvent.submit(container.querySelector("form")!);
    await screen.findByText("kbe1.prj_test.reconnect-test");
    status.mockResolvedValue({ needs_setup: false, instance_name: "Boardroom", auth_mode: "session" });
    await act(async () => { await client.refetchQueries({ queryKey: ["setupStatus"] }); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByText("kbe1.prj_test.reconnect-test")).toBeTruthy();
    expect(me).not.toHaveBeenCalled();
  });

  it("keeps a rotated project token visible when a project refresh unmounts its issuing panel", async () => {
    vi.spyOn(api, "getSetupStatus").mockResolvedValue({ needs_setup: false, instance_name: "Boardroom", auth_mode: "session" });
    vi.spyOn(api, "getMe").mockResolvedValue({ user: admin, projects: [project] });
    vi.spyOn(api, "getProjects").mockResolvedValue({ projects: [project] });
    vi.spyOn(api, "getBoard").mockResolvedValue({ seq: 0, project, columns: { open: [], engaged: [], running: [], review: [], closed: [] } });
    vi.spyOn(api, "getProjectAgents").mockResolvedValue({ agents: [] });
    vi.spyOn(api, "getProjectMembers").mockResolvedValue({ members: [] });
    vi.spyOn(api, "createProjectToken").mockResolvedValue({ enrollment_token: "kbe1.prj_test.rotated-test", expires_in_days: 90 });
    const { client } = mount(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "协作 Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: /生成.*令牌/ }));
    await waitFor(() => expect(api.createProjectToken).toHaveBeenCalledTimes(1));
    await screen.findByText("注册令牌已更新：Alpha");
    await screen.findByRole("dialog", { name: "注册令牌已更新：Alpha" });
    await act(async () => { client.setQueryData(["projects"], { projects: [] }); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByText("kbe1.prj_test.rotated-test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "已保存令牌" })).toBeTruthy();
  });

  it("shows a retry action when setup status is unavailable", async () => {
    const status = vi.spyOn(api, "getSetupStatus").mockRejectedValue(new Error("temporarily unavailable"));
    const me = vi.spyOn(api, "getMe"); mount(<App />);
    await screen.findByText("无法加载初始化状态，请重试。");
    expect(me).not.toHaveBeenCalled();
    status.mockResolvedValue({ needs_setup: true, instance_name: "Boardroom", auth_mode: "session" });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("配置 Boardroom 实例"); expect(status).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a saved password reset from failed email delivery", async () => {
    const user = { id: "usr_target", email: "target@example.com", display_name: null, role: "member", status: "active" as const };
    vi.spyOn(api, "getAdminOverview").mockResolvedValue({ users: 1, active_users: 1, projects: 1, cards: 0, active_sessions: 0 });
    vi.spyOn(api, "getUsers").mockResolvedValue({ users: [user] });
    vi.spyOn(api, "getAdminEmailStatus").mockResolvedValue({ configured: false, provider: "disabled", from: null, host: null, port: null, secure: null });
    vi.spyOn(api, "getAdminEmailLog").mockResolvedValue({ emails: [] });
    vi.spyOn(api, "resetUserPassword").mockResolvedValue({ ok: true, user, email: { ok: false, provider: "smtp", status: "failed", error: "SMTP unavailable" } });
    const { container } = mount(<AdminPanel currentUser={admin} />);
    fireEvent.click(screen.getByRole("tab", { name: /用户与权限/ }));
    fireEvent.click(await screen.findByRole("button", { name: "重置密码" }));
    fireEvent.change(container.querySelector("input[type=password]")!, { target: { value: "new-password-123" } });
    fireEvent.click(screen.getByLabelText("发送邮件通知")); fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await screen.findByText(/但邮件投递失败：SMTP unavailable/);
  });

  it.each(["", "not-json", "null", "42", "{}", "[]", '{"needs_setup":"false"}'])("rejects an invalid successful setup status: %s", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    await expect(api.getSetupStatus()).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 200 });
  });
});
