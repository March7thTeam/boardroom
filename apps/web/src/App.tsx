import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, sortCardsForColumn } from "./api";
import { useBoardEvents } from "./hooks/useBoardEvents";
import { useI18n, type Locale } from "./i18n";
import type { Card, CardStatus, Project, ProjectSummary, SetupResponse, UserProfile } from "./types";
import {
  getBoardColumnsMeta,
  getConnectionMeta,
} from "./components/statusMeta";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  FilePlus2,
  FolderKanban,
  FolderPlus,
  Archive,
  ExternalLink,
  Layers,
  LayoutGrid,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Sun,
  Terminal,
  User,
  Users,
  X,
} from "lucide-react";
import { AdminPanel } from "./components/AdminPanel";
import { CreateProjectView } from "./components/CreateProjectModal";
import { CreateCardModal } from "./components/CreateCardModal";
import { CardTile } from "./components/CardTile";
import { CardDrawer } from "./components/CardDrawer";
import { AgentsModal } from "./components/AgentsModal";
import { ProjectParticipantsPanel } from "./components/ProjectParticipantsPanel";
import { InstanceRoleBadge, ProjectRoleBadge } from "./components/RoleBadges";
import { ArchivedProjectsPanel } from "./components/ArchivedProjectsPanel";
import { FloatingWindow } from "./components/FloatingWindow";
import { ProjectTokenNotice } from "./components/ProjectTokenNotice";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { ConnectionIcon, StatusIcon } from "./components/Icons";
import { LoginPage } from "./components/LoginPage";
import { ChangePasswordPage } from "./components/ChangePasswordPage";
import { SetupWizard } from "./components/SetupWizard";

const THEME_STORAGE_KEY = "boardroom.theme";
const PROJECT_STORAGE_KEY = "boardroom.lastProject";

function readStoredProject(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

type LeftDockKey = "projects" | "views" | "agents" | "participants" | "settings" | null;
type CrumbMenuKey = "projects" | "views" | null;
type DialogWindowKey =
  | "newCard"
  | "newProject"
  | "agents"
  | "projectSettings"
  | "admin"
  | `card:${string}`;

function BoardApp({ user }: { user: UserProfile }): React.ReactElement {
  const queryClient = useQueryClient();
  const { t, locale, setLocale, locales, labels } = useI18n();

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>(["board"]);
  const [activeTabId, setActiveTabId] = useState<"board" | "admin" | string>("board");
  const [statusFilter, setStatusFilter] = useState<"all" | CardStatus>("all");

  const [leftDock, setLeftDock] = useState<LeftDockKey>(null);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [bottomDockOpen, setBottomDockOpen] = useState(false);
  const [openWindows, setOpenWindows] = useState<DialogWindowKey[]>([]);
  const [windowSpawnPos, setWindowSpawnPos] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [tabDragUi, setTabDragUi] = useState<{
    tabId: string;
    overTabId: string | null;
    insertPos: "before" | "after";
    isDetaching: boolean;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [windowDockHover, setWindowDockHover] = useState<{
    tabId: string;
    overTabId: string | null;
    insertPos: "before" | "after";
  } | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const suppressTabClickRef = useRef(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [promptCopying, setPromptCopying] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  // Enrollment tokens returned by the API are only available once; keep the
  // in-session copy so the onboarding prompt can embed the real token.
  const [projectTokens, setProjectTokens] = useState<Record<string, string>>({});
  const [tokenNotice, setTokenNotice] = useState<{
    project: Pick<ProjectSummary, "id" | "name" | "slug">;
    token: string;
    kind: "created" | "rotated";
  } | null>(null);
  const [crumbMenu, setCrumbMenu] = useState<CrumbMenuKey>(null);
  const breadcrumbsRef = useRef<HTMLDivElement | null>(null);

  const selectedCardId =
    activeTabId === "board" ||
    activeTabId === "admin" ||
    activeTabId === "projectSettings"
      ? null
      : activeTabId;

  const resetProjectWorkspaceTabs = () => {
    setOpenTabs((prev) => (prev.includes("admin") ? ["board", "admin"] : ["board"]));
    setOpenWindows((prev) =>
      prev.filter((k) => !k.startsWith("card:") && k !== "projectSettings" && k !== "newCard"),
    );
    setActiveTabId("board");
  };

  const openWindow = (key: DialogWindowKey) => {
    setOpenWindows((prev) => [...prev.filter((k) => k !== key), key]);
  };

  const closeWindow = (key: DialogWindowKey) => {
    setOpenWindows((prev) => prev.filter((k) => k !== key));
  };

  const toggleWindow = (key: DialogWindowKey) => {
    setOpenWindows((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const focusWindow = (key: DialogWindowKey) => {
    setOpenWindows((prev) => {
      if (!prev.includes(key) || prev[prev.length - 1] === key) return prev;
      return [...prev.filter((k) => k !== key), key];
    });
  };

  const handleOpenAdminTab = () => {
    if (openWindows.includes("admin")) {
      focusWindow("admin");
      return;
    }
    setOpenTabs((prev) => (prev.includes("admin") ? prev : [...prev, "admin"]));
    setActiveTabId("admin");
  };

  const handleOpenProjectSettingsTab = () => {
    setLeftDock(null);
    if (openWindows.includes("projectSettings")) {
      focusWindow("projectSettings");
      return;
    }
    setOpenTabs((prev) =>
      prev.includes("projectSettings") ? prev : [...prev, "projectSettings"],
    );
    setActiveTabId("projectSettings");
  };

  const handleCloseTab = (tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (tabId === "board") return;
    setOpenTabs((prev) => {
      const idx = prev.indexOf(tabId);
      if (idx === -1) return prev;
      const next = prev.filter((id) => id !== tabId);
      if (activeTabId === tabId) {
        const fallback =
          next[Math.max(0, idx - 1)] ??
          next[0] ??
          "board";
        setActiveTabId(fallback);
      }
      return next;
    });
  };

  const handleCloseAdminTab = (e?: React.MouseEvent) => {
    handleCloseTab("admin", e);
  };

  const handleDetachTab = (
    tabId: string,
    spawnPos?: { x: number; y: number },
    e?: React.MouseEvent,
  ) => {
    e?.stopPropagation();
    if (tabId === "board") return;
    const winKey: DialogWindowKey =
      tabId === "admin"
        ? "admin"
        : tabId === "projectSettings"
          ? "projectSettings"
          : (`card:${tabId}` as const);
    if (spawnPos) {
      setWindowSpawnPos((prev) => ({
        ...prev,
        [winKey]: {
          x: Math.max(24, Math.min(spawnPos.x, window.innerWidth - 380)),
          y: Math.max(44, Math.min(spawnPos.y, window.innerHeight - 280)),
        },
      }));
    }
    handleCloseTab(tabId);
    openWindow(winKey);
  };

  const handleDockWindowToTab = (
    tabId: string,
    targetTabId?: string | null,
    insertPos: "before" | "after" = "after",
  ) => {
    const winKey: DialogWindowKey =
      tabId === "admin"
        ? "admin"
        : tabId === "projectSettings"
          ? "projectSettings"
          : (`card:${tabId}` as const);
    closeWindow(winKey);
    setOpenTabs((prev) => {
      const filtered = prev.filter((id) => id !== tabId);
      if (targetTabId && filtered.includes(targetTabId)) {
        const targetIdx = filtered.indexOf(targetTabId);
        const insertIdx = insertPos === "before" ? targetIdx : targetIdx + 1;
        const next = [...filtered];
        next.splice(insertIdx, 0, tabId);
        return next;
      }
      return [...filtered, tabId];
    });
    setActiveTabId(tabId);
  };

  const handleReorderTab = (
    fromTabId: string,
    toTabId: string,
    insertPos: "before" | "after",
  ) => {
    if (fromTabId === toTabId) return;
    setOpenTabs((prev) => {
      if (!prev.includes(fromTabId) || !prev.includes(toTabId)) return prev;
      const next = prev.filter((id) => id !== fromTabId);
      const targetIdx = next.indexOf(toTabId);
      if (targetIdx === -1) return prev;
      const insertIdx = insertPos === "before" ? targetIdx : targetIdx + 1;
      next.splice(insertIdx, 0, fromTabId);
      return next;
    });
  };

  const inspectTabTargetAtPoint = (
    clientX: number,
    clientY: number,
    excludeTabId?: string,
  ): {
    inDockZone: boolean;
    overTabId: string | null;
    insertPos: "before" | "after";
  } => {
    const stripEl = tabStripRef.current;
    if (!stripEl) {
      return { inDockZone: false, overTabId: null, insertPos: "after" };
    }
    const stripRect = stripEl.getBoundingClientRect();
    const inDockZone =
      clientX >= stripRect.left - 24 &&
      clientX <= stripRect.right + 24 &&
      clientY >= stripRect.top - 28 &&
      clientY <= stripRect.bottom + 36;

    const tabNodes = Array.from(
      stripEl.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );
    let overTabId: string | null = null;
    let insertPos: "before" | "after" = "after";

    for (const node of tabNodes) {
      const id = node.getAttribute("data-tab-id");
      if (!id || id === excludeTabId) continue;
      const r = node.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) {
        overTabId = id;
        insertPos = clientX < r.left + r.width / 2 ? "before" : "after";
        break;
      }
    }

    if (!overTabId && tabNodes.length > 0) {
      const validNodes = tabNodes.filter(
        (n) => n.getAttribute("data-tab-id") !== excludeTabId,
      );
      if (validNodes.length > 0) {
        const firstRect = validNodes[0].getBoundingClientRect();
        const lastRect = validNodes[validNodes.length - 1].getBoundingClientRect();
        if (clientX < firstRect.left) {
          overTabId = validNodes[0].getAttribute("data-tab-id");
          insertPos = "before";
        } else if (clientX > lastRect.right) {
          overTabId = validNodes[validNodes.length - 1].getAttribute("data-tab-id");
          insertPos = "after";
        }
      }
    }

    return { inDockZone, overTabId, insertPos };
  };

  const handleTabPointerDown = (
    tabId: string,
    canDetach: boolean,
    e: React.PointerEvent<HTMLElement>,
  ) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 5) return;
        dragging = true;
        suppressTabClickRef.current = true;
        document.body.style.userSelect = "none";
      }

      const stripEl = tabStripRef.current;
      const stripRect = stripEl?.getBoundingClientRect();
      const verticalOut = stripRect
        ? moveEvent.clientY < stripRect.top - 32 ||
          moveEvent.clientY > stripRect.bottom + 36
        : false;
      const isDetaching = canDetach && verticalOut;
      const target = inspectTabTargetAtPoint(
        moveEvent.clientX,
        moveEvent.clientY,
        tabId,
      );

      setTabDragUi({
        tabId,
        overTabId: isDetaching ? null : target.overTabId,
        insertPos: target.insertPos,
        isDetaching,
        clientX: moveEvent.clientX,
        clientY: moveEvent.clientY,
      });
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (!dragging) return;

      document.body.style.userSelect = "";
      window.setTimeout(() => {
        suppressTabClickRef.current = false;
      }, 0);

      const stripEl = tabStripRef.current;
      const stripRect = stripEl?.getBoundingClientRect();
      const verticalOut = stripRect
        ? upEvent.clientY < stripRect.top - 32 ||
          upEvent.clientY > stripRect.bottom + 36
        : false;
      const isDetaching = canDetach && verticalOut;
      const target = inspectTabTargetAtPoint(
        upEvent.clientX,
        upEvent.clientY,
        tabId,
      );

      setTabDragUi(null);

      if (isDetaching) {
        handleDetachTab(tabId, {
          x: upEvent.clientX - 220,
          y: upEvent.clientY - 18,
        });
      } else if (target.overTabId) {
        handleReorderTab(tabId, target.overTabId, target.insertPos);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const handleProjectCreated = (project: Project, enrollmentToken: string) => {
    setProjectTokens((prev) => ({ ...prev, [project.id]: enrollmentToken }));
    setTokenNotice({ project, token: enrollmentToken, kind: "created" });
  };

  const handleTokenIssued = (projectId: string, token: string) => {
    setProjectTokens((prev) => ({ ...prev, [projectId]: token }));
    const project = projects.find((item) => item.id === projectId) ?? { id: projectId, name: projectId, slug: projectId };
    setTokenNotice({ project, token, kind: "rotated" });
  };

  const handleTokenAcknowledged = () => {
    if (!tokenNotice) return;
    if (tokenNotice.kind === "rotated") {
      setTokenNotice(null);
      return;
    }
    const { project } = tokenNotice;
    const summary: ProjectSummary = {
      id: project.id,
      slug: project.slug,
      name: project.name,
      role: "owner",
    };
    // Insert optimistically so switching to the new project does not race the
    // ["projects"] refetch, which would briefly reset the selected project.
    queryClient.setQueryData<{ projects: ProjectSummary[] }>(["projects"], (old) => {
      if (!old) return { projects: [summary] };
      if (old.projects.some((item) => item.id === summary.id)) return old;
      return { projects: [summary, ...old.projects] };
    });
    setTokenNotice(null);
    setSelectedProjectId(project.id);
    resetProjectWorkspaceTabs();
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  };

  const handleProjectArchived = (projectId: string) => {
    closeWindow("projectSettings");
    handleCloseTab("projectSettings");
    queryClient.setQueryData<{ projects: ProjectSummary[] }>(["projects"], (old) =>
      old ? { projects: old.projects.filter((item) => item.id !== projectId) } : old,
    );
    if (selectedProjectId === projectId) {
      setSelectedProjectId(null);
      resetProjectWorkspaceTabs();
    }
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
    void queryClient.invalidateQueries({ queryKey: ["archivedProjects"] });
  };

  const handleProjectRestored = () => {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
    void queryClient.invalidateQueries({ queryKey: ["archivedProjects"] });
  };

  const handleProjectPurged = () => {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
    void queryClient.invalidateQueries({ queryKey: ["archivedProjects"] });
  };

  useEffect(() => {
    if (!crumbMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        breadcrumbsRef.current &&
        e.target instanceof Node &&
        !breadcrumbsRef.current.contains(e.target)
      ) {
        setCrumbMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCrumbMenu(null);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [crumbMenu]);

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "dark" || saved === "light") return saved;
    } catch {
      // ignore
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.getProjects(),
    // Approved join requests create membership server-side. When the user has
    // no projects yet, poll so the empty-state panel can switch to the board
    // without a manual reload.
    refetchInterval: (query) =>
      (query.state.data?.projects.length ?? 1) === 0 ? 15000 : false,
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/");
    },
  });

  const archivedProjectsQuery = useQuery({
    queryKey: ["archivedProjects"],
    queryFn: () => api.getArchivedProjects(),
    enabled: showArchivedProjects,
  });

  const projects = useMemo(
    () => projectsQuery.data?.projects ?? [],
    [projectsQuery.data?.projects],
  );

  // Auto-select first project when projects load
  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId(null);
      resetProjectWorkspaceTabs();
      return;
    }
    if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) {
      // Reopen the project the viewer used last, falling back to the first one.
      const stored = readStoredProject();
      const remembered = stored && projects.some((p) => p.id === stored) ? stored : null;
      setSelectedProjectId(remembered ?? projects[0].id);
      resetProjectWorkspaceTabs();
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    try {
      window.localStorage.setItem(PROJECT_STORAGE_KEY, selectedProjectId);
    } catch {
      // Storage may be unavailable (private mode); selection still works in-session.
    }
  }, [selectedProjectId]);

  useEffect(() => {
    setPromptError(null);
    setPromptCopied(false);
  }, [selectedProjectId]);

  const boardQuery = useQuery({
    queryKey: ["board", selectedProjectId],
    queryFn: () => api.getBoard(selectedProjectId!),
    enabled: Boolean(selectedProjectId),
  });

  const agentsQuery = useQuery({
    queryKey: ["agents", selectedProjectId],
    queryFn: () => api.getProjectAgents(selectedProjectId!),
    enabled: Boolean(selectedProjectId),
  });

  const membersQuery = useQuery({
    queryKey: ["projectMembers", selectedProjectId],
    queryFn: () => api.getProjectMembers(selectedProjectId!),
    enabled: Boolean(selectedProjectId),
  });

  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agentsQuery.data?.agents ?? []) {
      map.set(agent.id, agent.resolved_name || agent.slug);
    }
    return map;
  }, [agentsQuery.data?.agents]);

  const { status: sseStatus, currentSeq } = useBoardEvents({
    projectId: selectedProjectId,
    locale,
    boardSeq: boardQuery.data?.seq,
    selectedCardId,
  });

  const boardColumnsMeta = useMemo(() => getBoardColumnsMeta(t), [t]);
  const connMeta = getConnectionMeta(sseStatus, t);
  const displaySeq = Math.max(currentSeq, boardQuery.data?.seq ?? 0);

  const selectedCardFallback: Card | null = useMemo(() => {
    if (!selectedCardId || !boardQuery.data?.columns) return null;
    const cols = boardQuery.data.columns;
    const allCards = [
      ...cols.open,
      ...cols.engaged,
      ...cols.running,
      ...cols.review,
      ...cols.closed,
    ];
    return allCards.find((c) => c.id === selectedCardId) ?? null;
  }, [selectedCardId, boardQuery.data?.columns]);

  const allCardsSorted = useMemo(() => {
    if (!boardQuery.data?.columns) return [];
    const cols = boardQuery.data.columns;
    return sortCardsForColumn([
      ...cols.open,
      ...cols.engaged,
      ...cols.running,
      ...cols.review,
      ...cols.closed,
    ]);
  }, [boardQuery.data?.columns]);

  const filteredCards = useMemo(() => {
    if (statusFilter === "all") return allCardsSorted;
    const raw = boardQuery.data?.columns[statusFilter] ?? [];
    return sortCardsForColumn(raw);
  }, [statusFilter, allCardsSorted, boardQuery.data?.columns]);

  const activeFilterMeta = useMemo(() => {
    if (statusFilter === "all") return null;
    return boardColumnsMeta.find((col) => col.key === statusFilter) ?? null;
  }, [statusFilter, boardColumnsMeta]);

  const allCardsMap = useMemo(() => {
    const map = new Map<string, Card>();
    for (const c of allCardsSorted) {
      map.set(c.id, c);
    }
    return map;
  }, [allCardsSorted]);

  const totalCardsCount = allCardsSorted.length;
  const currentProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const canManageArchive =
    user.role === "admin" || projects.some((project) => project.role === "owner");
  const archivedProjects = archivedProjectsQuery.data?.projects ?? [];
  const agentsCount = agentsQuery.data?.agents.length ?? 0;
  const membersCount = membersQuery.data?.members.length ?? 0;
  const participantsCount = agentsCount + membersCount;

  const toggleLeftDock = (key: Exclude<LeftDockKey, null>) => {
    setLeftDock((prev) => (prev === key ? null : key));
  };

  const handleSelectCard = (cardId: string) => {
    const winKey: DialogWindowKey = `card:${cardId}`;
    if (openWindows.includes(winKey)) {
      focusWindow(winKey);
      return;
    }
    setOpenTabs((prev) => (prev.includes(cardId) ? prev : [...prev, cardId]));
    setActiveTabId(cardId);
  };

  const handleCloseCardTab = (cardId: string, e?: React.MouseEvent) => {
    handleCloseTab(cardId, e);
  };

  const handleCopyOnboardingPrompt = async () => {
    if (!selectedProjectId || promptCopying) return;
    setPromptError(null);

    let enrollmentToken = projectTokens[selectedProjectId];
    if (!enrollmentToken) {
      // The token is only returned once per issuance. If this session does not
      // have it (e.g. after a reload), issue a fresh one so the prompt can
      // still hand a usable token to the Agent.
      setPromptCopying(true);
      try {
        const issued = await api.createProjectToken(selectedProjectId);
        enrollmentToken = issued.enrollment_token;
        setProjectTokens((prev) => ({
          ...prev,
          [selectedProjectId]: issued.enrollment_token,
        }));
      } catch (err) {
        setPromptError(
          err instanceof ApiError
            ? `${err.message} (${err.code})`
            : err instanceof Error
              ? err.message
              : "failed to issue enrollment token",
        );
        setPromptCopying(false);
        return;
      }
    }

    const promptText = t("app.promptTemplate", {
      origin: window.location.origin,
      projectName: currentProject?.name ?? "Boardroom",
      projectSlug: currentProject?.slug ?? "project",
      projectId: selectedProjectId,
      enrollmentToken,
    });
    try {
      await navigator.clipboard.writeText(promptText);
    } catch {
      // Fallback for environments where clipboard API is restricted
      const textarea = document.createElement("textarea");
      textarea.value = promptText;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setPromptCopying(false);
    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 2000);
  };

  return (
    <div className="workbench-shell">
      {/* Top Editor Title Bar (Docked Top) */}
      <header className="workbench-titlebar">
        <div className="titlebar-left">
          <div className="brand" title={t("app.brandSubtitle")}>
            <span className="brand-mark" aria-hidden="true">
              <LayoutGrid size={15} />
            </span>
            <span className="brand-title">{t("app.brandTitle")}</span>
          </div>

          {projects.length > 0 && (
            <div className="titlebar-breadcrumbs" ref={breadcrumbsRef}>
              <div className="crumb-dropdown-anchor">
                <button
                  type="button"
                  className={`crumb-btn ${crumbMenu === "projects" ? "is-active" : ""}`}
                  onClick={() =>
                    setCrumbMenu((prev) => (prev === "projects" ? null : "projects"))
                  }
                  aria-haspopup="menu"
                  aria-expanded={crumbMenu === "projects"}
                  title={t("app.projectSelectAria")}
                >
                  <FolderKanban size={13} aria-hidden="true" />
                  <span className="crumb-text">
                    {currentProject?.name ?? t("common.loading")}
                  </span>
                  <ChevronDown size={12} className="crumb-caret" aria-hidden="true" />
                </button>

                {crumbMenu === "projects" && (
                  <div className="crumb-dropdown-menu" role="menu" aria-label={t("app.dockProjects")}>
                    <div className="crumb-menu-list">
                      {projects.map((p) => {
                        const isCurrent = p.id === selectedProjectId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            role="menuitem"
                            className={`crumb-menu-item ${isCurrent ? "is-active" : ""}`}
                            onClick={() => {
                              setSelectedProjectId(p.id);
                              resetProjectWorkspaceTabs();
                              setCrumbMenu(null);
                            }}
                          >
                            <div className="crumb-menu-item-main">
                              <span className="crumb-menu-item-title">{p.name}</span>
                              <code className="crumb-menu-item-code">{p.slug}</code>
                            </div>
                            <div className="crumb-menu-item-right">
                              <ProjectRoleBadge role={p.role} access={p.access} />
                              {isCurrent && <Check size={13} aria-hidden="true" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="crumb-menu-footer">
                      <button
                        type="button"
                        role="menuitem"
                        className="crumb-menu-action"
                        onClick={() => {
                          setCrumbMenu(null);
                          openWindow("newProject");
                        }}
                      >
                        <Plus size={13} aria-hidden="true" />
                        <span>{t("app.newProject").replace(/^\+\s*/, "")}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <span className="crumb-sep" aria-hidden="true">/</span>

              <div className="crumb-dropdown-anchor">
                <button
                  type="button"
                  className={`crumb-btn ${crumbMenu === "views" ? "is-active" : ""}`}
                  onClick={() =>
                    setCrumbMenu((prev) => (prev === "views" ? null : "views"))
                  }
                  aria-haspopup="menu"
                  aria-expanded={crumbMenu === "views"}
                  title={t("app.filterAria")}
                >
                  {activeFilterMeta ? (
                    <StatusIcon
                      status={activeFilterMeta.key}
                      size={13}
                      className={`column-status-icon status-icon-${activeFilterMeta.key}`}
                    />
                  ) : (
                    <Layers size={13} aria-hidden="true" />
                  )}
                  <span className="crumb-text">
                    {activeFilterMeta ? activeFilterMeta.label : t("app.filterAll")}
                  </span>
                  <span className="crumb-badge">{filteredCards.length}</span>
                  <ChevronDown size={12} className="crumb-caret" aria-hidden="true" />
                </button>

                {crumbMenu === "views" && (
                  <div className="crumb-dropdown-menu" role="menu" aria-label={t("app.filterAria")}>
                    <div className="crumb-menu-list">
                      <button
                        type="button"
                        role="menuitem"
                        className={`crumb-menu-item ${statusFilter === "all" ? "is-active" : ""}`}
                        onClick={() => {
                          setStatusFilter("all");
                          setActiveTabId("board");
                          setCrumbMenu(null);
                        }}
                      >
                        <div className="crumb-menu-item-main">
                          <span className="crumb-menu-item-title">
                            <Layers size={13} aria-hidden="true" />
                            <span>{t("app.filterAll")}</span>
                          </span>
                        </div>
                        <div className="crumb-menu-item-right">
                          <span className="crumb-badge">{totalCardsCount}</span>
                          {statusFilter === "all" && <Check size={13} aria-hidden="true" />}
                        </div>
                      </button>

                      {boardColumnsMeta.map((colMeta) => {
                        const count =
                          boardQuery.data?.columns[colMeta.key as CardStatus]?.length ?? 0;
                        const isActive = statusFilter === colMeta.key;
                        return (
                          <button
                            key={colMeta.key}
                            type="button"
                            role="menuitem"
                            className={`crumb-menu-item ${isActive ? "is-active" : ""}`}
                            onClick={() => {
                              setStatusFilter(colMeta.key);
                              setActiveTabId("board");
                              setCrumbMenu(null);
                            }}
                          >
                            <div className="crumb-menu-item-main">
                              <span className="crumb-menu-item-title">
                                <StatusIcon
                                  status={colMeta.key}
                                  size={13}
                                  className={`column-status-icon status-icon-${colMeta.key}`}
                                />
                                <span>{colMeta.label}</span>
                                <code className="crumb-menu-item-code">{colMeta.codeLabel}</code>
                              </span>
                            </div>
                            <div className="crumb-menu-item-right">
                              <span className="crumb-badge">{count}</span>
                              {isActive && <Check size={13} aria-hidden="true" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="titlebar-right">
          {selectedProjectId && (
            <>
              <button
                type="button"
                className="workbench-action-btn"
                onClick={() => void boardQuery.refetch()}
                disabled={boardQuery.isFetching}
                title={t("app.refreshSnapshot")}
              >
                <RefreshCw size={13} aria-hidden="true" />
                <span className="action-btn-label">
                  {boardQuery.isFetching ? t("app.sync") : t("app.refreshSnapshot").replace(/^↻\s*/, "")}
                </span>
              </button>

              <button
                type="button"
                className={`workbench-action-btn workbench-action-primary ${
                  openWindows.includes("newCard") ? "is-active" : ""
                }`}
                onClick={() => toggleWindow("newCard")}
              >
                <Plus size={14} aria-hidden="true" />
                <span className="action-btn-label">
                  {t("app.newCard").replace(/^\+\s*/, "")}
                </span>
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Editor Body: Left Activity Rail + Left Dock + Center Canvas + Right Dock + Right Activity Rail */}
      <div className="workbench-body">
        {/* Left Activity Rail (Docked Left) */}
        <nav className="activity-rail activity-rail-left" aria-label="Left Dock Navigation">
          <div className="rail-group">
            <button
              type="button"
              className={`rail-btn ${leftDock === "projects" ? "is-active" : ""}`}
              onClick={() => toggleLeftDock("projects")}
              title={t("app.dockProjects")}
              aria-label={t("app.dockProjects")}
              aria-expanded={leftDock === "projects"}
            >
              <FolderKanban size={16} aria-hidden="true" />
              {projects.length > 0 && (
                <span className="rail-badge">{projects.length}</span>
              )}
            </button>

            <button
              type="button"
              className={`rail-btn ${leftDock === "views" ? "is-active" : ""}`}
              onClick={() => toggleLeftDock("views")}
              title={t("app.dockViews")}
              aria-label={t("app.dockViews")}
              aria-expanded={leftDock === "views"}
            >
              <Layers size={16} aria-hidden="true" />
              {statusFilter !== "all" && <span className="rail-dot" />}
            </button>

            {selectedProjectId && (
              <button
                type="button"
                className={`rail-btn ${leftDock === "agents" ? "is-active" : ""}`}
                onClick={() => toggleLeftDock("agents")}
                title={t("app.dockAgents")}
                aria-label={t("app.dockAgents")}
                aria-expanded={leftDock === "agents"}
              >
                <Bot size={16} aria-hidden="true" />
                <span className="rail-badge">{agentsCount}</span>
              </button>
            )}

            {selectedProjectId && (
              <button
                type="button"
                className={`rail-btn ${leftDock === "participants" ? "is-active" : ""}`}
                onClick={() => toggleLeftDock("participants")}
                title={t("app.dockParticipants")}
                aria-label={t("app.dockParticipants")}
                aria-expanded={leftDock === "participants"}
              >
                <Users size={16} aria-hidden="true" />
                <span className="rail-badge">{participantsCount}</span>
              </button>
            )}
          </div>

          <div className="rail-group rail-group-bottom">
            {user.role === "admin" && (
              <button
                type="button"
                className={`rail-btn ${
                  activeTabId === "admin" || openWindows.includes("admin")
                    ? "is-active"
                    : ""
                }`}
                onClick={handleOpenAdminTab}
                title={t("app.dockAdmin")}
                aria-label={t("app.dockAdmin")}
              >
                <Shield size={16} aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              className={`rail-btn ${leftDock === "settings" ? "is-active" : ""}`}
              onClick={() => toggleLeftDock("settings")}
              title={t("app.dockSettings")}
              aria-label={t("app.dockSettings")}
              aria-expanded={leftDock === "settings"}
            >
              <Settings size={16} aria-hidden="true" />
            </button>
          </div>
        </nav>

        {/* Left Dock Panel (Click to open) */}
        {leftDock && (
          <>
            <div
              className="dock-mobile-backdrop"
              onClick={() => setLeftDock(null)}
              aria-hidden="true"
            />
            <aside className="dock-panel dock-panel-left" aria-label={t("app.dockProjects")}>
              {leftDock === "projects" && (
                <div className="dock-content-panel">
                  <div className="drawer-header drawer-header-projects">
                    <h2 className="dock-panel-heading">
                      <FolderKanban size={14} aria-hidden="true" />
                      <span>{t("app.dockProjects")} ({projects.length})</span>
                    </h2>
                    <div className="drawer-header-actions">
                      {canManageArchive && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setShowArchivedProjects((value) => !value)}
                          aria-expanded={showArchivedProjects}
                          aria-label={t("projectArchive.toggle")}
                          title={t("projectArchive.toggle")}
                        >
                          <Archive size={14} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => openWindow("newProject")}
                      >
                        {t("app.newProject")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setLeftDock(null)}
                        aria-label={t("app.dockCollapse")}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div className="drawer-body">
                    <div className="dock-list">
                      {projects.map((p) => {
                        const isCurrent = p.id === selectedProjectId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            className={`dock-list-item ${isCurrent ? "is-active" : ""}`}
                            onClick={() => {
                              setSelectedProjectId(p.id);
                              resetProjectWorkspaceTabs();
                              setLeftDock(null);
                            }}
                          >
                            <div className="dock-item-main">
                              <span className="dock-item-title">{p.name}</span>
                              <span className="dock-item-sub">
                                <code>{p.slug}</code>
                              </span>
                            </div>
                            <ProjectRoleBadge role={p.role} access={p.access} />
                          </button>
                        );
                      })}
                    </div>

                    {showArchivedProjects && canManageArchive && (
                      <ArchivedProjectsPanel
                        projects={archivedProjects}
                        isLoading={archivedProjectsQuery.isLoading}
                        error={
                          archivedProjectsQuery.error instanceof Error
                            ? archivedProjectsQuery.error
                            : null
                        }
                        isAdmin={user.role === "admin"}
                        onRestored={handleProjectRestored}
                        onPurged={handleProjectPurged}
                      />
                    )}
                  </div>
                </div>
              )}

              {leftDock === "views" && (
                <div className="dock-content-panel">
                  <div className="drawer-header">
                    <h2 className="dock-panel-heading">
                      <Layers size={14} aria-hidden="true" />
                      <span>{t("app.dockViews")}</span>
                    </h2>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setLeftDock(null)}
                      aria-label={t("app.dockCollapse")}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="drawer-body">
                    <div className="dock-list" role="tablist" aria-label={t("app.filterAria")}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={statusFilter === "all"}
                        className={`dock-list-item ${statusFilter === "all" ? "is-active" : ""}`}
                        onClick={() => {
                          setStatusFilter("all");
                          setActiveTabId("board");
                        }}
                      >
                        <div className="dock-item-main">
                          <span className="dock-item-title">
                            <Layers size={13} aria-hidden="true" /> {t("app.filterAll")}
                          </span>
                          <span className="dock-item-sub">{t("app.filterAllDesc")}</span>
                        </div>
                        <span className="filter-tab-count">{totalCardsCount}</span>
                      </button>

                      {boardColumnsMeta.map((colMeta) => {
                        const count =
                          boardQuery.data?.columns[colMeta.key as CardStatus]?.length ?? 0;
                        const isActive = statusFilter === colMeta.key;
                        return (
                          <button
                            key={colMeta.key}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            className={`dock-list-item ${isActive ? "is-active" : ""}`}
                            onClick={() => {
                              setStatusFilter(colMeta.key);
                              setActiveTabId("board");
                            }}
                          >
                            <div className="dock-item-main">
                              <span className="dock-item-title">
                                <StatusIcon
                                  status={colMeta.key}
                                  size={13}
                                  className={`column-status-icon status-icon-${colMeta.key}`}
                                />{" "}
                                {colMeta.label}{" "}
                                <code className="filter-tab-code">{colMeta.codeLabel}</code>
                              </span>
                              <span className="dock-item-sub">{colMeta.description}</span>
                            </div>
                            <span className="filter-tab-count">{count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {leftDock === "agents" && selectedProjectId && currentProject && (
                <AgentsModal
                  docked
                  projectId={selectedProjectId}
                  project={currentProject}
                  agents={agentsQuery.data?.agents ?? []}
                  isLoading={agentsQuery.isLoading}
                  error={agentsQuery.error instanceof Error ? agentsQuery.error : null}
                  onClose={() => setLeftDock(null)}
                  onTokenIssued={handleTokenIssued}
                />
              )}

              {leftDock === "participants" && selectedProjectId && currentProject && (
                <ProjectParticipantsPanel
                  projectId={selectedProjectId}
                  currentUserId={user.id}
                  canManage={currentProject.role === "owner"}
                  members={membersQuery.data?.members ?? []}
                  membersLoading={membersQuery.isLoading}
                  membersError={
                    membersQuery.error instanceof Error
                      ? membersQuery.error
                      : null
                  }
                  agents={agentsQuery.data?.agents ?? []}
                  agentsLoading={agentsQuery.isLoading}
                  agentsError={
                    agentsQuery.error instanceof Error ? agentsQuery.error : null
                  }
                  onRefreshMembers={() => void membersQuery.refetch()}
                  onRefreshAgents={() => void agentsQuery.refetch()}
                  onClose={() => setLeftDock(null)}
                />
              )}

              {leftDock === "settings" && (
                <div className="dock-content-panel">
                  <div className="drawer-header">
                    <h2 className="dock-panel-heading">
                      <Settings size={14} aria-hidden="true" />
                      <span>{t("app.dockSettings")}</span>
                    </h2>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setLeftDock(null)}
                      aria-label={t("app.dockCollapse")}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="drawer-body">
                    {currentProject && currentProject.role === "owner" && (
                      <div className="dock-settings-group">
                        <div className="meta-label">{t("app.currentProjectLabel")}</div>
                        <div className="dock-user-box">
                          <div>
                            <strong>{currentProject.name}</strong>
                            <div className="field-hint">
                              <code>{currentProject.slug}</code>
                            </div>
                          </div>
                          <span className="badge badge-neutral">{currentProject.role}</span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handleOpenProjectSettingsTab}
                        >
                          <Settings size={13} aria-hidden="true" />
                          <span>{t("projectSettings.title")}</span>
                        </button>
                      </div>
                    )}

                    <div className="dock-settings-group">
                      <div className="meta-label">{t("app.accountLabel")}</div>
                      <div className="dock-user-box">
                        <div>
                          <strong>{user.display_name || user.email}</strong>
                          <div className="field-hint">{user.email}</div>
                        </div>
                        <InstanceRoleBadge role={user.role === "admin" ? "admin" : "member"} />
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => logoutMutation.mutate()}
                        disabled={logoutMutation.isPending}
                      >
                        {t("app.logout")}
                      </button>
                    </div>

                    <div className="dock-settings-group">
                      <label htmlFor="locale-select" className="meta-label">
                        {t("app.language")}
                      </label>
                      <select
                        id="locale-select"
                        className="select"
                        style={{ width: "100%" }}
                        value={locale}
                        onChange={(e) => setLocale(e.target.value as Locale)}
                        aria-label={t("app.language")}
                      >
                        {locales.map((item) => (
                          <option key={item} value={item}>
                            {labels[item]}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="dock-settings-group">
                      <div className="meta-label">{t("app.themeLabel")}</div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                      >
                        {theme === "dark" ? (
                          <Sun size={13} aria-hidden="true" />
                        ) : (
                          <Moon size={13} aria-hidden="true" />
                        )}
                        <span>
                          {theme === "dark"
                            ? t("app.themeToLight").replace(/^☀\s*/, "")
                            : t("app.themeToDark").replace(/^☾\s*/, "")}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </aside>
          </>
        )}

        {/* Center Editor Canvas */}
        <main className="editor-canvas">
          {projectsQuery.isLoading && (
            <div className="workspace-notice" role="status" aria-live="polite">
              <div className="workspace-loading-content">
                <Loader2 size={22} className="workspace-loading-spinner" aria-hidden="true" />
                <span className="workspace-loading-text">{t("app.loadingProjects")}</span>
              </div>
            </div>
          )}

          {projectsQuery.isError && (
            <div className="workspace-error" role="alert">
              <div className="alert alert-error">
                <div>
                  <strong>{t("app.projectsError")}</strong>{" "}
                  {projectsQuery.error instanceof ApiError
                    ? `${projectsQuery.error.message} [${projectsQuery.error.code}]`
                    : projectsQuery.error instanceof Error
                      ? projectsQuery.error.message
                      : "网络或服务器错误"}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void projectsQuery.refetch()}
                >
                  <RefreshCw size={12} aria-hidden="true" />
                  <span>{t("app.retry").replace(/^↻\s*/, "")}</span>
                </button>
              </div>
            </div>
          )}

          {!projectsQuery.isLoading &&
            !projectsQuery.isError &&
            projects.length === 0 &&
            activeTabId !== "admin" && (
              <CreateProjectView
                mode="empty-screen"
                canCreate={user.role === "admin"}
                onCreated={handleProjectCreated}
              />
            )}

          {(selectedProjectId || activeTabId === "admin") && (
            <div className="board-container">
              {boardQuery.isError && activeTabId === "board" && (
                <div className="alert alert-error board-error-banner" role="alert">
                  <span>
                    <strong>{t("app.boardError")}</strong>{" "}
                    {boardQuery.error instanceof ApiError
                      ? `${boardQuery.error.message} [${boardQuery.error.code}]`
                      : boardQuery.error instanceof Error
                        ? boardQuery.error.message
                        : "请求失败"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void boardQuery.refetch()}
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    <span>{t("app.reload").replace(/^↻\s*/, "")}</span>
                  </button>
                </div>
              )}

              {/* Document Tab Bar: Board, Admin, Project Settings, and Opened Cards */}
              <div
                ref={tabStripRef}
                className={`editor-tab-strip ${
                  windowDockHover ? "is-dock-drop-target" : ""
                }`}
                role="tablist"
                aria-label={t("app.boardAria")}
              >
                {openTabs.map((tabId) => {
                  if (tabId === "board") {
                    if (!selectedProjectId) return null;
                    const isActive = activeTabId === "board";
                    const isDragging = tabDragUi?.tabId === "board";
                    const dropSide =
                      tabDragUi?.overTabId === "board"
                        ? tabDragUi.insertPos
                        : windowDockHover?.overTabId === "board"
                          ? windowDockHover.insertPos
                          : null;
                    return (
                      <button
                        key="board"
                        type="button"
                        role="tab"
                        data-tab-id="board"
                        aria-selected={isActive}
                        className={`editor-tab ${isActive ? "is-active" : ""} ${
                          isDragging ? "is-dragging" : ""
                        } ${dropSide ? `drop-${dropSide}` : ""}`}
                        onPointerDown={(e) => handleTabPointerDown("board", false, e)}
                        onClick={() => {
                          if (suppressTabClickRef.current) return;
                          setActiveTabId("board");
                        }}
                      >
                        <LayoutGrid size={12} aria-hidden="true" />
                        <span>{t("app.tabBoard")}</span>
                        <span className="editor-tab-count">{filteredCards.length}</span>
                      </button>
                    );
                  }

                  if (tabId === "admin") {
                    if (user.role !== "admin") return null;
                    const isActive = activeTabId === "admin";
                    const isDragging = tabDragUi?.tabId === "admin";
                    const dropSide =
                      tabDragUi?.overTabId === "admin"
                        ? tabDragUi.insertPos
                        : windowDockHover?.overTabId === "admin"
                          ? windowDockHover.insertPos
                          : null;
                    return (
                      <div
                        key="admin"
                        role="tab"
                        tabIndex={0}
                        data-tab-id="admin"
                        aria-selected={isActive}
                        className={`editor-tab editor-doc-tab ${
                          isActive ? "is-active" : ""
                        } ${isDragging ? "is-dragging" : ""} ${
                          dropSide ? `drop-${dropSide}` : ""
                        }`}
                        onPointerDown={(e) => handleTabPointerDown("admin", true, e)}
                        onClick={() => {
                          if (suppressTabClickRef.current) return;
                          setActiveTabId("admin");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setActiveTabId("admin");
                          }
                        }}
                      >
                        <Shield size={12} aria-hidden="true" />
                        <span className="editor-tab-title">{t("app.tabAdmin")}</span>
                        <span className="editor-tab-actions">
                          <button
                            type="button"
                            className="editor-tab-action editor-tab-detach"
                            onClick={(e) => handleDetachTab("admin", undefined, e)}
                            aria-label={t("app.detachTab")}
                            title={t("app.detachTab")}
                          >
                            <ExternalLink size={10} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="editor-tab-action editor-tab-close"
                            onClick={(e) => handleCloseAdminTab(e)}
                            aria-label={t("app.closeTab")}
                            title={t("app.closeTab")}
                          >
                            <X size={11} aria-hidden="true" />
                          </button>
                        </span>
                      </div>
                    );
                  }

                  if (tabId === "projectSettings") {
                    if (!currentProject) return null;
                    const isActive = activeTabId === "projectSettings";
                    const isDragging = tabDragUi?.tabId === "projectSettings";
                    const dropSide =
                      tabDragUi?.overTabId === "projectSettings"
                        ? tabDragUi.insertPos
                        : windowDockHover?.overTabId === "projectSettings"
                          ? windowDockHover.insertPos
                          : null;
                    return (
                      <div
                        key="projectSettings"
                        role="tab"
                        tabIndex={0}
                        data-tab-id="projectSettings"
                        aria-selected={isActive}
                        className={`editor-tab editor-doc-tab ${
                          isActive ? "is-active" : ""
                        } ${isDragging ? "is-dragging" : ""} ${
                          dropSide ? `drop-${dropSide}` : ""
                        }`}
                        onPointerDown={(e) =>
                          handleTabPointerDown("projectSettings", true, e)
                        }
                        onClick={() => {
                          if (suppressTabClickRef.current) return;
                          setActiveTabId("projectSettings");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setActiveTabId("projectSettings");
                          }
                        }}
                      >
                        <Settings size={12} aria-hidden="true" />
                        <span className="editor-tab-title">
                          {t("projectSettings.title")}
                        </span>
                        <span className="editor-tab-actions">
                          <button
                            type="button"
                            className="editor-tab-action editor-tab-detach"
                            onClick={(e) =>
                              handleDetachTab("projectSettings", undefined, e)
                            }
                            aria-label={t("app.detachTab")}
                            title={t("app.detachTab")}
                          >
                            <ExternalLink size={10} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="editor-tab-action editor-tab-close"
                            onClick={(e) => handleCloseTab("projectSettings", e)}
                            aria-label={t("app.closeTab")}
                            title={t("app.closeTab")}
                          >
                            <X size={11} aria-hidden="true" />
                          </button>
                        </span>
                      </div>
                    );
                  }

                  if (!selectedProjectId) return null;
                  const cid = tabId;
                  const tabCard = allCardsMap.get(cid);
                  const isActive = activeTabId === cid;
                  const isDragging = tabDragUi?.tabId === cid;
                  const dropSide =
                    tabDragUi?.overTabId === cid
                      ? tabDragUi.insertPos
                      : windowDockHover?.overTabId === cid
                        ? windowDockHover.insertPos
                        : null;
                  return (
                    <div
                      key={cid}
                      role="tab"
                      tabIndex={0}
                      data-tab-id={cid}
                      aria-selected={isActive}
                      className={`editor-tab editor-doc-tab ${
                        isActive ? "is-active" : ""
                      } ${isDragging ? "is-dragging" : ""} ${
                        dropSide ? `drop-${dropSide}` : ""
                      }`}
                      onPointerDown={(e) => handleTabPointerDown(cid, true, e)}
                      onClick={() => {
                        if (suppressTabClickRef.current) return;
                        setActiveTabId(cid);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setActiveTabId(cid);
                        }
                      }}
                    >
                      {tabCard ? (
                        <StatusIcon
                          status={tabCard.status}
                          size={12}
                          className={`column-status-icon status-icon-${tabCard.status}`}
                        />
                      ) : (
                        <Layers size={12} aria-hidden="true" />
                      )}
                      <span className="editor-tab-title" title={tabCard?.title ?? cid}>
                        {tabCard ? tabCard.title : `#${cid.slice(0, 8)}`}
                      </span>
                      <span className="editor-tab-actions">
                        <button
                          type="button"
                          className="editor-tab-action editor-tab-detach"
                          onClick={(e) => handleDetachTab(cid, undefined, e)}
                          aria-label={t("app.detachTab")}
                          title={t("app.detachTab")}
                        >
                          <ExternalLink size={10} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="editor-tab-action editor-tab-close"
                          onClick={(e) => handleCloseCardTab(cid, e)}
                          aria-label={t("app.closeTab")}
                          title={t("app.closeTab")}
                        >
                          <X size={11} aria-hidden="true" />
                        </button>
                      </span>
                    </div>
                  );
                })}

                {windowDockHover && (
                  <span className="editor-tab-dock-hint">
                    {t("app.dropToDockTab")}
                  </span>
                )}
              </div>

              {activeTabId === "projectSettings" && currentProject ? (
                <div className="editor-card-tab-viewport">
                  <ProjectSettingsModal
                    embedded
                    projectId={currentProject.id}
                    onClose={() => handleCloseTab("projectSettings")}
                    onArchived={handleProjectArchived}
                  />
                </div>
              ) : activeTabId === "admin" && user.role === "admin" ? (
                <div className="editor-card-tab-viewport">
                  <AdminPanel
                    currentUser={user}
                    onClose={() => handleCloseAdminTab()}
                  />
                </div>
              ) : activeTabId === "board" ? (
                <div
                  className="cards-board-viewport"
                  role="region"
                  aria-label={t("app.boardAria")}
                >
                  {boardQuery.isLoading ? (
                    <div className="cards-board-placeholder">{t("app.columnLoading")}</div>
                  ) : filteredCards.length === 0 ? (
                    <div className="cards-board-placeholder-wrap">
                      <div className="cards-board-placeholder cards-board-guide">
                        <div className="guide-header">
                          <h3 className="guide-title">
                            {statusFilter === "all"
                              ? t("app.guideTitle")
                              : t("app.emptyFiltered", {
                                  status: activeFilterMeta?.label ?? statusFilter,
                                })}
                          </h3>
                          <p className="guide-subtitle">{t("app.guideSubtitle")}</p>
                        </div>

                        <ol className="guide-steps">
                          <li className="guide-step-item">
                            <strong>{t("app.guideStep1Title")}</strong>
                            <span>{t("app.guideStep1Desc")}</span>
                          </li>
                          <li className="guide-step-item">
                            <strong>{t("app.guideStep2Title")}</strong>
                            <span>{t("app.guideStep2Desc")}</span>
                          </li>
                          <li className="guide-step-item">
                            <strong>{t("app.guideStep3Title")}</strong>
                            <span>{t("app.guideStep3Desc")}</span>
                          </li>
                        </ol>
                      </div>

                      {promptError && (
                        <div className="alert alert-error" role="alert">
                          {promptError}
                        </div>
                      )}

                      <div className="placeholder-actions-row">
                        <button
                          type="button"
                          className="placeholder-text-btn"
                          onClick={() => void handleCopyOnboardingPrompt()}
                          disabled={promptCopying}
                        >
                          {promptCopied ? (
                            <Check size={14} aria-hidden="true" />
                          ) : (
                            <Copy size={14} aria-hidden="true" />
                          )}
                          <span>
                            {promptCopying
                              ? t("app.preparingPrompt")
                              : promptCopied
                                ? t("app.copiedPrompt")
                                : t("app.copyPrompt")}
                          </span>
                        </button>

                        <button
                          type="button"
                          className="placeholder-text-btn placeholder-text-btn-primary"
                          onClick={() => openWindow("newCard")}
                        >
                          <Plus size={14} aria-hidden="true" />
                          <span>{t("app.newCard").replace(/^\+\s*/, "")}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="cards-grid">
                      {filteredCards.map((card) => (
                        <CardTile
                          key={card.id}
                          card={card}
                          isSelected={
                            openTabs.includes(card.id) ||
                            openWindows.includes(`card:${card.id}`)
                          }
                          agentNameMap={agentNameMap}
                          onSelect={handleSelectCard}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : selectedProjectId ? (
                <div className="editor-card-tab-viewport">
                  <CardDrawer
                    embedded
                    cardId={activeTabId}
                    projectId={selectedProjectId}
                    projectRole={currentProject?.role}
                    fallbackCard={selectedCardFallback}
                    agentNameMap={agentNameMap}
                    currentUser={user}
                    onClose={() => handleCloseCardTab(activeTabId)}
                  />
                </div>
              ) : null}

              {/* Bottom Dock Panel (Click status bar to open) */}
              {bottomDockOpen && (
                <section className="dock-panel-bottom" aria-label={t("app.dockConsole")}>
                  <div className="drawer-header">
                    <h2 className="dock-panel-heading">
                      <Terminal size={13} aria-hidden="true" />
                      <span>{t("app.consoleTitle")}</span>
                    </h2>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setBottomDockOpen(false)}
                      aria-label={t("app.dockCollapse")}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="bottom-dock-body">
                    <div className="bottom-console-grid">
                      <div className="meta-item">
                        <span className="meta-label">{t("app.subbarProject")}</span>
                        <span className="meta-value">
                          {boardQuery.data?.project.name ?? "—"} (
                          <code>{boardQuery.data?.project.slug ?? "—"}</code>)
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">SSE Stream</span>
                        <span className="meta-value">
                          <ConnectionIcon status={sseStatus} size={12} /> {connMeta.label} ·{" "}
                          {t("app.seq")}
                          <code>{displaySeq}</code>
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">{t("app.subbarTotal")}</span>
                        <span className="meta-value">{totalCardsCount}</span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">{t("app.subbarSort")}</span>
                        <span className="meta-value">
                          <code>priority DESC, updated_at DESC</code>
                        </span>
                      </div>
                    </div>
                    <div className="field-hint">
                      {activeFilterMeta ? activeFilterMeta.description : t("app.filterAllDesc")}
                    </div>
                  </div>
                </section>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Movable & Resizable Floating Dialog Windows */}
      {openWindows.map((winKey, idx) => {
        const zIndex = 120 + idx;
        if (winKey === "newCard" && selectedProjectId) {
          return (
            <FloatingWindow
              key="newCard"
              id="window-new-card"
              title="新建协商卡片"
              icon={<FilePlus2 size={14} aria-hidden="true" />}
              initialWidth={560}
              initialHeight={560}
              initialX={Math.max(48, window.innerWidth - 630)}
              initialY={58}
              zIndex={zIndex}
              onFocus={() => focusWindow("newCard")}
              onClose={() => closeWindow("newCard")}
            >
              <CreateCardModal
                windowed
                projectId={selectedProjectId}
                onClose={() => closeWindow("newCard")}
                onCreated={(card) => {
                  closeWindow("newCard");
                  handleSelectCard(card.id);
                }}
              />
            </FloatingWindow>
          );
        }

        if (winKey === "newProject") {
          return (
            <FloatingWindow
              key="newProject"
              id="window-new-project"
              title={t("app.newProject").replace(/^\+\s*/, "")}
              icon={<FolderPlus size={14} aria-hidden="true" />}
              initialWidth={480}
              initialHeight={380}
              zIndex={zIndex}
              onFocus={() => focusWindow("newProject")}
              onClose={() => closeWindow("newProject")}
            >
              <CreateProjectView
                mode="window"
                onCancel={() => closeWindow("newProject")}
                onCreated={(project, token) => {
                  closeWindow("newProject");
                  handleProjectCreated(project, token);
                }}
              />
            </FloatingWindow>
          );
        }

        if (winKey === "projectSettings" && currentProject) {
          const spawn = windowSpawnPos[winKey];
          return (
            <FloatingWindow
              key="projectSettings"
              id="window-project-settings"
              title={t("projectSettings.title")}
              icon={<Settings size={14} aria-hidden="true" />}
              initialWidth={520}
              initialHeight={560}
              initialX={spawn?.x ?? Math.max(48, window.innerWidth - 590)}
              initialY={spawn?.y ?? 70}
              zIndex={zIndex}
              onFocus={() => focusWindow("projectSettings")}
              onClose={() => closeWindow("projectSettings")}
              onDock={() => handleDockWindowToTab("projectSettings")}
              dockLabel={t("app.dockToTab")}
              onMoveDrag={(cx, cy) => {
                const target = inspectTabTargetAtPoint(cx, cy, "projectSettings");
                setWindowDockHover(
                  target.inDockZone
                    ? {
                        tabId: "projectSettings",
                        overTabId: target.overTabId,
                        insertPos: target.insertPos,
                      }
                    : null,
                );
              }}
              onMoveEnd={(cx, cy) => {
                const target = inspectTabTargetAtPoint(cx, cy, "projectSettings");
                setWindowDockHover(null);
                if (target.inDockZone) {
                  handleDockWindowToTab(
                    "projectSettings",
                    target.overTabId,
                    target.insertPos,
                  );
                }
              }}
            >
              <ProjectSettingsModal
                projectId={currentProject.id}
                onClose={() => closeWindow("projectSettings")}
                onArchived={handleProjectArchived}
              />
            </FloatingWindow>
          );
        }

        if (winKey === "agents" && selectedProjectId && currentProject) {
          return (
            <FloatingWindow
              key="agents"
              id="window-agents"
              title={`${t("app.dockAgents")} (${agentsCount})`}
              icon={<Bot size={14} aria-hidden="true" />}
              initialWidth={620}
              initialHeight={440}
              zIndex={zIndex}
              onFocus={() => focusWindow("agents")}
              onClose={() => closeWindow("agents")}
            >
              <AgentsModal
                windowed
                projectId={selectedProjectId}
                project={currentProject}
                agents={agentsQuery.data?.agents ?? []}
                isLoading={agentsQuery.isLoading}
                error={agentsQuery.error instanceof Error ? agentsQuery.error : null}
                onClose={() => closeWindow("agents")}
                onTokenIssued={handleTokenIssued}
              />
            </FloatingWindow>
          );
        }

        if (winKey === "admin" && user.role === "admin") {
          const spawn = windowSpawnPos[winKey];
          return (
            <FloatingWindow
              key="admin"
              id="window-admin"
              title={t("app.tabAdmin")}
              icon={<Shield size={14} aria-hidden="true" />}
              initialWidth={860}
              initialHeight={600}
              initialX={spawn?.x}
              initialY={spawn?.y}
              zIndex={zIndex}
              onFocus={() => focusWindow("admin")}
              onClose={() => closeWindow("admin")}
              onDock={() => handleDockWindowToTab("admin")}
              dockLabel={t("app.dockToTab")}
              onMoveDrag={(cx, cy) => {
                const target = inspectTabTargetAtPoint(cx, cy, "admin");
                setWindowDockHover(
                  target.inDockZone
                    ? {
                        tabId: "admin",
                        overTabId: target.overTabId,
                        insertPos: target.insertPos,
                      }
                    : null,
                );
              }}
              onMoveEnd={(cx, cy) => {
                const target = inspectTabTargetAtPoint(cx, cy, "admin");
                setWindowDockHover(null);
                if (target.inDockZone) {
                  handleDockWindowToTab("admin", target.overTabId, target.insertPos);
                }
              }}
            >
              <AdminPanel
                currentUser={user}
                onClose={() => closeWindow("admin")}
              />
            </FloatingWindow>
          );
        }

        if (winKey.startsWith("card:") && selectedProjectId) {
          const cid = winKey.slice("card:".length);
          const winCard = allCardsMap.get(cid) ?? null;
          const spawn = windowSpawnPos[winKey];
          return (
            <FloatingWindow
              key={winKey}
              id={`window-card-${cid}`}
              title={winCard ? winCard.title : `#${cid.slice(0, 8)}`}
              icon={
                winCard ? (
                  <StatusIcon
                    status={winCard.status}
                    size={13}
                    className={`column-status-icon status-icon-${winCard.status}`}
                  />
                ) : (
                  <Layers size={13} aria-hidden="true" />
                )
              }
              initialWidth={760}
              initialHeight={580}
              initialX={spawn?.x}
              initialY={spawn?.y}
              zIndex={zIndex}
              onFocus={() => focusWindow(winKey)}
              onClose={() => closeWindow(winKey)}
              onDock={() => handleDockWindowToTab(cid)}
              dockLabel={t("app.dockToTab")}
              onMoveDrag={(cx, cy) => {
                const target = inspectTabTargetAtPoint(cx, cy, cid);
                setWindowDockHover(
                  target.inDockZone
                    ? {
                        tabId: cid,
                        overTabId: target.overTabId,
                        insertPos: target.insertPos,
                      }
                    : null,
                );
              }}
              onMoveEnd={(cx, cy) => {
                const target = inspectTabTargetAtPoint(cx, cy, cid);
                setWindowDockHover(null);
                if (target.inDockZone) {
                  handleDockWindowToTab(cid, target.overTabId, target.insertPos);
                }
              }}
            >
              <CardDrawer
                embedded
                cardId={cid}
                projectId={selectedProjectId}
                projectRole={currentProject?.role}
                fallbackCard={winCard}
                agentNameMap={agentNameMap}
                currentUser={user}
                onClose={() => closeWindow(winKey)}
              />
            </FloatingWindow>
          );
        }

        return null;
      })}

      {tabDragUi && (
        <div
          className={`tab-drag-ghost ${
            tabDragUi.isDetaching ? "is-detaching" : ""
          }`}
          style={{
            left: tabDragUi.clientX + 12,
            top: tabDragUi.clientY + 12,
          }}
          aria-hidden="true"
        >
          {tabDragUi.tabId === "board" ? (
            <>
              <LayoutGrid size={12} />
              <span>{t("app.tabBoard")}</span>
            </>
          ) : tabDragUi.tabId === "admin" ? (
            <>
              <Shield size={12} />
              <span>{t("app.tabAdmin")}</span>
            </>
          ) : (
            <>
              <Layers size={12} />
              <span>
                {allCardsMap.get(tabDragUi.tabId)?.title ??
                  `#${tabDragUi.tabId.slice(0, 8)}`}
              </span>
            </>
          )}
          {tabDragUi.isDetaching && (
            <span className="tab-drag-ghost-badge">
              <ExternalLink size={10} />
              <span>{t("app.detachTab")}</span>
            </span>
          )}
        </div>
      )}

      {tokenNotice && (
        <ProjectTokenNotice
          project={tokenNotice.project}
          token={tokenNotice.token}
          title={tokenNotice.kind === "rotated" ? t("project.tokenRotatedTitle", { name: tokenNotice.project.name }) : undefined}
          intro={tokenNotice.kind === "rotated" ? t("project.tokenRotatedIntro") : undefined}
          dismissLabel={tokenNotice.kind === "rotated" ? t("project.tokenAcknowledged") : undefined}
          onDismiss={handleTokenAcknowledged}
        />
      )}

      {/* Bottom Status Bar (Docked Bottom) */}
      <footer className="workbench-statusbar">
        <div className="statusbar-left">
          <button
            type="button"
            className={`statusbar-item statusbar-sse sse-${sseStatus} ${
              bottomDockOpen ? "is-active" : ""
            }`}
            onClick={() => setBottomDockOpen((v) => !v)}
            title={t("app.liveTitle")}
          >
            <ConnectionIcon status={sseStatus} size={12} />
            <span className="statusbar-sse-text">{connMeta.label}</span>
            <span className="statusbar-seq">
              {t("app.seq")}
              {displaySeq}
            </span>
          </button>

          {selectedProjectId && (
            <button
              type="button"
              className={`statusbar-item ${bottomDockOpen ? "is-active" : ""}`}
              onClick={() => setBottomDockOpen((v) => !v)}
              title={t("app.dockConsole")}
            >
              <Terminal size={12} aria-hidden="true" />
              <span>{t("app.subbarTotal")}{totalCardsCount}</span>
            </button>
          )}
        </div>

        <div className="statusbar-right">
          <button
            type="button"
            className="statusbar-item statusbar-hide-sm"
            onClick={() => toggleLeftDock("agents")}
          >
            <Bot size={12} aria-hidden="true" />
            <span>{t("app.agents", { count: agentsCount }).replace(/^◈\s*/, "")}</span>
          </button>

          <button
            type="button"
            className="statusbar-item"
            onClick={() => toggleLeftDock("settings")}
            title={t("app.currentUser", {
              name: user.display_name || user.email,
              role: user.role,
            })}
          >
            <User size={12} aria-hidden="true" />
            <span>{user.display_name || user.email}</span>
          </button>

          <button
            type="button"
            className="statusbar-item"
            onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
            title={t("app.themeAria", {
              theme: theme === "dark" ? t("app.themeToLight") : t("app.themeToDark"),
            })}
          >
            {theme === "dark" ? (
              <Sun size={12} aria-hidden="true" />
            ) : (
              <Moon size={12} aria-hidden="true" />
            )}
          </button>
        </div>
      </footer>
    </div>
  );
}

export function App(): React.ReactElement {
  const { t } = useI18n();
  const [setupResult, setSetupResult] = useState<SetupResponse | null>(null);

  const setupStatusQuery = useQuery({
    queryKey: ["setupStatus"],
    queryFn: () => api.getSetupStatus(),
    retry: false,
  });

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api.getMe(),
    retry: false,
    enabled: setupStatusQuery.data?.needs_setup === false && !setupResult,
  });

  if (setupResult || setupStatusQuery.data?.needs_setup) {
    return <SetupWizard completedResult={setupResult} onTokenReady={setSetupResult} onComplete={() => window.location.assign("/")} />;
  }

  if (setupStatusQuery.isLoading) {
    return <div className="auth-loading">{t("common.loading")}</div>;
  }

  if (setupStatusQuery.isError && !setupStatusQuery.data) {
    return (
      <div className="auth-loading">
        <div className="alert alert-error" role="alert">
          <span>{t("setup.statusFailed")}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void setupStatusQuery.refetch()}>{t("common.retry")}</button>
        </div>
      </div>
    );
  }

  if (meQuery.isLoading) {
    return <div className="auth-loading">{t("common.loading")}</div>;
  }

  if (meQuery.isError) {
    if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
      return (
        <LoginPage
          needsBootstrap={false}
          onAuthenticated={() => {
            window.location.assign("/");
          }}
        />
      );
    }
    return (
      <div className="auth-loading">
        <div className="alert alert-error" role="alert">
          <span>{meQuery.error instanceof Error ? meQuery.error.message : "auth error"}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void meQuery.refetch()}
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!meQuery.data) {
    return <div className="auth-loading">{t("common.loading")}</div>;
  }

  if (meQuery.data.user.must_change_password) {
    return <ChangePasswordPage onDone={() => window.location.assign("/")} />;
  }

  return <BoardApp user={meQuery.data.user} />;
}
