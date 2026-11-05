import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Ban,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shield,
  UserCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";
import type { UserProfile } from "../types";
import { formatDateTime } from "./statusMeta";

type AdminPanelProps = {
  currentUser: UserProfile;
  onClose?: () => void;
};

type AdminSectionTab = "overview" | "users" | "email";

export function AdminPanel({
  currentUser,
  onClose,
}: AdminPanelProps): React.ReactElement {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [sectionTab, setSectionTab] = useState<AdminSectionTab>("overview");

  // Users filter state
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<"" | "admin" | "member">("");
  const [userStatusFilter, setUserStatusFilter] = useState<"" | "active" | "disabled">("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // Create / Invite user form state
  const [userFormMode, setUserFormMode] = useState<"none" | "invite" | "create">("none");
  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<"member" | "admin">("member");
  const [newPassword, setNewPassword] = useState("");
  const [sendInviteMail, setSendInviteMail] = useState(true);

  // Reset password state
  const [resetTargetId, setResetTargetId] = useState<string | null>(null);
  const [resetPasswordVal, setResetPasswordVal] = useState("");
  const [resetMustChange, setResetMustChange] = useState(true);
  const [resetSendEmail, setResetSendEmail] = useState(false);

  // Temp password banner
  const [tempPasswordResult, setTempPasswordResult] = useState<{
    email: string;
    password: string;
    emailSent?: boolean;
  } | null>(null);
  const [copiedTempPwd, setCopiedTempPwd] = useState(false);

  // Email log & test state
  const [emailLogStatusFilter, setEmailLogStatusFilter] = useState<
    "" | "sent" | "failed" | "skipped"
  >("");
  const [testEmailTo, setTestEmailTo] = useState(currentUser.email);

  const [banner, setBanner] = useState<{
    type: "success" | "error" | "warning";
    text: string;
  } | null>(null);

  const overviewQuery = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => api.getAdminOverview(),
  });

  const usersQuery = useQuery({
    queryKey: ["admin", "users", userStatusFilter, userRoleFilter, userSearch],
    queryFn: () =>
      api.getUsers({
        ...(userStatusFilter ? { status: userStatusFilter } : {}),
        ...(userRoleFilter ? { role: userRoleFilter } : {}),
        ...(userSearch.trim() ? { q: userSearch.trim() } : {}),
      }),
  });

  const userDetailQuery = useQuery({
    queryKey: ["admin", "userDetail", selectedUserId],
    queryFn: () => api.getUserDetail(selectedUserId!),
    enabled: Boolean(selectedUserId),
  });

  const emailStatusQuery = useQuery({
    queryKey: ["admin", "emailStatus"],
    queryFn: () => api.getAdminEmailStatus(),
  });

  const emailLogQuery = useQuery({
    queryKey: ["admin", "emailLog", emailLogStatusFilter],
    queryFn: () =>
      api.getAdminEmailLog({
        ...(emailLogStatusFilter ? { status: emailLogStatusFilter } : {}),
        limit: 100,
      }),
  });

  const refreshAllAdmin = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  const handleApiError = (err: unknown) => {
    if (err instanceof ApiError) {
      setBanner({ type: "error", text: `${err.message} [${err.code}]` });
    } else if (err instanceof Error) {
      setBanner({ type: "error", text: err.message });
    } else {
      setBanner({ type: "error", text: "操作失败" });
    }
  };

  const createUserMutation = useMutation({
    mutationFn: () =>
      api.createUser({
        email: newEmail.trim(),
        display_name: newDisplayName.trim() || undefined,
        password: newPassword,
        role: newRole,
      }),
    onSuccess: ({ user }) => {
      setUserFormMode("none");
      setNewEmail("");
      setNewDisplayName("");
      setNewPassword("");
      setBanner({ type: "success", text: `已创建用户 ${user.email}` });
      refreshAllAdmin();
    },
    onError: handleApiError,
  });

  const inviteUserMutation = useMutation({
    mutationFn: () =>
      api.inviteUser({
        email: newEmail.trim(),
        display_name: newDisplayName.trim() || undefined,
        role: newRole,
        send_email: sendInviteMail,
      }),
    onSuccess: (res) => {
      setUserFormMode("none");
      setNewEmail("");
      setNewDisplayName("");
      setTempPasswordResult({
        email: res.user.email,
        password: res.temporary_password,
        emailSent: res.email?.ok,
      });
      setBanner({
        type: "success",
        text: `已生成邀请账号 ${res.user.email}`,
      });
      refreshAllAdmin();
    },
    onError: handleApiError,
  });

  const resendInviteMutation = useMutation({
    mutationFn: (uid: string) => api.resendUserInvite(uid),
    onSuccess: (res) => {
      setTempPasswordResult({
        email: res.user.email,
        password: res.temporary_password,
        emailSent: res.email.ok,
      });
      setBanner({
        type: "success",
        text: `已重置并重发邀请给 ${res.user.email}`,
      });
      refreshAllAdmin();
    },
    onError: handleApiError,
  });

  const updateUserMutation = useMutation({
    mutationFn: ({
      uid,
      patch,
    }: {
      uid: string;
      patch: {
        display_name?: string | null;
        role?: "admin" | "member";
        status?: "active" | "disabled";
      };
    }) => api.updateUser(uid, patch),
    onSuccess: ({ user }) => {
      setBanner({
        type: "success",
        text: `已更新用户 ${user.email} (${user.role} / ${user.status})`,
      });
      refreshAllAdmin();
    },
    onError: handleApiError,
  });

  const revokeSessionsMutation = useMutation({
    mutationFn: (uid: string) => api.revokeUserSessions(uid),
    onSuccess: () => {
      setBanner({ type: "success", text: "已撤销该用户的全部活跃会话" });
      refreshAllAdmin();
    },
    onError: handleApiError,
  });

  const resetPasswordMutation = useMutation({
    mutationFn: ({
      uid,
      password,
      mustChange,
      sendMail,
    }: {
      uid: string;
      password: string;
      mustChange: boolean;
      sendMail: boolean;
    }) =>
      api.resetUserPassword(uid, {
        password,
        must_change_password: mustChange,
        send_email: sendMail,
      }),
    onSuccess: (res) => {
      setResetTargetId(null);
      setResetPasswordVal("");
      setBanner({
        type: res.email && !res.email.ok ? "error" : "success",
        text: res.email && !res.email.ok
          ? t("admin.passwordResetEmailFailed", { email: res.user.email, error: res.email.error ?? res.email.status })
          : t("admin.passwordResetSuccess", { email: res.user.email }),
      });
      refreshAllAdmin();
    },
    onError: handleApiError,
  });

  const testEmailMutation = useMutation({
    mutationFn: (to?: string) => api.sendAdminTestEmail(to),
    onSuccess: (res) => {
      setBanner({
        type: res.ok ? "success" : "warning",
        text: `测试邮件结果 (${res.provider}): status=${res.status}${
          res.error ? ` · ${res.error}` : ""
        }`,
      });
      void emailLogQuery.refetch();
    },
    onError: handleApiError,
  });

  const copyTempPassword = async (pwd: string) => {
    try {
      await navigator.clipboard.writeText(pwd);
      setCopiedTempPwd(true);
      window.setTimeout(() => setCopiedTempPwd(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <section className="editor-card-fullview admin-console-view" aria-label="管理员面板">
      <header className="drawer-header">
        <div className="drawer-header-meta">
          <span className="dock-panel-heading">
            <Shield size={14} aria-hidden="true" />
            <span>管理员面板 (Admin Console)</span>
          </span>

          <div className="admin-subtabs" role="tablist" aria-label="管理员子模块">
            <button
              type="button"
              role="tab"
              aria-selected={sectionTab === "overview"}
              className={`admin-subtab ${sectionTab === "overview" ? "is-active" : ""}`}
              onClick={() => setSectionTab("overview")}
            >
              <Activity size={12} aria-hidden="true" />
              <span>系统总览</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={sectionTab === "users"}
              className={`admin-subtab ${sectionTab === "users" ? "is-active" : ""}`}
              onClick={() => setSectionTab("users")}
            >
              <Users size={12} aria-hidden="true" />
              <span>用户与权限 ({overviewQuery.data?.users ?? usersQuery.data?.users.length ?? 0})</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={sectionTab === "email"}
              className={`admin-subtab ${sectionTab === "email" ? "is-active" : ""}`}
              onClick={() => setSectionTab("email")}
            >
              <Mail size={12} aria-hidden="true" />
              <span>SMTP 与邮件日志</span>
            </button>
          </div>
        </div>

        <div className="drawer-header-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={refreshAllAdmin}
          >
            <RefreshCw size={12} aria-hidden="true" /> 刷新
          </button>
          {onClose && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
            >
              <X size={13} aria-hidden="true" /> 关闭标签
            </button>
          )}
        </div>
      </header>

      <div className="drawer-body">
        {banner && (
          <div className={`alert alert-${banner.type}`} role="alert">
            <span>{banner.text}</span>
            <button
              type="button"
              className="btn-inline-close"
              onClick={() => setBanner(null)}
              aria-label="关闭提示"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        )}

        {tempPasswordResult && (
          <div className="alert alert-warning" role="region" aria-label="临时密码提示">
            <div>
              <strong>账号 {tempPasswordResult.email} 临时密码（仅显示一次）：</strong>{" "}
              <code>{tempPasswordResult.password}</code>
              {tempPasswordResult.emailSent === false && (
                <span> · 邮件未发送成功，请手动复制交付给用户。</span>
              )}
            </div>
            <div className="drawer-header-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void copyTempPassword(tempPasswordResult.password)}
              >
                {copiedTempPwd ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
                <span>{copiedTempPwd ? "已复制" : "复制密码"}</span>
              </button>
              <button
                type="button"
                className="btn-inline-close"
                onClick={() => setTempPasswordResult(null)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {sectionTab === "overview" && (
          <div className="admin-section-stack">
            <h3 className="section-title">实例全局统计 (/api/v1/admin/overview)</h3>
            <div className="admin-metrics-grid">
              <div className="admin-metric-card">
                <span className="meta-label">总注册用户</span>
                <strong className="admin-metric-num">
                  {overviewQuery.data?.users ?? "—"}
                </strong>
              </div>
              <div className="admin-metric-card">
                <span className="meta-label">启用中用户</span>
                <strong className="admin-metric-num">
                  {overviewQuery.data?.active_users ?? "—"}
                </strong>
              </div>
              <div className="admin-metric-card">
                <span className="meta-label">活跃项目数</span>
                <strong className="admin-metric-num">
                  {overviewQuery.data?.projects ?? "—"}
                </strong>
              </div>
              <div className="admin-metric-card">
                <span className="meta-label">累计协商卡片</span>
                <strong className="admin-metric-num">
                  {overviewQuery.data?.cards ?? "—"}
                </strong>
              </div>
              <div className="admin-metric-card">
                <span className="meta-label">当前活跃会话</span>
                <strong className="admin-metric-num">
                  {overviewQuery.data?.active_sessions ?? "—"}
                </strong>
              </div>
            </div>

            <div className="drawer-section">
              <h3 className="section-title">邮件服务状态 (/api/v1/admin/email/status)</h3>
              <div className="meta-grid">
                <div className="meta-item">
                  <span className="meta-label">Provider</span>
                  <span className="meta-value">
                    <code>{emailStatusQuery.data?.provider ?? "—"}</code>
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Configured</span>
                  <span className="meta-value">
                    {emailStatusQuery.data?.configured ? "已配置" : "未配置 (开发回退/禁用)"}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">From</span>
                  <span className="meta-value">
                    <code>{emailStatusQuery.data?.from ?? "—"}</code>
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {sectionTab === "users" && (
          <div className="admin-section-stack">
            <div className="admin-toolbar">
              <div className="admin-filter-group">
                <div className="admin-search-box">
                  <Search size={13} aria-hidden="true" />
                  <input
                    type="search"
                    className="input input-sm"
                    placeholder="搜索邮箱或显示名…"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                  />
                </div>

                <select
                  className="select locale-select"
                  value={userRoleFilter}
                  onChange={(e) =>
                    setUserRoleFilter(e.target.value as "" | "admin" | "member")
                  }
                >
                  <option value="">全部角色</option>
                  <option value="admin">admin</option>
                  <option value="member">member</option>
                </select>

                <select
                  className="select locale-select"
                  value={userStatusFilter}
                  onChange={(e) =>
                    setUserStatusFilter(e.target.value as "" | "active" | "disabled")
                  }
                >
                  <option value="">全部状态</option>
                  <option value="active">active</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>

              <div className="drawer-header-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    setUserFormMode((m) => (m === "invite" ? "none" : "invite"))
                  }
                >
                  <UserPlus size={12} aria-hidden="true" /> 邀请用户 (生成临时密码)
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    setUserFormMode((m) => (m === "create" ? "none" : "create"))
                  }
                >
                  <Plus size={12} aria-hidden="true" /> 直接创建用户
                </button>
              </div>
            </div>

            {userFormMode !== "none" && (
              <form
                className="drawer-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (userFormMode === "invite") {
                    inviteUserMutation.mutate();
                  } else {
                    createUserMutation.mutate();
                  }
                }}
              >
                <div className="section-subtitle">
                  {userFormMode === "invite"
                    ? "邀请新用户 (POST /api/v1/users/invite)"
                    : "直接创建用户 (POST /api/v1/users)"}
                </div>

                <div className="form-row-2col">
                  <div className="form-field">
                    <label>邮箱 *</label>
                    <input
                      type="email"
                      className="input"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-field">
                    <label>显示名称</label>
                    <input
                      type="text"
                      className="input"
                      value={newDisplayName}
                      onChange={(e) => setNewDisplayName(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-row-2col">
                  <div className="form-field">
                    <label>角色</label>
                    <select
                      className="select"
                      style={{ width: "100%" }}
                      value={newRole}
                      onChange={(e) =>
                        setNewRole(e.target.value as "member" | "admin")
                      }
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </div>

                  {userFormMode === "create" ? (
                    <div className="form-field">
                      <label>初始密码 (至少 10 位) *</label>
                      <input
                        type="password"
                        className="input"
                        minLength={10}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        required
                      />
                    </div>
                  ) : (
                    <div className="form-field" style={{ justifyContent: "flex-end" }}>
                      <label className="setup-checkbox">
                        <input
                          type="checkbox"
                          checked={sendInviteMail}
                          onChange={(e) => setSendInviteMail(e.target.checked)}
                        />
                        <span>同时发送邀请邮件</span>
                      </label>
                    </div>
                  )}
                </div>

                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setUserFormMode("none")}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={
                      createUserMutation.isPending || inviteUserMutation.isPending
                    }
                  >
                    {userFormMode === "invite" ? "发送邀请并生成密码" : "创建用户"}
                  </button>
                </div>
              </form>
            )}

            {usersQuery.isLoading ? (
              <div className="loading-state">正在加载用户列表…</div>
            ) : (
              <table className="rules-table">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>最后活跃</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(usersQuery.data?.users ?? []).map((u) => {
                    const isSelf = u.id === currentUser.id;
                    const isSelected = selectedUserId === u.id;
                    return (
                      <tr key={u.id}>
                        <td>
                          <div>
                            <strong>{u.display_name || u.email}</strong>
                            {isSelf && (
                              <span className="badge badge-neutral" style={{ marginLeft: 6 }}>
                                当前账号
                              </span>
                            )}
                          </div>
                          <div className="field-hint">
                            <code>{u.email}</code> · <code>{u.id}</code>
                          </div>
                        </td>
                        <td>
                          <select
                            className="select locale-select"
                            value={u.role}
                            onChange={(e) =>
                              updateUserMutation.mutate({
                                uid: u.id,
                                patch: {
                                  role: e.target.value as "admin" | "member",
                                },
                              })
                            }
                          >
                            <option value="member">member</option>
                            <option value="admin">admin</option>
                          </select>
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              u.status === "disabled"
                                ? "badge-agent-disabled"
                                : "badge-agent-active"
                            }`}
                          >
                            {u.status === "disabled" ? (
                              <Ban size={11} aria-hidden="true" />
                            ) : (
                              <CheckCircle2 size={11} aria-hidden="true" />
                            )}
                            {u.status ?? "active"}
                          </span>
                        </td>
                        <td>
                          <code>{formatDateTime(u.last_seen_at)}</code>
                        </td>
                        <td>
                          <div className="drawer-header-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() =>
                                setSelectedUserId(isSelected ? null : u.id)
                              }
                            >
                              {isSelected ? "收起详情" : "详情/审计"}
                            </button>

                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() =>
                                setResetTargetId(
                                  resetTargetId === u.id ? null : u.id,
                                )
                              }
                            >
                              <KeyRound size={11} aria-hidden="true" /> 重置密码
                            </button>

                            {u.status !== "disabled" && (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => resendInviteMutation.mutate(u.id)}
                                disabled={resendInviteMutation.isPending}
                              >
                                <Send size={11} aria-hidden="true" /> 重发邀请
                              </button>
                            )}

                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => revokeSessionsMutation.mutate(u.id)}
                              disabled={revokeSessionsMutation.isPending}
                            >
                              <LogOut size={11} aria-hidden="true" /> 撤销会话
                            </button>

                            {!isSelf && (
                              <button
                                type="button"
                                className={`btn btn-sm ${
                                  u.status === "disabled"
                                    ? "btn-primary"
                                    : "btn-danger"
                                }`}
                                onClick={() =>
                                  updateUserMutation.mutate({
                                    uid: u.id,
                                    patch: {
                                      status:
                                        u.status === "disabled"
                                          ? "active"
                                          : "disabled",
                                    },
                                  })
                                }
                              >
                                {u.status === "disabled" ? (
                                  <>
                                    <UserCheck size={11} aria-hidden="true" /> 启用
                                  </>
                                ) : (
                                  <>
                                    <Ban size={11} aria-hidden="true" /> 禁用
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {resetTargetId && (
              <form
                className="drawer-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  resetPasswordMutation.mutate({
                    uid: resetTargetId,
                    password: resetPasswordVal,
                    mustChange: resetMustChange,
                    sendMail: resetSendEmail,
                  });
                }}
              >
                <div className="section-subtitle">
                  <KeyRound size={13} aria-hidden="true" />
                  <span>重置用户密码 (POST /api/v1/users/{resetTargetId}/password)</span>
                </div>
                <div className="form-field">
                  <label>新密码 (至少 10 个字符)</label>
                  <input
                    type="password"
                    className="input"
                    minLength={10}
                    value={resetPasswordVal}
                    onChange={(e) => setResetPasswordVal(e.target.value)}
                    required
                  />
                </div>
                <div className="drawer-header-actions">
                  <label className="setup-checkbox">
                    <input
                      type="checkbox"
                      checked={resetMustChange}
                      onChange={(e) => setResetMustChange(e.target.checked)}
                    />
                    <span>下次登录强制修改密码</span>
                  </label>
                  <label className="setup-checkbox">
                    <input
                      type="checkbox"
                      checked={resetSendEmail}
                      onChange={(e) => setResetSendEmail(e.target.checked)}
                    />
                    <span>发送邮件通知</span>
                  </label>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setResetTargetId(null)}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={resetPasswordMutation.isPending}
                  >
                    确认重置
                  </button>
                </div>
              </form>
            )}

            {selectedUserId && userDetailQuery.data && (
              <div className="drawer-inline-form">
                <div className="drawer-header">
                  <span className="section-subtitle">
                    用户详情与认证事件 ({userDetailQuery.data.user.email} · 活跃会话:{" "}
                    {userDetailQuery.data.active_sessions})
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setSelectedUserId(null)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
                <ol className="timeline-list">
                  {userDetailQuery.data.auth_events.map((ev, i) => (
                    <li key={`${ev.created_at}-${i}`} className="timeline-item">
                      <div className="timeline-item-header">
                        <span className="timeline-type">{ev.event_type}</span>
                        {ev.ip_hash && (
                          <span className="timeline-actor">
                            IP: <code>{ev.ip_hash.slice(0, 12)}</code>
                          </span>
                        )}
                        <time className="timeline-time">
                          {formatDateTime(ev.created_at)}
                        </time>
                      </div>
                      {ev.user_agent && (
                        <div className="timeline-payload">
                          <code>{ev.user_agent}</code>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {sectionTab === "email" && (
          <div className="admin-section-stack">
            <div className="drawer-inline-form">
              <div className="section-subtitle">
                <Mail size={13} aria-hidden="true" />
                <span>SMTP 配置状态与测试发送</span>
              </div>
              <div className="meta-grid">
                <div className="meta-item">
                  <span className="meta-label">Provider</span>
                  <span className="meta-value">
                    <code>{emailStatusQuery.data?.provider ?? "—"}</code>
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Host / Port / Secure</span>
                  <span className="meta-value">
                    <code>
                      {emailStatusQuery.data?.host ?? "—"}:
                      {emailStatusQuery.data?.port ?? "—"} (
                      {emailStatusQuery.data?.secure ?? "—"})
                    </code>
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">From</span>
                  <span className="meta-value">
                    <code>{emailStatusQuery.data?.from ?? "—"}</code>
                  </span>
                </div>
              </div>

              <form
                className="admin-toolbar"
                onSubmit={(e) => {
                  e.preventDefault();
                  testEmailMutation.mutate(testEmailTo);
                }}
              >
                <input
                  type="email"
                  className="input input-sm"
                  style={{ maxWidth: 280 }}
                  placeholder="接收测试邮件的邮箱…"
                  value={testEmailTo}
                  onChange={(e) => setTestEmailTo(e.target.value)}
                  required
                />
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={testEmailMutation.isPending}
                >
                  <Send size={12} aria-hidden="true" />{" "}
                  {testEmailMutation.isPending ? "发送中…" : "发送测试邮件"}
                </button>
              </form>
            </div>

            <div className="admin-toolbar">
              <h3 className="section-title">最近邮件发送日志 (/api/v1/admin/email/log)</h3>
              <select
                className="select locale-select"
                value={emailLogStatusFilter}
                onChange={(e) =>
                  setEmailLogStatusFilter(
                    e.target.value as "" | "sent" | "failed" | "skipped",
                  )
                }
              >
                <option value="">全部状态</option>
                <option value="sent">sent</option>
                <option value="skipped">skipped</option>
                <option value="failed">failed</option>
              </select>
            </div>

            {emailLogQuery.isLoading ? (
              <div className="loading-state">正在加载邮件日志…</div>
            ) : (emailLogQuery.data?.emails ?? []).length === 0 ? (
              <div className="empty-inline">暂无邮件发送记录</div>
            ) : (
              <table className="rules-table">
                <thead>
                  <tr>
                    <th>收件人</th>
                    <th>主题</th>
                    <th>Provider</th>
                    <th>状态</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {(emailLogQuery.data?.emails ?? []).map((item) => (
                    <tr key={item.id}>
                      <td>
                        <code>{item.to_email}</code>
                      </td>
                      <td>
                        <div>{item.subject}</div>
                        {item.error && (
                          <div className="text-danger">{item.error}</div>
                        )}
                      </td>
                      <td>
                        <code>{item.provider}</code>
                      </td>
                      <td>
                        <span className="badge badge-neutral">{item.status}</span>
                      </td>
                      <td>
                        <code>{formatDateTime(item.created_at)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
