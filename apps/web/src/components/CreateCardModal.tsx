import React, { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, X } from "lucide-react";
import { api, ApiError, parseAcceptanceRulesText } from "../api";
import type { AcceptanceRule, Card } from "../types";

type CreateCardModalProps = {
  projectId: string;
  onClose: () => void;
  onCreated: (card: Card) => void;
  docked?: boolean;
  windowed?: boolean;
};

export function CreateCardModal({
  projectId,
  onClose,
  onCreated,
  docked = false,
  windowed = false,
}: CreateCardModalProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<number>(50);
  const [deadlineLocal, setDeadlineLocal] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const parsedCriteria = useMemo(
    () => parseAcceptanceRulesText(criteriaText),
    [criteriaText],
  );

  const createMutation = useMutation({
    mutationFn: (payload: {
      title: string;
      body?: string;
      priority?: number;
      criteria?: AcceptanceRule[];
      deadline_at?: string;
    }) => api.createCard(projectId, payload),
    onSuccess: ({ card }) => {
      void queryClient.invalidateQueries({ queryKey: ["board", projectId] });
      onCreated(card);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError("卡片标题不能为空");
      return;
    }

    if (
      !Number.isFinite(priority) ||
      priority < 0 ||
      priority > 100 ||
      !Number.isInteger(priority)
    ) {
      setFormError("优先级必须为 0 到 100 之间的整数");
      return;
    }

    if (parsedCriteria.errors.length > 0) {
      setFormError(parsedCriteria.errors.join("；"));
      return;
    }

    let deadlineIso: string | undefined;
    if (deadlineLocal.trim()) {
      const parsedDate = new Date(deadlineLocal);
      if (Number.isNaN(parsedDate.getTime())) {
        setFormError("截止时间格式无效");
        return;
      }
      deadlineIso = parsedDate.toISOString();
    }

    createMutation.mutate({
      title: trimmedTitle,
      body: body.trim() ? body.trim() : undefined,
      priority,
      criteria: parsedCriteria.rules.length > 0 ? parsedCriteria.rules : undefined,
      deadline_at: deadlineIso,
    });
  };

  const apiErrMsg =
    createMutation.error instanceof ApiError
      ? `${createMutation.error.message} (${createMutation.error.code})`
      : createMutation.error instanceof Error
        ? createMutation.error.message
        : null;

  const formNode = (
    <form
      className={
        windowed
          ? "window-inner-panel"
          : docked
            ? "dock-content-panel"
            : "panel-card modal-card"
      }
      onSubmit={handleSubmit}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {!windowed && (
        <div className={docked ? "drawer-header" : "panel-header"}>
          <h2 id="create-card-modal-title" className="dock-panel-heading">
            <FilePlus2 size={14} aria-hidden="true" />
            <span>新建协商卡片</span>
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="关闭新建卡片弹窗"
          >
            <X size={13} aria-hidden="true" /> 关闭
          </button>
        </div>
      )}

      <div className={docked || windowed ? "drawer-body" : "panel-body"}>
          {(formError || apiErrMsg) && (
            <div className="alert alert-error" role="alert">
              <strong>提交失败：</strong> {formError || apiErrMsg}
            </div>
          )}

          <div className="form-field">
            <label htmlFor="card-title-input">
              标题 <span className="required-mark">*</span>
            </label>
            <input
              id="card-title-input"
              type="text"
              className="input"
              placeholder="输入清晰的任务目标，例如：生成 Q3 交易对账汇总表"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="form-row-2col">
            <div className="form-field">
              <label htmlFor="card-priority-input">优先级 (0-100)</label>
              <input
                id="card-priority-input"
                type="number"
                className="input input-mono"
                min={0}
                max={100}
                step={1}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>

            <div className="form-field">
              <label htmlFor="card-deadline-input">截止时间 (可选)</label>
              <input
                id="card-deadline-input"
                type="datetime-local"
                className="input input-mono"
                value={deadlineLocal}
                onChange={(e) => setDeadlineLocal(e.target.value)}
              />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="card-body-input">任务详情 (Body)</label>
            <textarea
              id="card-body-input"
              className="textarea"
              rows={4}
              placeholder="描述输入数据源、约束条件、产出物格式说明…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="card-criteria-input">
              验收规则 (每行一条：<code>key op value</code>)
            </label>
            <textarea
              id="card-criteria-input"
              className="textarea input-mono"
              rows={4}
              placeholder={"row_count eq 30000\nerror_rate lte 0.01\nreport_url exists"}
              value={criteriaText}
              onChange={(e) => setCriteriaText(e.target.value)}
            />
            <span className="field-hint">
              支持操作符：<code>eq</code>、<code>gte</code>、<code>lte</code>、
              <code>matches</code>、<code>exists</code>。已解析{" "}
              <strong>{parsedCriteria.rules.length}</strong> 条规则
              {parsedCriteria.errors.length > 0 && (
                <span className="text-danger">
                  （{parsedCriteria.errors[0]}）
                </span>
              )}
            </span>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={createMutation.isPending}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "创建中…" : "发布卡片"}
            </button>
          </div>
        </div>
      </form>
  );

  if (docked || windowed) {
    return formNode;
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-card-modal-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {formNode}
    </div>
  );
}
