import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { ProjectHomeGraph } from "./components/ProjectHomeGraph";

const sentryIcon = new URL("./assets/sentry.svg", import.meta.url).href;
const githubIcon = new URL("./assets/github.svg", import.meta.url).href;
const sidebarHomeIcon = new URL("./assets/sidebar/icons8-home-50.svg", import.meta.url).href;
const sidebarLogsIcon = new URL("./assets/sidebar/icons8-rfid-signal-50.svg", import.meta.url).href;
const sidebarIncidentsIcon = new URL("./assets/sidebar/icons8-insect-50.svg", import.meta.url).href;
const sidebarPerformanceIcon = new URL("./assets/sidebar/icons8-speed-50.svg", import.meta.url)
  .href;
const sidebarSettingsIcon = new URL("./assets/sidebar/icons8-settings-50.svg", import.meta.url)
  .href;
const brandText = "Hotfix";
const glyphVariants: Record<string, string[]> = {
  H: ["H", "#", "4"],
  o: ["o", "0", "O", "@"],
  t: ["t", "T", "+", "7"],
  f: ["f", "F"],
  i: ["i", "I", "1", "!", "|"],
  x: ["x", "X", "%", "*"],
};

type SessionResponse = {
  authenticated: boolean;
  user: {
    id: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    providers: {
      github: boolean;
      sentry: boolean;
    };
  } | null;
};

type AuthenticatedUser = NonNullable<SessionResponse["user"]>;

type SentryOrganizationSummary = {
  connectionId: string;
  slug: string;
  name: string;
};

type GitHubRepoMapping = {
  repoId: number;
  fullName: string;
  url: string;
  defaultBranch: string | null;
};

type ImportedSentryProject = {
  id: string;
  sentryProjectId: string;
  slug: string;
  name: string;
  platform: string | null;
  included: boolean;
  repoMapping: GitHubRepoMapping | null;
};

type HotfixProject = {
  id: string;
  name: string;
  slug: string;
  createdAt: number | string;
  lastActivityAt: number | null;
  itemsCount: number;
  incidentCount: number;
  githubConnected: boolean;
  sentryConnected: boolean;
  indexingStatus: string;
  indexingPercentage: number;
  sentryOrganization: SentryOrganizationSummary | null;
  sentryProjects: ImportedSentryProject[];
};

type IncidentSentryIssue = {
  id: string;
  sentryIssueId: string;
  shortId: string | null;
  title: string;
  status: string;
  level: string | null;
  projectSlug: string;
  projectName: string;
  permalink: string | null;
  eventCount: number;
  userCount: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
};

type IncidentCodeRef = {
  id: string;
  githubRepoId: number | null;
  githubRepoFullName: string | null;
  githubRepoUrl: string | null;
  path: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
  confidence: number;
  source: string;
};

type HotfixIncident = {
  id: string;
  incidentKey: string;
  title: string;
  status: string;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  issueCount: number;
  sentryProjectCount: number;
  sentryIssues: IncidentSentryIssue[];
  codeRefs: IncidentCodeRef[];
};

type DashboardPayload = {
  sentryOrganizations: SentryOrganizationSummary[];
  projects: HotfixProject[];
};

type AppView = "auth" | "terms" | "privacy";
type BrandGlyph = {
  character: string;
  accent: boolean;
};
type ProjectSectionTab = "logs" | "incidents" | "performance" | "settings";
type ProjectRouteSection = "home" | ProjectSectionTab;
type ProjectsSort = "created" | "alphabetical" | "items" | "incidents" | "lastActivity" | "indexing";
type ProjectsView = "list" | "grid";
type ProjectRouteState = {
  slug: string | null;
  section: ProjectRouteSection;
};

const fetchSession = async (): Promise<SessionResponse> => {
  return fetchJson<SessionResponse>("/api/session", {
    headers: {
      Accept: "application/json",
    },
  });
};

const fetchDashboard = async (): Promise<DashboardPayload> => {
  return fetchJson<DashboardPayload>("/api/dashboard", {
    headers: {
      Accept: "application/json",
    },
  });
};

const fetchHotfixIncidents = async (projectId: string): Promise<HotfixIncident[]> => {
  return fetchJson<HotfixIncident[]>(`/api/hotfix-projects/${projectId}/incidents`, {
    headers: {
      Accept: "application/json",
    },
  });
};

const backfillHotfixIncidents = async (projectId: string): Promise<HotfixIncident[]> => {
  return fetchJson<HotfixIncident[]>(`/api/hotfix-projects/${projectId}/backfill-incidents`, {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });
};

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? "Request failed.");
  }

  return payload as T;
}

const getInitialView = (): AppView => {
  if (typeof window === "undefined") {
    return "auth";
  }

  return resolveView(window.location.pathname);
};

function App() {
  const [view] = createSignal<AppView>(getInitialView());
  const [notice, setNotice] = createSignal<string | null>(null);
  const [loggingOut, setLoggingOut] = createSignal(false);
  const [session, { refetch }] = createResource(
    () => (view() === "auth" ? "session" : null),
    async () => fetchSession(),
  );

  onMount(() => {
    if (view() !== "auth") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");

    if (!authError) {
      return;
    }

    setNotice(authError);
    params.delete("auth_error");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  });

  const logout = async () => {
    setLoggingOut(true);
    setNotice(null);

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error("Could not end the current session.");
      }

      await refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not end the current session.";
      setNotice(message);
    } finally {
      setLoggingOut(false);
    }
  };

  const authenticatedUser = () =>
    view() === "auth" && session()?.authenticated && session()?.user ? session()?.user : null;
  const showPublicChrome = () => !authenticatedUser();

  return (
    <main class="relative min-h-screen overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
      <div
        class={
          showPublicChrome()
            ? "relative flex min-h-screen w-full flex-col p-4"
            : "relative flex min-h-screen w-full flex-col"
        }
      >
        <Show when={showPublicChrome()}>
          <header class="absolute left-4 top-[0.7rem] z-10">
            <a href="/" class="brand-wordmark-link" aria-label="Go to home">
              <BrandWordmark mode={brandAnimationMode(view(), session())} />
            </a>
          </header>
        </Show>

        <Show
          when={view() === "auth"}
          fallback={
            <section class="mx-auto flex w-full max-w-3xl flex-1 items-start pt-10 pb-16 sm:pt-14">
              <div class="legal-shell w-full">
                <Show when={view() === "terms"} fallback={<PrivacyPage />}>
                  <TermsPage />
                </Show>
              </div>
            </section>
          }
        >
          <Show
            when={authenticatedUser()}
            fallback={
              <section class="mx-auto flex w-full max-w-[420px] flex-1 items-center py-16">
                <div class="auth-panel-offset w-full">
                  <div class="auth-shell w-full">
                    <Show
                      when={!session.error}
                      fallback={
                        <FeedbackPanel
                          eyebrow="Connection issue"
                          title="The session service is unavailable"
                          message="Start the Rust backend and refresh the page."
                          actionLabel="Retry"
                          onAction={() => void refetch()}
                        />
                      }
                    >
                      <Show
                        when={!session.loading}
                        fallback={
                          <div class="space-y-3">
                            <div class="h-4 w-28 rounded-[4px] bg-[rgba(255,255,255,0.06)]" />
                            <div class="h-8 w-64 rounded-[4px] bg-[rgba(255,255,255,0.08)]" />
                            <div class="h-4 w-52 rounded-[4px] bg-[rgba(255,255,255,0.06)]" />
                            <div class="mt-8 h-10 rounded-[4px] bg-[rgba(255,255,255,0.06)]" />
                            <div class="h-10 rounded-[4px] bg-[rgba(255,255,255,0.06)]" />
                          </div>
                        }
                      >
                        <LoginPanel notice={notice()} />
                      </Show>
                    </Show>
                  </div>
                </div>
              </section>
            }
          >
            {(result) => (
              <AuthenticatedPanel
                notice={notice()}
                user={result()}
                loggingOut={loggingOut()}
                onLogout={logout}
              />
            )}
          </Show>
        </Show>

        <Show when={showPublicChrome()}>
          <footer class="mt-auto flex justify-center pb-2 pt-8">
            <div class="flex items-center gap-3 text-[0.74rem] text-[var(--text-muted)]">
              <a class="footer-link" href="/terms">
                Terms of Service
              </a>
              <span aria-hidden="true" class="text-white/18">
                /
              </span>
              <a class="footer-link" href="/privacy">
                Privacy Policy
              </a>
            </div>
          </footer>
        </Show>
      </div>
    </main>
  );
}

function BrandWordmark(props: { mode: "loop" | "hover" }) {
  const [displayGlyphs, setDisplayGlyphs] = createSignal<BrandGlyph[]>(createBaseBrandGlyphs());
  let timeoutId: number | undefined;
  let intervalId: number | undefined;

  onMount(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mediaQuery.matches) {
      return;
    }

    const stopCycle = () => {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const queueNextCycle = () => {
      if (props.mode !== "loop") {
        return;
      }
      timeoutId = window.setTimeout(startCycle, 900 + Math.random() * 650);
    };

    const startCycle = () => {
      if (intervalId !== undefined) {
        return;
      }

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      let frame = 0;
      const totalFrames = 8;
      intervalId = window.setInterval(() => {
        frame += 1;
        setDisplayGlyphs(scrambleBrandWord(frame, totalFrames));

        if (frame >= totalFrames) {
          stopCycle();
          setDisplayGlyphs(createBaseBrandGlyphs());
          queueNextCycle();
        }
      }, 72);
    };

    createEffect(() => {
      stopCycle();
      setDisplayGlyphs(createBaseBrandGlyphs());

      if (props.mode === "loop") {
        queueNextCycle();
      }
    });

    onCleanup(stopCycle);

    const node = document.querySelector(".brand-wordmark");
    if (!node) {
      return;
    }

    const handleMouseEnter = () => {
      if (props.mode === "hover") {
        startCycle();
      }
    };

    node.addEventListener("mouseenter", handleMouseEnter);
    onCleanup(() => {
      node.removeEventListener("mouseenter", handleMouseEnter);
    });
  });

  return (
    <span class="brand-wordmark" aria-label="Hotfix">
      <For each={displayGlyphs()}>
        {(glyph) => (
          <span class="brand-char" classList={{ "is-scrambling": glyph.accent }} aria-hidden="true">
            {glyph.character}
          </span>
        )}
      </For>
    </span>
  );
}

function TermsPage() {
  return (
    <article class="space-y-8 rounded-[4px] bg-[var(--surface)] px-6 py-6 text-[0.94rem] leading-7 text-[var(--text-secondary)] sm:px-8">
      <div class="space-y-3">
        <a
          class="inline-flex items-center text-[0.75rem] uppercase tracking-[0.24em] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          href="/"
        >
          Back
        </a>
        <div class="space-y-2">
          <p class="text-[0.72rem] font-medium uppercase tracking-[0.28em] text-[var(--text-muted)]">
            Terms of Service
          </p>
          <h1 class="text-[1.7rem] font-medium tracking-[-0.04em] text-[var(--text-primary)] sm:text-[2rem]">
            Terms for Hotfix
          </h1>
          <p>Effective April 1, 2026</p>
        </div>
      </div>

      <LegalSection
        title="Use of the service"
        body="Hotfix is provided for software development, analysis, automation, and related workflows. You are responsible for how you use the service, the data you submit, the code you run, and the outputs you rely on."
      />
      <LegalSection
        title="No warranties"
        body="The service is provided on an “as is” and “as available” basis. To the fullest extent permitted by law, Hotfix disclaims all warranties, express or implied, including merchantability, fitness for a particular purpose, non-infringement, availability, security, accuracy, and error-free operation."
      />
      <LegalSection
        title="Use at your own risk"
        body="Hotfix may generate incomplete, incorrect, insecure, or harmful output. You must independently review and validate any analysis, code, recommendation, or automation result before using it in development, production, security, legal, financial, or other sensitive contexts."
      />
      <LegalSection
        title="Limitation of liability"
        body="To the fullest extent permitted by law, Hotfix and its affiliates, officers, employees, contractors, and licensors will not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for any loss of profits, revenue, data, goodwill, business opportunity, or system availability, arising out of or related to the service, even if advised of the possibility of those damages."
      />
      <LegalSection
        title="Liability cap"
        body="To the fullest extent permitted by law, the total aggregate liability of Hotfix for all claims arising out of or relating to the service will not exceed the greater of one hundred U.S. dollars (USD $100) or the amount you paid Hotfix for the service in the twelve months before the event giving rise to the claim."
      />
      <LegalSection
        title="Indemnity and termination"
        body="You agree to indemnify and hold harmless Hotfix from claims, damages, losses, and expenses arising from your use of the service, your data, your code, or your violation of these terms. Hotfix may suspend or terminate access at any time, with or without notice."
      />
    </article>
  );
}

function PrivacyPage() {
  return (
    <article class="space-y-8 rounded-[4px] bg-[var(--surface)] px-6 py-6 text-[0.94rem] leading-7 text-[var(--text-secondary)] sm:px-8">
      <div class="space-y-3">
        <a
          class="inline-flex items-center text-[0.75rem] uppercase tracking-[0.24em] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          href="/"
        >
          Back
        </a>
        <div class="space-y-2">
          <p class="text-[0.72rem] font-medium uppercase tracking-[0.28em] text-[var(--text-muted)]">
            Privacy Policy
          </p>
          <h1 class="text-[1.7rem] font-medium tracking-[-0.04em] text-[var(--text-primary)] sm:text-[2rem]">
            Privacy for Hotfix
          </h1>
          <p>Effective April 1, 2026</p>
        </div>
      </div>

      <LegalSection
        title="Information we collect"
        body="Hotfix may collect the account details you provide directly or through sign-in providers such as GitHub and Sentry, including display name, username, email address, avatar URL, and provider account identifiers. We also use session cookies and may collect basic technical logs needed to operate, secure, and debug the service."
      />
      <LegalSection
        title="How we use information"
        body="We use information to authenticate you, maintain your session, operate the product, prevent abuse, investigate incidents, improve reliability, and communicate about the service."
      />
      <LegalSection
        title="Sharing"
        body="We may share information with infrastructure providers, analytics or security vendors, authentication providers, professional advisors, or government authorities when reasonably necessary to operate the service, enforce our terms, comply with law, or protect rights, safety, and security."
      />
      <LegalSection
        title="Retention and security"
        body="We retain information for as long as reasonably necessary for the purposes described above, including security, compliance, dispute resolution, and recordkeeping. No method of storage, transmission, or authentication is completely secure, and we cannot guarantee absolute security."
      />
      <LegalSection
        title="Your choices"
        body="You may stop using the service at any time. If you want account or data deletion, contact the operator of the service. Some information may be retained where reasonably necessary for security, fraud prevention, legal compliance, or backup integrity."
      />
      <LegalSection
        title="Policy changes"
        body="We may update this policy from time to time. Continued use of the service after an updated policy becomes effective means you accept the revised policy."
      />
    </article>
  );
}

function LoginPanel(props: { notice: string | null }) {
  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "s") {
        window.location.assign("/api/auth/sentry/start");
      } else if (key === "g") {
        window.location.assign("/api/auth/github/start");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
    });
  });

  return (
    <div class="space-y-7">
      <div class="space-y-1">
        <h1 class="text-[1.65rem] font-medium tracking-[-0.04em] text-[var(--text-primary)] sm:text-[1.9rem]">
          Welcome to hotfix
        </h1>
        <p class="text-base text-[var(--text-secondary)]">Build performant, bug-free software</p>
      </div>

      <div class="space-y-3">
        <ProviderButton
          href="/api/auth/sentry/start"
          label="Continue with Sentry"
          iconSrc={sentryIcon}
          shortcut="S"
        />
        <ProviderButton
          href="/api/auth/github/start"
          label="Continue with GitHub"
          iconSrc={githubIcon}
          shortcut="G"
        />
      </div>

      <Show when={props.notice}>
        {(message) => (
          <p class="rounded-[4px] border border-[rgba(229,99,99,0.18)] bg-[rgba(71,24,24,0.35)] px-4 py-3 text-sm text-[rgba(255,197,197,0.94)]">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
}

function AuthenticatedPanel(props: {
  user: AuthenticatedUser;
  notice: string | null;
  loggingOut: boolean;
  onLogout: () => Promise<void>;
}) {
  const [activeProjectSection, setActiveProjectSection] = createSignal<ProjectRouteSection>(
    getProjectRoute(window.location.pathname).section,
  );
  const [showSidebarShortcuts, setShowSidebarShortcuts] = createSignal(false);
  const [projectNavigationVisible, setProjectNavigationVisible] = createSignal(
    Boolean(getProjectRoute(window.location.pathname).slug),
  );
  const projectTabs: Array<{ id: ProjectRouteSection; label: string; shortcut: string }> = [
    { id: "home", label: "Home", shortcut: "1" },
    { id: "logs", label: "Logs", shortcut: "2" },
    { id: "incidents", label: "Incidents", shortcut: "3" },
    { id: "performance", label: "Performance", shortcut: "4" },
    { id: "settings", label: "Settings", shortcut: "5" },
  ];

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "Control" || event.ctrlKey) && projectNavigationVisible()) {
        setShowSidebarShortcuts(true);
      }

      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (!projectNavigationVisible()) {
        return;
      }

      const nextProjectTab = projectTabs.find((tab) => tab.shortcut === event.key);
      if (!nextProjectTab) {
        return;
      }

      event.preventDefault();
      setActiveProjectSection(nextProjectTab.id);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!event.ctrlKey) {
        setShowSidebarShortcuts(false);
      }
    };

    const handleWindowBlur = () => {
      setShowSidebarShortcuts(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    });
  });

  return (
    <section class="logged-in-shell flex w-full flex-1">
      <Show when={projectNavigationVisible()}>
        <aside class="app-sidebar is-collapsed is-project-sidebar">
          <nav class="app-sidebar-nav" aria-label="Project sections">
            <For each={projectTabs}>
              {(tab) => (
                <button
                  class="app-sidebar-item show-shortcut"
                  classList={{
                    "is-active": activeProjectSection() === tab.id,
                    "show-shortcut": showSidebarShortcuts(),
                  }}
                  type="button"
                  onClick={() => setActiveProjectSection(tab.id)}
                  aria-pressed={activeProjectSection() === tab.id}
                  aria-label={tab.label}
                >
                  <SidebarIcon tab={tab.id} />
                  <span class="app-sidebar-label">{tab.label}</span>
                  <span class="app-sidebar-shortcut" aria-hidden="true">
                    ^{tab.shortcut}
                  </span>
                  <span class="app-sidebar-tooltip" aria-hidden="true">
                    <span class="app-sidebar-tooltip-label">{tab.label}</span>
                    <span class="app-sidebar-tooltip-shortcut">^{tab.shortcut}</span>
                  </span>
                </button>
              )}
            </For>
          </nav>
        </aside>
      </Show>

      <div class="logged-in-main">
        <div class="logged-in-panel" classList={{ "is-project-open": projectNavigationVisible() }}>
          <ProjectsTab
            user={props.user}
            notice={props.notice}
            loggingOut={props.loggingOut}
            onLogout={props.onLogout}
            projectSection={activeProjectSection()}
            onProjectSectionChange={setActiveProjectSection}
            onProjectOpenChange={setProjectNavigationVisible}
          />
        </div>
      </div>
    </section>
  );
}

function ProjectsTab(props: {
  user: AuthenticatedUser;
  notice: string | null;
  loggingOut: boolean;
  onLogout: () => Promise<void>;
  projectSection: ProjectRouteSection;
  onProjectSectionChange: (section: ProjectRouteSection) => void;
  onProjectOpenChange: (open: boolean) => void;
}) {
  const [sortBy, setSortBy] = createSignal<ProjectsSort>("created");
  const [viewMode, setViewMode] = createSignal<ProjectsView>("list");
  const [createModalOpen, setCreateModalOpen] = createSignal(false);
  const [settingsModalOpen, setSettingsModalOpen] = createSignal(false);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [projectMenuOpenId, setProjectMenuOpenId] = createSignal<string | null>(null);
  const [renameModalProjectId, setRenameModalProjectId] = createSignal<string | null>(null);
  const [renameProjectName, setRenameProjectName] = createSignal("");
  const [renameModalError, setRenameModalError] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  const [deleteModalProjectId, setDeleteModalProjectId] = createSignal<string | null>(null);
  const [deleteConfirmationValue, setDeleteConfirmationValue] = createSignal("");
  const [deleteModalError, setDeleteModalError] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [projectName, setProjectName] = createSignal("");
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null);
  const [openedProjectId, setOpenedProjectId] = createSignal<string | null>(null);
  const [navigatingToProjectList, setNavigatingToProjectList] = createSignal(false);
  const [routeProject, setRouteProject] = createSignal<ProjectRouteState>(
    typeof window === "undefined"
      ? { slug: null, section: "home" }
      : getProjectRoute(window.location.pathname),
  );
  const [createError, setCreateError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [dashboard, { refetch, mutate }] = createResource(
    () => "dashboard",
    async () => fetchDashboard(),
  );
  const [tableFillerRows, setTableFillerRows] = createSignal(0);
  let tableWrapRef: HTMLDivElement | undefined;

  const sentryOrganizations = createMemo(() => dashboard()?.sentryOrganizations ?? []);
  const canCreateProject = createMemo(() => projectName().trim().length > 0 && !creating());
  const sortedProjects = createMemo(() => {
    const projects = [...(dashboard()?.projects ?? [])];

    switch (sortBy()) {
      case "alphabetical":
        projects.sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
        );
        break;
      case "items":
        projects.sort((left, right) => right.itemsCount - left.itemsCount);
        break;
      case "incidents":
        projects.sort((left, right) => right.incidentCount - left.incidentCount);
        break;
      case "lastActivity":
        projects.sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
        break;
      case "indexing":
        projects.sort((left, right) => {
          const byRank =
            getIndexingSortRank(left.indexingStatus) - getIndexingSortRank(right.indexingStatus);
          if (byRank !== 0) {
            return byRank;
          }

          return right.indexingPercentage - left.indexingPercentage;
        });
        break;
      case "created":
      default:
        projects.sort(
          (left, right) =>
            getProjectCreatedAtTimestamp(right.createdAt) -
            getProjectCreatedAtTimestamp(left.createdAt),
        );
        break;
    }

    return projects;
  });
  const updateTableFillerRows = () => {
    if (typeof window === "undefined") {
      return;
    }

    if (viewMode() !== "list") {
      setTableFillerRows(0);
      return;
    }

    const tableWrap = tableWrapRef;
    if (!tableWrap) {
      setTableFillerRows(0);
      return;
    }

    const rect = tableWrap.getBoundingClientRect();
    const remainingHeight = Math.max(0, window.innerHeight - rect.top - 40);
    const rowHeight = 32;
    const headerHeight = 26;
    const visibleRows = Math.max(0, Math.floor((remainingHeight - headerHeight) / rowHeight));
    const fillerCount = Math.max(0, visibleRows - sortedProjects().length - 3);
    setTableFillerRows(Math.min(fillerCount, 24));
  };
  const selectedProject = createMemo(
    () => sortedProjects().find((project) => project.id === selectedProjectId()) ?? null,
  );
  const openedProject = createMemo(
    () => sortedProjects().find((project) => project.id === openedProjectId()) ?? null,
  );
  const renameModalProject = createMemo(
    () => sortedProjects().find((project) => project.id === renameModalProjectId()) ?? null,
  );
  const deleteModalProject = createMemo(
    () => sortedProjects().find((project) => project.id === deleteModalProjectId()) ?? null,
  );
  const canConfirmDelete = createMemo(
    () =>
      Boolean(deleteModalProject()) &&
      deleteConfirmationValue().trim() === deleteModalProject()!.name &&
      !deleting(),
  );

  const openCreateModal = () => {
    setProjectName("");
    setCreateError(null);
    setAccountMenuOpen(false);
    setProjectMenuOpenId(null);
    setCreateModalOpen(true);
  };

  const openRenameModal = (project: HotfixProject) => {
    setProjectMenuOpenId(null);
    setRenameModalProjectId(project.id);
    setRenameProjectName(project.name);
    setRenameModalError(null);
  };

  const closeRenameModal = () => {
    if (renaming()) {
      return;
    }

    setRenameModalProjectId(null);
    setRenameProjectName("");
    setRenameModalError(null);
  };

  const openDeleteModal = (project: HotfixProject) => {
    setProjectMenuOpenId(null);
    setDeleteModalProjectId(project.id);
    setDeleteConfirmationValue("");
    setDeleteModalError(null);
  };

  const closeDeleteModal = () => {
    if (deleting()) {
      return;
    }

    setDeleteModalProjectId(null);
    setDeleteConfirmationValue("");
    setDeleteModalError(null);
  };

  const syncProjectUrl = (
    slug: string | null,
    section: ProjectRouteSection,
    mode: "push" | "replace" = "push",
  ) => {
    if (typeof window === "undefined") {
      return;
    }

    const nextPath = getProjectPath(slug, section);
    if (window.location.pathname !== nextPath) {
      if (mode === "replace") {
        window.history.replaceState({}, "", nextPath);
      } else {
        window.history.pushState({}, "", nextPath);
      }
    }

    setRouteProject({ slug, section });
  };

  const closeCreateModal = () => {
    if (creating()) {
      return;
    }

    setCreateModalOpen(false);
    setCreateError(null);
  };

  const openProject = (projectId: string, section: ProjectRouteSection = "home") => {
    const project = sortedProjects().find((item) => item.id === projectId);
    if (!project) {
      return;
    }

    setAccountMenuOpen(false);
    setSelectedProjectId(projectId);
    setOpenedProjectId(projectId);
    syncProjectUrl(project.slug, section);
  };

  const closeProject = (mode: "push" | "replace" = "push") => {
    setNavigatingToProjectList(true);
    setOpenedProjectId(null);
    syncProjectUrl(null, "home", mode);
    queueMicrotask(() => setNavigatingToProjectList(false));
  };

  const goToProjects = () => closeProject("push");
  const resetToProjects = () => {
    setAccountMenuOpen(false);
    closeProject("replace");
  };

  const moveProjectSelection = (direction: number) => {
    const projects = sortedProjects();
    if (!projects.length) {
      return;
    }

    const currentIndex = projects.findIndex((project) => project.id === selectedProjectId());
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + direction + projects.length) % projects.length;
    const nextProject = projects[nextIndex];
    if (!nextProject) {
      return;
    }

    setSelectedProjectId(nextProject.id);
  };

  createEffect(() => {
    const projects = sortedProjects();

    if (!projects.length) {
      setSelectedProjectId(null);
      setOpenedProjectId(null);
      if (routeProject().slug && !dashboard.loading) {
        syncProjectUrl(null, "home", "replace");
      }
      return;
    }

    if (!projects.some((project) => project.id === selectedProjectId())) {
      setSelectedProjectId(projects[0]?.id ?? null);
    }

    if (openedProjectId() && !projects.some((project) => project.id === openedProjectId())) {
      setOpenedProjectId(null);
    }
  });

  createEffect(() => {
    sortedProjects();
    viewMode();
    queueMicrotask(updateTableFillerRows);
  });

  createEffect(() => {
    const route = routeProject();
    const projects = sortedProjects();

    if (!route.slug) {
      if (openedProjectId()) {
        setOpenedProjectId(null);
      }
      props.onProjectSectionChange("home");
      return;
    }

    if (navigatingToProjectList()) {
      return;
    }

    const project = projects.find((item) => item.slug === route.slug);
    if (project) {
      if (selectedProjectId() !== project.id) {
        setSelectedProjectId(project.id);
      }
      if (openedProjectId() !== project.id) {
        setOpenedProjectId(project.id);
      }
      props.onProjectSectionChange(route.section);
      return;
    }

    if (!dashboard.loading) {
      setOpenedProjectId(null);
      syncProjectUrl(null, "home", "replace");
      props.onProjectSectionChange("home");
    }
  });

  createEffect(() => {
    const openProjectId = openedProjectId();
    if (!openProjectId) {
      return;
    }

    const project = openedProject();
    if (!project) {
      return;
    }

    const route = routeProject();
    if (route.slug !== project.slug || route.section !== props.projectSection) {
      syncProjectUrl(project.slug, props.projectSection, "push");
    }
  });

  createEffect(() => {
    props.onProjectOpenChange(Boolean(openedProjectId()));
  });

  onCleanup(() => {
    props.onProjectOpenChange(false);
  });

  onMount(() => {
    const handlePopState = () => {
      setRouteProject(getProjectRoute(window.location.pathname));
    };

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("[data-projects-account-menu]") ||
          target.closest("[data-project-action-menu]"))
      ) {
        return;
      }

      setAccountMenuOpen(false);
      setProjectMenuOpenId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        createModalOpen() ||
        settingsModalOpen() ||
        renameModalProjectId() ||
        deleteModalProjectId()
      ) {
        return;
      }

      if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (openedProject()) {
        if (key === "b") {
          event.preventDefault();
          goToProjects();
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          goToProjects();
        }
        return;
      }

      if (key === "n") {
        event.preventDefault();
        openCreateModal();
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        moveProjectSelection(1);
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        moveProjectSelection(-1);
        return;
      }

      if (event.key === "Enter" && selectedProject()) {
        event.preventDefault();
        openProject(selectedProject()!.id);
      }
    };

    const handleResize = () => {
      updateTableFillerRows();
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    updateTableFillerRows();
    onCleanup(() => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    });
  });

  createEffect(() => {
    if (
      !createModalOpen() &&
      !settingsModalOpen() &&
      !renameModalProjectId() &&
      !deleteModalProjectId()
    ) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (createModalOpen()) {
          closeCreateModal();
          return;
        }

        if (renameModalProjectId()) {
          closeRenameModal();
          return;
        }

        if (deleteModalProjectId()) {
          closeDeleteModal();
          return;
        }

        setSettingsModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown);
    });
  });

  const createProject = async (event: SubmitEvent) => {
    event.preventDefault();
    const trimmedName = projectName().trim();

    if (!trimmedName) {
      setCreateError("Enter a project name.");
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const project = await fetchJson<HotfixProject>("/api/hotfix-projects", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: trimmedName,
        }),
      });

      setCreateModalOpen(false);
      setProjectName("");
      setSelectedProjectId(project.id);
      resetToProjects();
      await refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create the project.";
      setCreateError(message);
      await refetch();
    } finally {
      setCreating(false);
    }
  };

  const renameProject = async (projectId: string, nextName: string) => {
    const trimmedName = nextName.trim();
    if (!trimmedName) {
      throw new Error("Project name cannot be empty.");
    }

    const previousDashboard = dashboard();
    mutate((payload) =>
      payload
        ? {
            ...payload,
            projects: payload.projects.map((project) =>
              project.id === projectId ? { ...project, name: trimmedName } : project,
            ),
          }
        : payload,
    );

    try {
      const updatedProject = await fetchJson<HotfixProject>(`/api/hotfix-projects/${projectId}`, {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: trimmedName,
        }),
      });

      mutate((payload) =>
        payload
          ? {
              ...payload,
              projects: payload.projects.map((project) =>
                project.id === updatedProject.id ? updatedProject : project,
              ),
            }
          : payload,
      );

      if (openedProjectId() === projectId) {
        syncProjectUrl(updatedProject.slug, props.projectSection, "replace");
      }
    } catch (error) {
      mutate(previousDashboard);
      throw error;
    }
  };

  const submitRenameModal = async (event: SubmitEvent) => {
    event.preventDefault();
    const project = renameModalProject();
    if (!project) {
      return;
    }

    const trimmedName = renameProjectName().trim();
    if (!trimmedName) {
      setRenameModalError("Project name cannot be empty.");
      return;
    }

    setRenaming(true);
    setRenameModalError(null);

    try {
      await renameProject(project.id, trimmedName);
      setRenameModalProjectId(null);
      setRenameProjectName("");
      setRenameModalError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not rename the project.";
      setRenameModalError(message);
    } finally {
      setRenaming(false);
    }
  };

  const deleteProject = async (projectId: string) => {
    const previousDashboard = dashboard();

    mutate((payload) =>
      payload
        ? {
            ...payload,
            projects: payload.projects.filter((project) => project.id !== projectId),
          }
        : payload,
    );

    try {
      const response = await fetch(`/api/hotfix-projects/${projectId}`, {
        method: "DELETE",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not delete the project.");
      }
    } catch (error) {
      mutate(previousDashboard);
      throw error;
    }
  };

  const submitDeleteModal = async (event: SubmitEvent) => {
    event.preventDefault();
    const project = deleteModalProject();
    if (!project) {
      return;
    }

    if (deleteConfirmationValue().trim() !== project.name) {
      setDeleteModalError("Type the full project name to confirm deletion.");
      return;
    }

    setDeleting(true);
    setDeleteModalError(null);

    try {
      await deleteProject(project.id);
      if (selectedProjectId() === project.id) {
        setSelectedProjectId(null);
      }
      setDeleteModalProjectId(null);
      setDeleteConfirmationValue("");
      setDeleteModalError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete the project.";
      setDeleteModalError(message);
    } finally {
      setDeleting(false);
    }
  };

  const updateSentryProjectSelection = async (projectId: string, includedProjectIds: string[]) => {
    const previousDashboard = dashboard();

    mutate((payload) =>
      payload
        ? {
            ...payload,
            projects: payload.projects.map((project) =>
              project.id === projectId
                ? {
                    ...project,
                    sentryProjects: project.sentryProjects.map((sentryProject) => ({
                      ...sentryProject,
                      included: includedProjectIds.includes(sentryProject.id),
                    })),
                  }
                : project,
            ),
          }
        : payload,
    );

    try {
      const updatedProject = await fetchJson<HotfixProject>(
        `/api/hotfix-projects/${projectId}/sentry-project-selection`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            includedProjectIds,
          }),
        },
      );

      mutate((payload) =>
        payload
          ? {
              ...payload,
              projects: payload.projects.map((project) =>
                project.id === updatedProject.id ? updatedProject : project,
              ),
            }
          : payload,
      );
    } catch (error) {
      mutate(previousDashboard);
      throw error;
    }
  };

  const refreshSentryProjects = async (projectId: string) => {
    const updatedProject = await fetchJson<HotfixProject>(
      `/api/hotfix-projects/${projectId}/refresh-sentry-projects`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      },
    );

    mutate((payload) =>
      payload
        ? {
            ...payload,
            projects: payload.projects.map((project) =>
              project.id === updatedProject.id ? updatedProject : project,
            ),
          }
        : payload,
    );

    return updatedProject;
  };

  const assignSentryConnection = async (projectId: string, connectionId: string) => {
    const updatedProject = await fetchJson<HotfixProject>(
      `/api/hotfix-projects/${projectId}/sentry-connection`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connectionId,
        }),
      },
    );

    mutate((payload) =>
      payload
        ? {
            ...payload,
            projects: payload.projects.map((project) =>
              project.id === updatedProject.id ? updatedProject : project,
            ),
          }
        : payload,
    );

    return updatedProject;
  };

  return (
    <div class="projects-shell">
      <Show
        when={!dashboard.error}
        fallback={
          <div class="projects-error-state">
            <FeedbackPanel
              eyebrow="Projects"
              title="Project data is unavailable"
              message="Hotfix could not load your projects right now."
              actionLabel="Retry"
              onAction={() => void refetch()}
            />
          </div>
        }
      >
        <Show
          when={!dashboard.loading}
          fallback={
            <Show
              when={!routeProject().slug}
              fallback={<ProjectWorkspaceSkeleton activeSection={routeProject().section} />}
            >
              <ProjectsHomeSkeleton viewMode={viewMode()} />
            </Show>
          }
        >
          <Show when={openedProject()}>
            {(project) => (
              <ProjectWorkspace
                activeSection={props.projectSection}
                project={project()}
                sentryOrganizations={sentryOrganizations()}
                onBack={goToProjects}
                onAssignSentryConnection={assignSentryConnection}
                onRefreshSentryProjects={refreshSentryProjects}
                onRename={renameProject}
                onUpdateSentryProjectSelection={updateSentryProjectSelection}
              />
            )}
          </Show>
          <Show when={!openedProject()}>
            <div class="projects-home-surface">
              <div class="projects-guide-frame">
              <div class="projects-header-block">
                <div class="projects-header">
                  <div class="projects-header-copy">
                    <h1 class="projects-title">Hotfix</h1>
                    <p class="projects-subtitle">
                      Map the repos, services, and telemetry behind your software.
                    </p>
                  </div>

                  <div class="projects-header-actions">
                    <div class="projects-view-toggle" role="tablist" aria-label="Project layout">
                      <button
                        class="projects-view-button"
                        classList={{ "is-active": viewMode() === "grid" }}
                        type="button"
                        role="tab"
                        aria-selected={viewMode() === "grid"}
                        title="Grid view"
                        onClick={() => setViewMode("grid")}
                      >
                        <ViewModeIcon mode="grid" />
                      </button>
                      <button
                        class="projects-view-button"
                        classList={{ "is-active": viewMode() === "list" }}
                        type="button"
                        role="tab"
                        aria-selected={viewMode() === "list"}
                        title="List view"
                        onClick={() => setViewMode("list")}
                      >
                        <ViewModeIcon mode="list" />
                      </button>
                    </div>

                    <button
                      class="brand-button is-inverted projects-new-button"
                      type="button"
                      onClick={openCreateModal}
                      disabled={dashboard.loading}
                    >
                      <span class="brand-button-plus" aria-hidden="true">
                        +
                      </span>
                      <span>New project</span>
                      <span class="brand-button-shortcut" aria-hidden="true">
                        N
                      </span>
                    </button>

                    <div class="projects-account-menu" data-projects-account-menu>
                      <button
                        class="projects-account-trigger"
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={accountMenuOpen()}
                        onClick={() => setAccountMenuOpen((open) => !open)}
                      >
                        <UserAvatar user={props.user} />
                      </button>

                      <Show when={accountMenuOpen()}>
                        <div class="projects-account-popover" role="menu">
                          <div class="projects-account-popover-copy">
                            <p class="projects-account-popover-name">{props.user.displayName}</p>
                            <p class="projects-account-popover-email">
                              {props.user.email ?? "Signed in"}
                            </p>
                          </div>
                          <button
                            class="projects-account-popover-item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAccountMenuOpen(false);
                              setSettingsModalOpen(true);
                            }}
                          >
                            Settings
                          </button>
                          <button
                            class="projects-account-popover-item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAccountMenuOpen(false);
                              void props.onLogout();
                            }}
                            disabled={props.loggingOut}
                          >
                            {props.loggingOut ? "Logging out..." : "Log out"}
                          </button>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </div>

              <Show
                when={sortedProjects().length > 0}
                fallback={
                  <div class="projects-empty-frame">
                    <div class="projects-empty-state">
                      <div class="projects-empty-illustration" aria-hidden="true">
                        <svg viewBox="0 0 80 80" fill="none">
                          <rect
                            x="18"
                            y="16"
                            width="44"
                            height="48"
                            rx="4"
                            fill="rgba(255,255,255,0.03)"
                          />
                          <path
                            d="M29 27h22M29 35h16"
                            stroke="rgba(242,238,227,0.34)"
                            stroke-width="2"
                            stroke-linecap="round"
                          />
                          <path
                            d="M26 52.5c4.2-5.2 8.9-7.8 14.2-7.8 5.4 0 9.9 2.6 13.8 7.8"
                            stroke="url(#empty-graph-stroke)"
                            stroke-width="3"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                          <circle cx="40.5" cy="22" r="12.5" fill="rgba(127,220,255,0.08)" />
                          <path
                            d="M35 22.2h4.2l2.8-4.7 3.6 9.1 2.4-4.4H52"
                            stroke="url(#empty-graph-stroke)"
                            stroke-width="2.4"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                          <defs>
                            <linearGradient
                              id="empty-graph-stroke"
                              x1="24"
                              y1="54"
                              x2="55"
                              y2="18"
                              gradientUnits="userSpaceOnUse"
                            >
                              <stop stop-color="rgba(70,136,220,0.78)" />
                              <stop offset="0.56" stop-color="rgba(127,220,255,0.9)" />
                              <stop offset="1" stop-color="#a4f0ff" />
                            </linearGradient>
                          </defs>
                        </svg>
                      </div>
                      <p class="projects-empty-title">No projects yet</p>
                      <p class="projects-empty-copy">
                        Create a blank project, then add repo-backed items to the canvas and
                        optionally attach specific Sentry projects later.
                      </p>
                    </div>
                  </div>
                }
              >
                <Show
                  when={viewMode() === "grid"}
                  fallback={
                    <div class="projects-table-frame">
                      <div class="projects-table-wrap" ref={tableWrapRef}>
                        <table class="projects-table">
                          <colgroup>
                            <col class="projects-table-col projects-table-col--index" />
                            <col class="projects-table-col projects-table-col--name" />
                            <col class="projects-table-col projects-table-col--health" />
                            <col class="projects-table-col projects-table-col--indexing" />
                            <col class="projects-table-col projects-table-col--incidents" />
                            <col class="projects-table-col projects-table-col--last-activity" />
                            <col class="projects-table-col projects-table-col--created" />
                            <col class="projects-table-col projects-table-col--activity" />
                            <col class="projects-table-col projects-table-col--actions" />
                          </colgroup>
                            <thead>
                              <tr class="projects-table-header">
                                <th scope="col">
                                  <div class="projects-table-header-label projects-table-header-label--index">
                                    #
                                  </div>
                                </th>
                              <th scope="col">
                                <button
                                  class="projects-table-header-button"
                                  classList={{ "is-active": sortBy() === "alphabetical" }}
                                  type="button"
                                  onClick={() => setSortBy("alphabetical")}
                                >
                                  <span>Name</span>
                                </button>
                              </th>
                                <th scope="col">
                                  <div class="projects-table-header-label">Health</div>
                                </th>
                              <th scope="col">
                                <button
                                  class="projects-table-header-button"
                                  classList={{ "is-active": sortBy() === "indexing" }}
                                  type="button"
                                  onClick={() => setSortBy("indexing")}
                                >
                                  <span>Indexing</span>
                                </button>
                              </th>
                              <th scope="col">
                                <button
                                  class="projects-table-header-button"
                                  classList={{ "is-active": sortBy() === "incidents" }}
                                  type="button"
                                  onClick={() => setSortBy("incidents")}
                                >
                                  <span>Incidents</span>
                                </button>
                              </th>
                              <th scope="col">
                                <button
                                  class="projects-table-header-button"
                                  classList={{ "is-active": sortBy() === "lastActivity" }}
                                  type="button"
                                  onClick={() => setSortBy("lastActivity")}
                                >
                                  <span>Last activity</span>
                                </button>
                              </th>
                              <th scope="col">
                                <button
                                  class="projects-table-header-button"
                                  classList={{ "is-active": sortBy() === "created" }}
                                  type="button"
                                  onClick={() => setSortBy("created")}
                                >
                                  <span>Created at</span>
                                </button>
                              </th>
                                <th scope="col">
                                  <div class="projects-table-header-label">Activity</div>
                                </th>
                                <th scope="col" aria-hidden="true">
                                  <div class="projects-table-header-spacer" />
                                </th>
                              </tr>
                            </thead>

                          <tbody class="projects-table-body">
                            <For each={sortedProjects()}>
                              {(project, index) => (
                                <tr
                                  class="projects-table-row"
                                  classList={{
                                    "is-selected": selectedProjectId() === project.id,
                                  }}
                                  aria-selected={selectedProjectId() === project.id}
                                  tabIndex={0}
                                  onMouseEnter={() => setSelectedProjectId(project.id)}
                                  onFocus={() => setSelectedProjectId(project.id)}
                                  onClick={() => openProject(project.id)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      openProject(project.id);
                                    }
                                  }}
                                >
                                  <td class="projects-table-cell projects-table-cell--index">
                                    <p class="project-card-meta">{index() + 1}</p>
                                  </td>
                                  <td class="projects-table-cell projects-table-cell--name">
                                    <div class="project-card-title-row">
                                      <h2 class="project-card-title">{project.name}</h2>
                                      <div class="project-connection-icons">
                                        <Show when={project.githubConnected}>
                                          <img
                                            class="project-connection-icon"
                                            src={githubIcon}
                                            alt="GitHub connected"
                                            title="GitHub connected"
                                          />
                                        </Show>
                                        <Show when={project.sentryConnected}>
                                          <img
                                            class="project-connection-icon"
                                            src={sentryIcon}
                                            alt="Sentry connected"
                                            title="Sentry connected"
                                          />
                                        </Show>
                                      </div>
                                    </div>
                                  </td>
                                  <td class="projects-table-cell projects-table-cell--health">
                                    {(() => {
                                      const health = getProjectHealth(project);
                                      return (
                                        <span class={`project-health-chip is-${health.tone}`}>
                                          {health.label}
                                        </span>
                                      );
                                    })()}
                                  </td>
                                  <td class="projects-table-cell projects-table-cell--indexing">
                                    <p class="project-card-meta">
                                      {formatIndexingStatus(
                                        project.indexingStatus,
                                        project.indexingPercentage,
                                      )}
                                    </p>
                                  </td>
                                  <td class="projects-table-cell projects-table-cell--incidents">
                                    <p class="project-card-meta">{project.incidentCount}</p>
                                  </td>
                                  <td class="projects-table-cell projects-table-cell--last-activity">
                                    <p class="project-card-meta">
                                      {formatProjectLastActivity(project.lastActivityAt)}
                                    </p>
                                  </td>
                                  <td class="projects-table-cell projects-table-cell--created">
                                    <p class="project-card-meta">
                                      {formatProjectDate(project.createdAt)}
                                    </p>
                                  </td>
                                  <td class="projects-table-cell projects-table-cell--activity">
                                    <div class="project-card-stats is-inline">
                                      <ProjectSparkline
                                        seed={`${project.id}:${project.name}`}
                                        compact={true}
                                      />
                                    </div>
                                  </td>
                                  <td
                                    class="projects-table-cell projects-table-cell--actions"
                                    data-project-action-menu
                                  >
                                    <div class="project-card-menu">
                                      <button
                                        class="project-card-menu-trigger"
                                        type="button"
                                        aria-haspopup="menu"
                                        aria-expanded={projectMenuOpenId() === project.id}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setProjectMenuOpenId((current) =>
                                            current === project.id ? null : project.id,
                                          );
                                        }}
                                      >
                                        <span />
                                        <span />
                                        <span />
                                      </button>

                                      <Show when={projectMenuOpenId() === project.id}>
                                        <div class="project-card-popover" role="menu">
                                          <button
                                            class="project-card-popover-item"
                                            type="button"
                                            role="menuitem"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              openRenameModal(project);
                                            }}
                                          >
                                            Rename
                                          </button>
                                          <button
                                            class="project-card-popover-item is-danger"
                                            type="button"
                                            role="menuitem"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              openDeleteModal(project);
                                            }}
                                          >
                                            Delete project
                                          </button>
                                        </div>
                                      </Show>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </For>
                            <For each={Array.from({ length: tableFillerRows() }, (_, index) => index)}>
                              {(index) => (
                                <tr
                                  class="projects-table-row is-filler"
                                  aria-hidden="true"
                                  style={{
                                    "--filler-opacity": `${Math.max(
                                      0,
                                      1 - (index + 1) / Math.max(tableFillerRows(), 1),
                                    )}`,
                                  }}
                                >
                                  <td class="projects-table-cell projects-table-cell--index" />
                                  <td class="projects-table-cell projects-table-cell--name" />
                                  <td class="projects-table-cell projects-table-cell--health" />
                                  <td class="projects-table-cell projects-table-cell--indexing" />
                                  <td class="projects-table-cell projects-table-cell--incidents" />
                                  <td class="projects-table-cell projects-table-cell--last-activity" />
                                  <td class="projects-table-cell projects-table-cell--created" />
                                  <td class="projects-table-cell projects-table-cell--activity" />
                                  <td class="projects-table-cell projects-table-cell--actions" />
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  }
                >
                  <div class="projects-grid-frame">
                    <div class="projects-collection is-grid">
                    <For each={sortedProjects()}>
                      {(project) => (
                        <article
                          class="project-card is-grid"
                          classList={{
                            "is-selected": selectedProjectId() === project.id,
                          }}
                          aria-selected={selectedProjectId() === project.id}
                          onMouseEnter={() => setSelectedProjectId(project.id)}
                        >
                          <button
                            class="project-card-main"
                            type="button"
                            onFocus={() => setSelectedProjectId(project.id)}
                            onClick={() => openProject(project.id)}
                          >
                            <div class="project-card-copy">
                              <h2 class="project-card-title">{project.name}</h2>
                              <p class="project-card-meta">
                                {formatProjectDate(project.createdAt)}
                              </p>
                            </div>

                            <div class="project-card-stats">
                              <ProjectSparkline
                                seed={`${project.id}:${project.name}`}
                                compact={false}
                              />
                            </div>
                          </button>

                          <div class="project-card-menu" data-project-action-menu>
                            <button
                              class="project-card-menu-trigger"
                              type="button"
                              aria-haspopup="menu"
                              aria-expanded={projectMenuOpenId() === project.id}
                              onClick={() =>
                                setProjectMenuOpenId((current) =>
                                  current === project.id ? null : project.id,
                                )
                              }
                            >
                              <span />
                              <span />
                              <span />
                            </button>

                            <Show when={projectMenuOpenId() === project.id}>
                              <div class="project-card-popover" role="menu">
                                <button
                                  class="project-card-popover-item"
                                  type="button"
                                  role="menuitem"
                                  onClick={() => openRenameModal(project)}
                                >
                                  Rename
                                </button>
                                <button
                                  class="project-card-popover-item is-danger"
                                  type="button"
                                  role="menuitem"
                                  onClick={() => openDeleteModal(project)}
                                >
                                  Delete project
                                </button>
                              </div>
                            </Show>
                          </div>
                        </article>
                      )}
                    </For>
                    </div>
                  </div>
                </Show>
              </Show>
              </div>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={createModalOpen()}>
        <div class="project-modal-backdrop" role="presentation" onClick={() => closeCreateModal()}>
          <div
            class="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-project-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="project-modal-header">
              <div>
                <h2 id="create-project-title" class="project-modal-title">
                  Make a new project
                </h2>
              </div>
              <button
                class="project-modal-close"
                type="button"
                onClick={closeCreateModal}
                aria-label="Close"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <form class="project-modal-form" onSubmit={(event) => void createProject(event)}>
              <label class="project-field">
                <span class="project-field-label">Name</span>
                <input
                  class="project-field-input"
                  type="text"
                  name="name"
                  placeholder="Acme platform"
                  value={projectName()}
                  onInput={(event) => setProjectName(event.currentTarget.value)}
                  autocomplete="off"
                  maxlength={120}
                />
              </label>

              <label class="project-field">
                <span class="project-field-label">Start blank</span>
                <p class="project-field-helper">
                  You can connect Sentry later from project settings and attach specific Sentry
                  projects to canvas items as needed.
                </p>
              </label>

              <Show when={createError()}>
                {(message) => <p class="project-modal-error">{message()}</p>}
              </Show>

              <div class="project-modal-actions">
                <button class="project-modal-secondary" type="button" onClick={closeCreateModal}>
                  Cancel
                </button>
                <button class="brand-button" type="submit" disabled={!canCreateProject()}>
                  {creating() ? "Creating..." : "Create project"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>

      <Show when={renameModalProject()}>
        {(project) => (
          <div
            class="project-modal-backdrop"
            role="presentation"
            onClick={() => closeRenameModal()}
          >
            <div
              class="project-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="rename-project-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="project-modal-header">
                <div>
                  <h2 id="rename-project-title" class="project-modal-title">
                    Rename project
                  </h2>
                </div>
                <button
                  class="project-modal-close"
                  type="button"
                  onClick={closeRenameModal}
                  aria-label="Close"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>

              <form class="project-modal-form" onSubmit={(event) => void submitRenameModal(event)}>
                <label class="project-field">
                  <span class="project-field-label">Name</span>
                  <input
                    class="project-field-input"
                    type="text"
                    name="rename"
                    value={renameProjectName()}
                    onInput={(event) => setRenameProjectName(event.currentTarget.value)}
                    autocomplete="off"
                    maxlength={120}
                  />
                </label>

                <Show when={renameModalError()}>
                  {(message) => <p class="project-modal-error">{message()}</p>}
                </Show>

                <div class="project-modal-actions">
                  <button class="project-modal-secondary" type="button" onClick={closeRenameModal}>
                    Cancel
                  </button>
                  <button class="brand-button" type="submit" disabled={renaming()}>
                    {renaming() ? "Renaming..." : `Rename ${project().name}`}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </Show>

      <Show when={deleteModalProject()}>
        {(project) => (
          <div
            class="project-modal-backdrop"
            role="presentation"
            onClick={() => closeDeleteModal()}
          >
            <div
              class="project-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-project-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="project-modal-header">
                <div>
                  <h2 id="delete-project-title" class="project-modal-title">
                    Delete project
                  </h2>
                </div>
                <button
                  class="project-modal-close"
                  type="button"
                  onClick={closeDeleteModal}
                  aria-label="Close"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>

              <form class="project-modal-form" onSubmit={(event) => void submitDeleteModal(event)}>
                <p class="project-field-helper">
                  This deletes <strong>{project().name}</strong> and all of its linked canvas data,
                  incidents, and imported Sentry state. Type the full project name to confirm.
                </p>

                <label class="project-field">
                  <span class="project-field-label">Confirm project name</span>
                  <input
                    class="project-field-input"
                    type="text"
                    name="delete-confirmation"
                    value={deleteConfirmationValue()}
                    onInput={(event) => setDeleteConfirmationValue(event.currentTarget.value)}
                    autocomplete="off"
                    spellcheck={false}
                  />
                </label>

                <Show when={deleteModalError()}>
                  {(message) => <p class="project-modal-error">{message()}</p>}
                </Show>

                <div class="project-modal-actions">
                  <button class="project-modal-secondary" type="button" onClick={closeDeleteModal}>
                    Cancel
                  </button>
                  <button
                    class="brand-button brand-button-danger"
                    type="submit"
                    disabled={!canConfirmDelete()}
                  >
                    {deleting() ? "Deleting..." : "Delete project"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </Show>

      <Show when={settingsModalOpen()}>
        <AccountSettingsModal
          user={props.user}
          notice={props.notice}
          loggingOut={props.loggingOut}
          onClose={() => setSettingsModalOpen(false)}
          onLogout={props.onLogout}
        />
      </Show>
    </div>
  );
}

function ProjectsHomeSkeleton(props: { viewMode: ProjectsView }) {
  const skeletonRows = [0, 1, 2, 3, 4];
  const skeletonCards = [0, 1, 2];

  return (
    <div class="projects-home-surface is-skeleton" aria-hidden="true">
      <div class="projects-guide-frame">
      <div class="projects-header-block">
        <div class="projects-header">
          <div class="projects-header-copy">
            <div class="projects-skeleton-block projects-skeleton-title" />
            <div class="projects-skeleton-block projects-skeleton-subtitle" />
          </div>

          <div class="projects-header-actions">
            <div class="projects-view-toggle is-skeleton">
              <div class="projects-view-button is-skeleton" />
              <div class="projects-view-button is-skeleton" />
            </div>
            <div class="projects-skeleton-button projects-skeleton-button--new" />
            <div class="projects-skeleton-button projects-skeleton-button--avatar" />
          </div>
        </div>
      </div>

      <Show
        when={props.viewMode === "grid"}
        fallback={
          <div class="projects-table-frame is-skeleton">
            <div class="projects-table-wrap is-skeleton">
              <table class="projects-table">
                <colgroup>
                  <col class="projects-table-col projects-table-col--index" />
                  <col class="projects-table-col projects-table-col--name" />
                  <col class="projects-table-col projects-table-col--health" />
                  <col class="projects-table-col projects-table-col--indexing" />
                  <col class="projects-table-col projects-table-col--incidents" />
                  <col class="projects-table-col projects-table-col--last-activity" />
                  <col class="projects-table-col projects-table-col--created" />
                  <col class="projects-table-col projects-table-col--activity" />
                  <col class="projects-table-col projects-table-col--actions" />
                </colgroup>
                <thead>
                  <tr class="projects-table-header is-skeleton">
                    <th scope="col">
                      <div class="projects-table-header-label projects-table-header-label--index">
                        #
                      </div>
                    </th>
                    <th scope="col">
                      <div class="projects-table-header-label">Name</div>
                    </th>
                    <th scope="col">
                      <div class="projects-table-header-label">Health</div>
                    </th>
                    <th scope="col">
                      <div class="projects-table-header-label">Indexing</div>
                    </th>
                    <th scope="col">
                      <div class="projects-table-header-label">Incidents</div>
                    </th>
                    <th scope="col">
                      <div class="projects-table-header-label">Last activity</div>
                    </th>
                    <th scope="col">
                      <div class="projects-table-header-label">Created at</div>
                    </th>
                    <th scope="col">
                      <div class="projects-table-header-label">Activity</div>
                    </th>
                    <th scope="col" aria-hidden="true">
                      <div class="projects-table-header-spacer" />
                    </th>
                  </tr>
                </thead>
                <tbody class="projects-table-body is-skeleton">
                  <For each={skeletonRows}>
                    {() => (
                      <tr class="projects-table-row is-skeleton" aria-hidden="true">
                        <td class="projects-table-cell projects-table-cell--index">
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--tiny" />
                        </td>
                        <td class="projects-table-cell projects-table-cell--name">
                          <div class="project-card-title-row">
                            <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--name" />
                            <div class="projects-skeleton-inline-icons">
                              <span class="projects-skeleton-icon" />
                              <span class="projects-skeleton-icon" />
                            </div>
                          </div>
                        </td>
                        <td class="projects-table-cell projects-table-cell--health">
                          <div class="projects-skeleton-pill" />
                        </td>
                        <td class="projects-table-cell projects-table-cell--indexing">
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--medium" />
                        </td>
                        <td class="projects-table-cell projects-table-cell--incidents">
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--tiny" />
                        </td>
                        <td class="projects-table-cell projects-table-cell--last-activity">
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--medium" />
                        </td>
                        <td class="projects-table-cell projects-table-cell--created">
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--medium" />
                        </td>
                        <td class="projects-table-cell projects-table-cell--activity">
                          <div class="projects-skeleton-sparkline projects-skeleton-sparkline--inline" />
                        </td>
                        <td class="projects-table-cell projects-table-cell--actions">
                          <div class="projects-skeleton-menu" />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        }
      >
        <div class="projects-grid-frame is-skeleton">
          <div class="projects-collection is-grid is-skeleton">
          <For each={skeletonCards}>
            {() => (
              <article class="project-card is-grid is-skeleton">
                <div class="project-card-main">
                  <div class="project-card-copy">
                    <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--name" />
                    <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--date" />
                  </div>
                  <div class="project-card-stats">
                    <div class="projects-skeleton-sparkline" />
                  </div>
                </div>
                <div class="project-card-menu">
                  <div class="projects-skeleton-menu" />
                </div>
              </article>
            )}
          </For>
          </div>
        </div>
      </Show>
      </div>
    </div>
  );
}

function ProjectWorkspaceSkeleton(props: { activeSection: ProjectRouteSection }) {
  return (
    <div class="project-workspace is-skeleton" aria-hidden="true">
      <div class="project-page-header-shell">
        <header class="project-page-header">
          <div class="project-page-header-side">
            <div class="projects-skeleton-block projects-skeleton-header-chip" />
          </div>

          <div class="project-page-header-center">
            <div class="projects-skeleton-block projects-skeleton-header-title" />
          </div>

          <div class="project-page-header-side project-page-header-side--right">
            <div class="projects-skeleton-block projects-skeleton-header-meta" />
          </div>
        </header>
      </div>

      <Show
        when={props.activeSection === "home"}
        fallback={
          <div class="project-workspace-body">
            <div class="project-workspace-hero is-skeleton">
              <div class="project-workspace-copy">
                <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--medium" />
                <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--long" />
              </div>
              <div class="projects-skeleton-sparkline projects-skeleton-sparkline--hero" />
            </div>

            <div class="project-workspace-grid">
              <div class="logged-in-card project-section-card-skeleton">
                <div class="projects-skeleton-block projects-skeleton-card-label" />
                <div class="projects-skeleton-block projects-skeleton-card-title" />
                <div class="projects-skeleton-block projects-skeleton-card-copy" />
                <div class="projects-skeleton-block projects-skeleton-card-copy projects-skeleton-card-copy--short" />
              </div>
              <div class="logged-in-card project-section-card-skeleton">
                <div class="projects-skeleton-block projects-skeleton-card-label" />
                <div class="projects-skeleton-block projects-skeleton-card-title" />
                <div class="projects-skeleton-block projects-skeleton-card-copy" />
                <div class="projects-skeleton-block projects-skeleton-card-copy projects-skeleton-card-copy--short" />
              </div>
              <div class="logged-in-card project-section-card-skeleton">
                <div class="projects-skeleton-block projects-skeleton-card-label" />
                <div class="projects-skeleton-block projects-skeleton-card-title" />
                <div class="projects-skeleton-block projects-skeleton-card-copy" />
              </div>
            </div>
          </div>
        }
      >
        <div class="project-workspace-body is-home">
          <div class="project-home-shell is-skeleton">
            <div class="project-home-stage">
              <div class="project-home-canvas" />
              <div class="project-home-actions">
                <div class="projects-skeleton-button projects-skeleton-button--add" />
              </div>
              <div class="project-home-controls">
                <div class="project-home-control-group">
                  <div class="project-home-control-button is-skeleton" />
                  <div class="project-home-control-button is-skeleton" />
                  <div class="project-home-control-button is-skeleton" />
                </div>
              </div>
              <div class="project-home-node-grid-skeleton">
                <div class="project-graph-node-card is-skeleton">
                  <div class="project-graph-node-card-body">
                    <div class="project-graph-node-card-top">
                      <div class="project-graph-node-card-header">
                        <div class="projects-skeleton-node-icon" />
                        <div class="project-graph-node-card-copy">
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--node-title" />
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--node-subtitle" />
                        </div>
                      </div>
                      <div class="project-graph-node-actions">
                        <div class="projects-skeleton-square" />
                        <div class="projects-skeleton-square" />
                      </div>
                    </div>
                    <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--medium" />
                    <div class="project-graph-node-card-badges">
                      <div class="projects-skeleton-pill" />
                      <div class="projects-skeleton-pill" />
                    </div>
                  </div>
                  <div class="project-graph-node-card-footer">
                    <div class="projects-skeleton-mini-chart" />
                  </div>
                </div>

                <div class="project-graph-node-card is-skeleton">
                  <div class="project-graph-node-card-body">
                    <div class="project-graph-node-card-top">
                      <div class="project-graph-node-card-header">
                        <div class="projects-skeleton-node-icon" />
                        <div class="project-graph-node-card-copy">
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--node-title" />
                          <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--node-subtitle" />
                        </div>
                      </div>
                      <div class="project-graph-node-actions">
                        <div class="projects-skeleton-square" />
                        <div class="projects-skeleton-square" />
                      </div>
                    </div>
                    <div class="projects-skeleton-block projects-skeleton-text projects-skeleton-text--medium" />
                    <div class="project-graph-node-card-badges">
                      <div class="projects-skeleton-pill" />
                    </div>
                  </div>
                  <div class="project-graph-node-card-footer">
                    <div class="projects-skeleton-mini-chart" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

function ProjectWorkspace(props: {
  activeSection: ProjectRouteSection;
  project: HotfixProject;
  sentryOrganizations: SentryOrganizationSummary[];
  onBack: () => void;
  onAssignSentryConnection: (projectId: string, connectionId: string) => Promise<HotfixProject>;
  onRefreshSentryProjects: (projectId: string) => Promise<HotfixProject>;
  onRename: (projectId: string, nextName: string) => Promise<void>;
  onUpdateSentryProjectSelection: (
    projectId: string,
    includedProjectIds: string[],
  ) => Promise<void>;
}) {
  const [editingName, setEditingName] = createSignal(false);
  const [draftName, setDraftName] = createSignal(props.project.name);
  const [headerLoadingState, setHeaderLoadingState] = createSignal<{
    active: boolean;
    label: string;
  }>({
    active: false,
    label: "",
  });
  const [renameError, setRenameError] = createSignal<string | null>(null);
  const [savingName, setSavingName] = createSignal(false);

  createEffect(() => {
    if (!editingName()) {
      setDraftName(props.project.name);
    }
  });

  const cancelRename = () => {
    setDraftName(props.project.name);
    setRenameError(null);
    setEditingName(false);
  };

  const submitRename = async () => {
    if (savingName()) {
      return;
    }

    const trimmedName = draftName().trim();
    if (!trimmedName) {
      setRenameError("Project name cannot be empty.");
      return;
    }

    if (trimmedName === props.project.name) {
      setRenameError(null);
      setEditingName(false);
      return;
    }

    setSavingName(true);
    setRenameError(null);

    try {
      await props.onRename(props.project.id, trimmedName);
      setEditingName(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not rename the project.";
      setRenameError(message);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div class="project-workspace">
      <div
        class="project-page-header-shell"
        classList={{ "is-loading": headerLoadingState().active }}
      >
        <header class="project-page-header">
          <div class="project-page-header-side">
            <button class="project-workspace-back" type="button" onClick={props.onBack}>
              <span aria-hidden="true">←</span>
              <span>Projects</span>
              <span class="project-inline-kbd" aria-hidden="true">
                B
              </span>
            </button>
          </div>

          <div class="project-page-header-center">
            <Show
              when={!editingName()}
              fallback={
                <input
                  class="project-page-title-input"
                  type="text"
                  value={draftName()}
                  onInput={(event) => setDraftName(event.currentTarget.value)}
                  onBlur={() => void submitRename()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitRename();
                    }

                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                  maxlength={120}
                  autofocus
                />
              }
            >
              <button
                class="project-page-title-button"
                type="button"
                onClick={() => {
                  setDraftName(props.project.name);
                  setRenameError(null);
                  setEditingName(true);
                }}
              >
                {props.project.name}
              </button>
            </Show>
          </div>

          <div class="project-page-header-side project-page-header-side--right">
            <Show
              when={!savingName()}
              fallback={<span class="project-page-header-meta">Saving...</span>}
            >
              <ProjectHeaderClocks />
            </Show>
          </div>
        </header>
      </div>

      <Show when={headerLoadingState().active}>
        <div class="project-header-loading-state" role="status" aria-live="polite">
          {headerLoadingState().label}
        </div>
      </Show>

      <div class="project-workspace-body" classList={{ "is-home": props.activeSection === "home" }}>
        <Show when={renameError()}>
          {(message) => <p class="project-workspace-error">{message()}</p>}
        </Show>

        <Show when={props.activeSection !== "home"}>
          <div class="project-workspace-hero">
            <div class="project-workspace-copy">
              <p class="project-workspace-subtitle">
                {props.project.sentryOrganization?.name ?? "No Sentry organization selected"}
              </p>
              <p class="project-workspace-meta">
                {formatSentryProjectCount(props.project.sentryProjects.length)} imported · Created{" "}
                {formatProjectDate(props.project.createdAt)}
              </p>
            </div>
            <ProjectSparkline seed={`${props.project.id}:${props.project.name}`} compact={false} />
          </div>
        </Show>

        <ProjectSectionContent
          activeSection={props.activeSection}
          project={props.project}
          sentryOrganizations={props.sentryOrganizations}
          onHeaderLoadingChange={(active, label) => setHeaderLoadingState({ active, label })}
          onAssignSentryConnection={props.onAssignSentryConnection}
          onRefreshSentryProjects={props.onRefreshSentryProjects}
          onUpdateSentryProjectSelection={props.onUpdateSentryProjectSelection}
        />
      </div>
    </div>
  );
}

function ProjectSectionContent(props: {
  activeSection: ProjectRouteSection;
  project: HotfixProject;
  sentryOrganizations: SentryOrganizationSummary[];
  onHeaderLoadingChange: (active: boolean, label: string) => void;
  onAssignSentryConnection: (projectId: string, connectionId: string) => Promise<HotfixProject>;
  onRefreshSentryProjects: (projectId: string) => Promise<HotfixProject>;
  onUpdateSentryProjectSelection: (
    projectId: string,
    includedProjectIds: string[],
  ) => Promise<void>;
}) {
  const title = createMemo(() => {
    switch (props.activeSection) {
      case "home":
        return {
          eyebrow: "Overview",
          heading: "Project home",
          body: "This section now renders the persisted Sentry graph for the current Hotfix project.",
        };
      case "logs":
        return {
          eyebrow: "Logs",
          heading: "Log ingestion",
          body: "This section will show imported application logs, request timelines, and linked source context for the current project.",
        };
      case "incidents":
        return {
          eyebrow: "Incidents",
          heading: "Incident review",
          body: "This section will become the incident queue for regressions, unresolved issues, and grouped production failures.",
        };
      case "performance":
        return {
          eyebrow: "Performance",
          heading: "Trace analysis",
          body: "This section will hold trace breakdowns, latency regressions, and correlated performance signals for the linked Sentry projects.",
        };
      case "settings":
        return {
          eyebrow: "Settings",
          heading: "Project settings",
          body: "Choose which imported Sentry projects should be included inside this Hotfix project.",
        };
    }
  });

  return (
    <>
      <Show when={props.activeSection === "home"}>
        <ProjectHomeSection project={props.project} />
      </Show>
      <Show when={props.activeSection === "settings"}>
        <ProjectSettingsSection
          project={props.project}
          sentryOrganizations={props.sentryOrganizations}
          onHeaderLoadingChange={props.onHeaderLoadingChange}
          onAssignSentryConnection={props.onAssignSentryConnection}
          onRefreshSentryProjects={props.onRefreshSentryProjects}
          onUpdateSentryProjectSelection={props.onUpdateSentryProjectSelection}
        />
      </Show>
      <Show when={props.activeSection === "incidents"}>
        <ProjectIncidentsSection
          project={props.project}
          onHeaderLoadingChange={props.onHeaderLoadingChange}
        />
      </Show>
      <Show
        when={
          props.activeSection !== "home" &&
          props.activeSection !== "settings" &&
          props.activeSection !== "incidents"
        }
      >
        <div class="project-workspace-grid">
          <div class="logged-in-card">
            <p class="logged-in-card-label">{title().eyebrow}</p>
            <h3 class="logged-in-card-title">{title().heading}</h3>
            <p class="logged-in-card-copy">{title().body}</p>
          </div>
          <div class="logged-in-card">
            <p class="logged-in-card-label">Next Section</p>
            <h3 class="logged-in-card-title">Planned surface</h3>
            <p class="logged-in-card-copy">
              This panel will be replaced with real project-specific views once the data model for{" "}
              {title().eyebrow.toLowerCase()} is wired through.
            </p>
          </div>
          <div class="logged-in-card">
            <p class="logged-in-card-label">Keyboard</p>
            <h3 class="logged-in-card-title">Navigation</h3>
            <p class="logged-in-card-copy">
              Press <span class="project-inline-kbd">B</span> to return to Projects.
            </p>
          </div>
        </div>
      </Show>
    </>
  );
}

function ProjectHomeSection(props: { project: HotfixProject }) {
  const refreshKey = createMemo(() => {
    const sentrySignature = props.project.sentryProjects
      .map(
        (project) =>
          `${project.id}:${project.included}:${project.repoMapping?.repoId ?? "none"}:${project.slug}`,
      )
      .join("|");

    return `${props.project.sentryOrganization?.connectionId ?? "no-org"}:${sentrySignature}`;
  });

  return (
    <ProjectHomeGraph
      projectId={props.project.id}
      refreshKey={refreshKey()}
      sentryProjects={props.project.sentryProjects}
    />
  );
}

function ProjectIncidentsSection(props: {
  project: HotfixProject;
  onHeaderLoadingChange: (active: boolean, label: string) => void;
}) {
  const [syncing, setSyncing] = createSignal(false);
  const [syncError, setSyncError] = createSignal<string | null>(null);
  const [incidents, { refetch, mutate }] = createResource(
    () => props.project.id,
    async (projectId) => fetchHotfixIncidents(projectId),
  );

  const handleBackfill = async () => {
    setSyncing(true);
    setSyncError(null);
    props.onHeaderLoadingChange(true, "Backfilling incidents from Sentry...");

    try {
      const payload = await backfillHotfixIncidents(props.project.id);
      mutate(payload);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not backfill incidents from Sentry.";
      setSyncError(message);
    } finally {
      setSyncing(false);
      props.onHeaderLoadingChange(false, "");
    }
  };

  onCleanup(() => {
    props.onHeaderLoadingChange(false, "");
  });

  return (
    <div class="project-incidents-shell">
      <div class="project-incidents-header">
        <div>
          <p class="project-incidents-title">Hotfix incidents</p>
          <p class="project-incidents-copy">
            Hotfix groups linked Sentry issues into local incidents so this view can stay DB-backed
            after the initial backfill.
          </p>
        </div>
        <div class="project-incidents-actions">
          <button
            class="project-secondary-button"
            type="button"
            onClick={() => void refetch()}
            disabled={incidents.loading || syncing()}
          >
            Refresh list
          </button>
          <button
            class="brand-button"
            type="button"
            onClick={() => void handleBackfill()}
            disabled={syncing()}
          >
            {syncing() ? "Backfilling..." : "Backfill from Sentry"}
          </button>
        </div>
      </div>

      <Show when={syncError()}>
        {(message) => <p class="project-workspace-error">{message()}</p>}
      </Show>

      <Show
        when={!incidents.error}
        fallback={
          <div class="logged-in-card">
            <p class="logged-in-card-label">Incidents</p>
            <h3 class="logged-in-card-title">Incident data is unavailable</h3>
            <p class="logged-in-card-copy">
              Hotfix could not load the local incident projection for this project.
            </p>
          </div>
        }
      >
        <Show
          when={!incidents.loading}
          fallback={
            <div class="project-incidents-list" aria-hidden="true">
              <div class="projects-loading-row" />
              <div class="projects-loading-row" />
            </div>
          }
        >
          <Show
            when={(incidents()?.length ?? 0) > 0}
            fallback={
              <div class="logged-in-card">
                <p class="logged-in-card-label">No incidents yet</p>
                <h3 class="logged-in-card-title">Run the first Sentry backfill</h3>
                <p class="logged-in-card-copy">
                  Hotfix will import unresolved Sentry issues, create local issue snapshots, and
                  group them into project incidents.
                </p>
              </div>
            }
          >
            <div class="project-incidents-list">
              <For each={incidents() ?? []}>
                {(incident) => (
                  <article class="project-incident-card">
                    <div class="project-incident-top">
                      <div class="project-incident-copy">
                        <div class="project-incident-meta-row">
                          <span class="project-incident-status">{incident.status}</span>
                          <span class="project-incident-meta">
                            {incident.issueCount} issue{incident.issueCount === 1 ? "" : "s"} ·{" "}
                            {incident.sentryProjectCount} project
                            {incident.sentryProjectCount === 1 ? "" : "s"}
                          </span>
                        </div>
                        <h3 class="project-incident-title">{incident.title}</h3>
                        <p class="project-incident-meta">
                          Last seen{" "}
                          {formatProjectDate(
                            incident.lastSeenAt ?? incident.firstSeenAt ?? Date.now(),
                          )}
                        </p>
                      </div>
                    </div>

                    <div class="project-incident-sections">
                      <div class="project-incident-section">
                        <p class="project-incident-section-label">Sentry issues</p>
                        <div class="project-incident-chip-wrap">
                          <For each={incident.sentryIssues.slice(0, 5)}>
                            {(issue) => (
                              <a
                                class="project-incident-chip"
                                href={issue.permalink ?? "#"}
                                target={issue.permalink ? "_blank" : undefined}
                                rel={issue.permalink ? "noreferrer" : undefined}
                              >
                                <span>{issue.shortId ?? issue.sentryIssueId}</span>
                                <span class="project-incident-chip-muted">{issue.projectSlug}</span>
                              </a>
                            )}
                          </For>
                        </div>
                      </div>

                      <div class="project-incident-section">
                        <p class="project-incident-section-label">Code references</p>
                        <div class="project-incident-code-list">
                          <For each={incident.codeRefs.slice(0, 4)}>
                            {(codeRef) => (
                              <div class="project-incident-code-item">
                                <p class="project-incident-code-path">
                                  {codeRef.githubRepoFullName
                                    ? `${codeRef.githubRepoFullName} · `
                                    : ""}
                                  {codeRef.path}
                                  <Show when={codeRef.startLine}>
                                    <span>
                                      :{codeRef.startLine}
                                      {codeRef.endLine && codeRef.endLine !== codeRef.startLine
                                        ? `-${codeRef.endLine}`
                                        : ""}
                                    </span>
                                  </Show>
                                </p>
                                <p class="project-incident-code-meta">
                                  {codeRef.symbol ?? codeRef.source} · confidence{" "}
                                  {Math.round(codeRef.confidence * 100)}%
                                </p>
                              </div>
                            )}
                          </For>
                          <Show when={incident.codeRefs.length === 0}>
                            <p class="project-incident-empty-copy">
                              No code references derived yet. The next pass can enrich these from
                              exemplar stack frames.
                            </p>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function ProjectSettingsSection(props: {
  project: HotfixProject;
  sentryOrganizations: SentryOrganizationSummary[];
  onHeaderLoadingChange: (active: boolean, label: string) => void;
  onAssignSentryConnection: (projectId: string, connectionId: string) => Promise<HotfixProject>;
  onRefreshSentryProjects: (projectId: string) => Promise<HotfixProject>;
  onUpdateSentryProjectSelection: (
    projectId: string,
    includedProjectIds: string[],
  ) => Promise<void>;
}) {
  const [draftIncludedIds, setDraftIncludedIds] = createSignal<string[]>(
    props.project.sentryProjects.filter((project) => project.included).map((project) => project.id),
  );
  const [saving, setSaving] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [assigningConnection, setAssigningConnection] = createSignal(false);
  const [selectedConnectionId, setSelectedConnectionId] = createSignal(
    props.project.sentryOrganization?.connectionId ?? "",
  );
  const [saveError, setSaveError] = createSignal<string | null>(null);
  let autosaveTimeoutId: number | undefined;

  createEffect(() => {
    setDraftIncludedIds(
      props.project.sentryProjects
        .filter((project) => project.included)
        .map((project) => project.id),
    );
    setSelectedConnectionId(props.project.sentryOrganization?.connectionId ?? "");
    setSaveError(null);
  });

  createEffect(() => {
    if (import.meta.env.DEV) {
      console.log("Hotfix Sentry project metadata", props.project.sentryProjects);
    }
  });

  const isDirty = createMemo(() => {
    const current = new Set(
      props.project.sentryProjects
        .filter((project) => project.included)
        .map((project) => project.id),
    );
    const draft = new Set(draftIncludedIds());
    if (current.size !== draft.size) {
      return true;
    }

    for (const id of draft) {
      if (!current.has(id)) {
        return true;
      }
    }

    return false;
  });

  const toggleProject = (projectId: string) => {
    setDraftIncludedIds((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    );
  };

  const saveSelection = async (includedProjectIds: string[]) => {
    if (saving()) {
      autosaveTimeoutId = window.setTimeout(() => {
        void saveSelection(includedProjectIds);
      }, 180);
      return;
    }

    if (!isDirty()) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      await props.onUpdateSentryProjectSelection(props.project.id, includedProjectIds);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not update Sentry project selection.";
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  };

  createEffect(() => {
    const nextIncludedIds = [...draftIncludedIds()];
    const dirty = isDirty();

    if (autosaveTimeoutId !== undefined) {
      window.clearTimeout(autosaveTimeoutId);
      autosaveTimeoutId = undefined;
    }

    if (!dirty) {
      return;
    }

    autosaveTimeoutId = window.setTimeout(() => {
      void saveSelection(nextIncludedIds);
    }, 420);
  });

  onCleanup(() => {
    if (autosaveTimeoutId !== undefined) {
      window.clearTimeout(autosaveTimeoutId);
    }
    props.onHeaderLoadingChange(false, "");
  });

  const refreshSelection = async () => {
    if (refreshing()) {
      return;
    }

    setRefreshing(true);
    props.onHeaderLoadingChange(true, "Refreshing Sentry projects...");
    setSaveError(null);

    try {
      const updatedProject = await props.onRefreshSentryProjects(props.project.id);
      if (import.meta.env.DEV) {
        console.log("Hotfix refreshed Sentry project metadata", updatedProject.sentryProjects);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not refresh imported Sentry projects.";
      setSaveError(message);
    } finally {
      setRefreshing(false);
      props.onHeaderLoadingChange(false, "");
    }
  };

  const connectSentryOrganization = async () => {
    if (assigningConnection() || !selectedConnectionId()) {
      return;
    }

    setAssigningConnection(true);
    setSaveError(null);
    props.onHeaderLoadingChange(true, "Connecting Sentry organization...");

    try {
      await props.onAssignSentryConnection(props.project.id, selectedConnectionId());
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not connect the selected Sentry organization.";
      setSaveError(message);
    } finally {
      setAssigningConnection(false);
      props.onHeaderLoadingChange(false, "");
    }
  };

  return (
    <div class="project-settings-shell">
      <div class="project-settings-header">
        <div>
          <p class="logged-in-card-label">Settings</p>
          <h2 class="project-settings-title">Included Sentry projects</h2>
          <p class="project-settings-copy">
            Connect a Sentry organization for this project, then choose which imported Sentry
            projects should be available to link onto canvas items.
          </p>
        </div>

        <div class="project-settings-actions">
          <button
            class="secondary-button"
            type="button"
            onClick={() => void refreshSelection()}
            disabled={refreshing() || !props.project.sentryOrganization}
          >
            {refreshing() ? "Refreshing..." : "Refresh from Sentry"}
          </button>
          <Show when={saving() || isDirty()}>
            <p class="project-settings-status">
              {saving() ? "Saving changes..." : "Changes pending..."}
            </p>
          </Show>
        </div>
      </div>

      <div class="logged-in-card">
        <p class="logged-in-card-label">Sentry organization</p>
        <h3 class="logged-in-card-title">
          {props.project.sentryOrganization?.name ?? "No Sentry organization connected"}
        </h3>
        <p class="logged-in-card-copy">
          {props.project.sentryOrganization
            ? "Switch the connected organization to refresh the list of importable Sentry projects."
            : "Connect one Sentry organization to import its projects for this Hotfix project."}
        </p>

        <Show
          when={props.sentryOrganizations.length > 0}
          fallback={
            <p class="project-field-helper">
              <a class="project-inline-link" href="/api/auth/sentry/start">
                Connect Sentry
              </a>{" "}
              to make organizations available here.
            </p>
          }
        >
          <div class="project-settings-connect-row">
            <div class="projects-select-wrap">
              <select
                class="project-field-input project-field-select"
                value={selectedConnectionId()}
                onInput={(event) => setSelectedConnectionId(event.currentTarget.value)}
              >
                <option value="">Select a Sentry organization</option>
                <For each={props.sentryOrganizations}>
                  {(organization) => (
                    <option value={organization.connectionId}>{organization.name}</option>
                  )}
                </For>
              </select>
              <span class="projects-select-caret" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none">
                  <path
                    d="m4.25 6.25 3.75 3.75 3.75-3.75"
                    stroke="currentColor"
                    stroke-width="1.15"
                  />
                </svg>
              </span>
            </div>
            <button
              class="secondary-button"
              type="button"
              onClick={() => void connectSentryOrganization()}
              disabled={!selectedConnectionId() || assigningConnection()}
            >
              {assigningConnection()
                ? "Connecting..."
                : props.project.sentryOrganization
                  ? "Switch org"
                  : "Connect org"}
            </button>
          </div>
        </Show>
      </div>

      <Show
        when={props.project.sentryProjects.length > 0}
        fallback={
          <div class="logged-in-card">
            <p class="logged-in-card-label">No Sentry projects</p>
            <h3 class="logged-in-card-title">Nothing to configure yet</h3>
            <p class="logged-in-card-copy">
              Connect a Sentry organization and import its projects before configuring inclusion
              here.
            </p>
          </div>
        }
      >
        <div class="project-settings-list" role="group" aria-label="Included Sentry projects">
          <For each={props.project.sentryProjects}>
            {(sentryProject) => {
              const checked = () => draftIncludedIds().includes(sentryProject.id);

              return (
                <label class="project-settings-item">
                  <span class="project-settings-checkbox-wrap">
                    <input
                      class="project-settings-checkbox"
                      type="checkbox"
                      checked={checked()}
                      onInput={() => toggleProject(sentryProject.id)}
                    />
                  </span>
                  <span class="project-settings-item-copy">
                    <span class="project-settings-item-title">{sentryProject.name}</span>
                    <span class="project-settings-item-meta">
                      {sentryProject.slug}
                      <Show when={sentryProject.platform}>{(platform) => ` · ${platform()}`}</Show>
                    </span>
                  </span>
                </label>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={saveError()}>
        {(message) => <p class="project-workspace-error">{message()}</p>}
      </Show>
    </div>
  );
}

function ProjectHeaderClocks() {
  const [now, setNow] = createSignal(Date.now());
  const [showLocalTime, setShowLocalTime] = createSignal(false);
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  onMount(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    onCleanup(() => {
      window.clearInterval(intervalId);
    });
  });

  return (
    <button
      class="project-header-clock-button"
      type="button"
      aria-label="Current time"
      onMouseEnter={() => setShowLocalTime(true)}
      onMouseLeave={() => setShowLocalTime(false)}
      onFocus={() => setShowLocalTime(true)}
      onBlur={() => setShowLocalTime(false)}
    >
      <span class="project-header-clock-label">
        {showLocalTime() ? `Local time now (${localTimeZone}):` : "UTC time now:"}
      </span>
      <span class="project-header-clock-value">
        {showLocalTime() ? formatHeaderClock(now()) : formatHeaderClock(now(), "UTC")}
      </span>
    </button>
  );
}

function ProjectSparkline(props: { seed: string; compact: boolean }) {
  const width = () => (props.compact ? 128 : 196);
  const height = () => (props.compact ? 38 : 58);
  const values = createSparklineSeries(props.seed, props.compact ? 18 : 22);
  const path = buildSparklinePath(values, width(), height());
  const gradientId = `sparkline-${props.seed.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <svg
      class="project-sparkline"
      viewBox={`0 0 ${width()} ${height()}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${gradientId}-stroke`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="rgba(49, 116, 194, 0.58)" />
          <stop offset="46%" stop-color="rgba(82, 173, 255, 0.8)" />
          <stop offset="100%" stop-color="#a4f0ff" />
        </linearGradient>
        <linearGradient id={`${gradientId}-fill`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="rgba(32, 94, 176, 0)" />
          <stop offset="100%" stop-color="rgba(127, 220, 255, 0.18)" />
        </linearGradient>
      </defs>
      <path d={path.area} fill={`url(#${gradientId}-fill)`} />
      <path
        d={path.line}
        fill="none"
        stroke={`url(#${gradientId}-stroke)`}
        stroke-width={props.compact ? "1.8" : "2.1"}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function ViewModeIcon(props: { mode: ProjectsView }) {
  return (
    <span class="projects-view-icon" aria-hidden="true">
      <Show when={props.mode === "grid"}>
        <svg viewBox="0 0 16 16" fill="none">
          <path
            d="M2.75 2.75h4.5v4.5h-4.5v-4.5Zm6 0h4.5v4.5h-4.5v-4.5Zm-6 6h4.5v4.5h-4.5v-4.5Zm6 0h4.5v4.5h-4.5v-4.5Z"
            stroke="currentColor"
            stroke-width="1.1"
          />
        </svg>
      </Show>
      <Show when={props.mode === "list"}>
        <svg viewBox="0 0 16 16" fill="none">
          <path
            d="M4 4h8M4 8h8M4 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"
            stroke="currentColor"
            stroke-width="1.15"
          />
        </svg>
      </Show>
    </span>
  );
}

function UserAvatar(props: { user: AuthenticatedUser }) {
  const initials = createMemo(() =>
    getUserInitials(props.user.displayName || props.user.email || "H"),
  );

  return (
    <Show
      when={props.user.avatarUrl}
      fallback={<span class="projects-account-fallback">{initials()}</span>}
    >
      {(avatarUrl) => (
        <img
          class="projects-account-avatar"
          src={avatarUrl()}
          alt={`${props.user.displayName} profile`}
          loading="lazy"
        />
      )}
    </Show>
  );
}

function AccountSettingsModal(props: {
  user: AuthenticatedUser;
  notice: string | null;
  loggingOut: boolean;
  onClose: () => void;
  onLogout: () => Promise<void>;
}) {
  return (
    <div class="project-modal-backdrop" role="presentation" onClick={() => props.onClose()}>
      <div
        class="project-modal project-modal--settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="project-modal-header">
          <div>
            <p class="logged-in-card-label">Settings</p>
            <h2 class="project-modal-title" id="account-settings-title">
              Account settings
            </h2>
          </div>
          <button
            class="project-modal-close"
            type="button"
            aria-label="Close"
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </div>

        <div class="account-settings-grid">
          <div class="logged-in-card">
            <p class="logged-in-card-label">Signed in as</p>
            <div class="account-settings-identity">
              <span class="projects-account-chip">
                <UserAvatar user={props.user} />
              </span>
              <div>
                <h3 class="logged-in-card-title">{props.user.displayName}</h3>
                <p class="logged-in-card-copy">
                  {props.user.email ?? "No email exposed by the provider."}
                </p>
              </div>
            </div>
          </div>

          <div class="logged-in-card">
            <p class="logged-in-card-label">Connections</p>
            <h3 class="logged-in-card-title">Provider status</h3>
            <p class="logged-in-card-copy">
              Sentry: {props.user.providers.sentry ? "connected" : "not connected"}
            </p>
            <p class="logged-in-card-copy">
              GitHub: {props.user.providers.github ? "connected" : "not connected"}
            </p>
          </div>
        </div>

        <Show when={props.notice}>
          {(message) => (
            <p class="rounded-[4px] border border-[rgba(229,99,99,0.18)] bg-[rgba(71,24,24,0.35)] px-4 py-3 text-sm text-[rgba(255,197,197,0.94)]">
              {message()}
            </p>
          )}
        </Show>

        <div class="project-modal-actions">
          <button class="project-modal-secondary" type="button" onClick={() => props.onClose()}>
            Close
          </button>
          <button
            class="secondary-button"
            type="button"
            onClick={() => void props.onLogout()}
            disabled={props.loggingOut}
          >
            {props.loggingOut ? "Logging out..." : "Log out"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SidebarIcon(props: { tab: ProjectRouteSection }) {
  const iconSrc = (() => {
    switch (props.tab) {
      case "home":
        return sidebarHomeIcon;
      case "logs":
        return sidebarLogsIcon;
      case "incidents":
        return sidebarIncidentsIcon;
      case "performance":
        return sidebarPerformanceIcon;
      case "settings":
        return sidebarSettingsIcon;
    }
  })();

  return (
    <span class="app-sidebar-icon" aria-hidden="true">
      <span class="app-sidebar-icon-mask" style={`--sidebar-icon: url("${iconSrc}")`} />
    </span>
  );
}

function FeedbackPanel(props: {
  eyebrow: string;
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div class="space-y-6">
      <div class="space-y-2">
        <p class="text-[0.68rem] font-medium uppercase tracking-[0.28em] text-[var(--text-muted)]">
          {props.eyebrow}
        </p>
        <h1 class="text-[2rem] font-medium tracking-[-0.04em] text-[var(--text-primary)] sm:text-[2.35rem]">
          {props.title}
        </h1>
        <p class="text-base text-[var(--text-secondary)]">{props.message}</p>
      </div>

      <button class="auth-button w-full" type="button" onClick={props.onAction}>
        <span class="provider-glyph">↻</span>
        <span>{props.actionLabel}</span>
      </button>
    </div>
  );
}

function ProviderButton(props: { href: string; label: string; iconSrc: string; shortcut: string }) {
  return (
    <a class="auth-button provider-button w-full" href={props.href}>
      <span class="provider-main">
        <span class="provider-glyph" aria-hidden="true">
          <img class="provider-icon" src={props.iconSrc} alt="" />
        </span>
        <span class="provider-label">{props.label}</span>
      </span>
      <span class="shortcut-badge" aria-hidden="true">
        {props.shortcut}
      </span>
    </a>
  );
}

function LegalSection(props: { title: string; body: string }) {
  return (
    <section class="space-y-2">
      <h2 class="text-[1rem] font-medium tracking-[-0.02em] text-[var(--text-primary)]">
        {props.title}
      </h2>
      <p>{props.body}</p>
    </section>
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }

  if (target instanceof HTMLInputElement) {
    const textLikeTypes = new Set(["text", "search", "email", "password", "url", "tel", "number"]);
    return textLikeTypes.has(target.type);
  }

  return target instanceof HTMLElement && target.isContentEditable;
}

function formatSentryProjectCount(count: number) {
  return `${count} Sentry project${count === 1 ? "" : "s"}`;
}

function formatProjectDate(createdAt: number | string) {
  const date = parseProjectDate(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatProjectLastActivity(timestamp: number | null) {
  if (!timestamp) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatIndexingStatus(status: string, percentage: number) {
  switch (status) {
    case "indexed":
      return "Indexed";
    case "indexing":
      return `Indexing ${percentage}%`;
    case "queued":
      return "Queued";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    case "not_indexed":
    default:
      return "Not indexed";
  }
}

function getIndexingSortRank(status: string) {
  switch (status) {
    case "failed":
      return 0;
    case "indexing":
      return 1;
    case "queued":
      return 2;
    case "pending":
      return 3;
    case "indexed":
      return 4;
    case "not_indexed":
    default:
      return 5;
  }
}

function getProjectHealth(project: HotfixProject) {
  if (project.incidentCount > 0) {
    return { label: "Issues", tone: "danger" as const };
  }

  if (project.indexingStatus === "failed") {
    return { label: "Blocked", tone: "danger" as const };
  }

  if (
    project.indexingStatus === "indexing" ||
    project.indexingStatus === "queued" ||
    project.indexingStatus === "pending"
  ) {
    return { label: "Indexing", tone: "warn" as const };
  }

  if (project.itemsCount === 0) {
    return { label: "Blank", tone: "muted" as const };
  }

  if (project.githubConnected || project.sentryConnected) {
    return { label: "Healthy", tone: "ok" as const };
  }

  return { label: "Setup", tone: "muted" as const };
}

function formatHeaderClock(timestamp: number, timeZone?: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function getProjectRoute(pathname: string): ProjectRouteState {
  if (!pathname || pathname === "/") {
    return { slug: null, section: "home" };
  }

  const segments = pathname.split("/").filter(Boolean);
  if (!segments.length || segments.length > 2) {
    return { slug: null, section: "home" };
  }

  const [slugSegment, sectionSegment] = segments;
  if (
    !slugSegment ||
    slugSegment === "api" ||
    slugSegment === "terms" ||
    slugSegment === "privacy"
  ) {
    return { slug: null, section: "home" };
  }

  const slug = decodeURIComponent(slugSegment);
  if (!sectionSegment) {
    return { slug, section: "home" };
  }

  const section = decodeURIComponent(sectionSegment);
  if (!isProjectSectionTab(section)) {
    return { slug: null, section: "home" };
  }

  return { slug, section };
}

function getProjectPath(slug: string | null, section: ProjectRouteSection) {
  if (!slug) {
    return "/";
  }

  const encodedSlug = encodeURIComponent(slug);
  if (section === "home") {
    return `/${encodedSlug}`;
  }

  return `/${encodedSlug}/${section}`;
}

function isProjectSectionTab(value: string): value is ProjectSectionTab {
  return (
    value === "logs" || value === "incidents" || value === "performance" || value === "settings"
  );
}

function getProjectCreatedAtTimestamp(createdAt: number | string) {
  const date = parseProjectDate(createdAt);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function parseProjectDate(createdAt: number | string) {
  if (typeof createdAt === "number") {
    return new Date(createdAt);
  }

  const direct = new Date(createdAt);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const normalized = createdAt
    .replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T")
    .replace(/ ([+-]\d{2}:\d{2}):\d{2}$/, "$1");

  return new Date(normalized);
}

function createSparklineSeries(seed: string, points: number) {
  let state = 0;

  for (const character of seed) {
    state = (state * 33 + character.charCodeAt(0)) >>> 0;
  }

  return Array.from({ length: points }, (_, index) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    const wave = Math.sin(index * 0.48 + (state % 11) * 0.14) * 14;
    const drift = Math.cos(index * 0.24 + (state % 7) * 0.2) * 8;
    const base = 30 + (state % 38);
    return Math.max(12, Math.round(base + wave + drift));
  });
}

function buildSparklinePath(values: number[], width: number, height: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - ((value - min) / range) * (height - 8) - 4;
    return {
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
    };
  });

  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;

  return { line, area };
}

function scrambleBrandWord(frame: number, totalFrames: number): BrandGlyph[] {
  const progress = frame / totalFrames;

  return brandText.split("").map((character, index) => {
    const resolved = progress > (index + 1) / brandText.length;
    if (resolved) {
      return {
        character,
        accent: false,
      };
    }

    const variants = glyphVariants[character] ?? [character];
    return {
      character: variants[Math.floor(Math.random() * variants.length)] ?? character,
      accent: (frame + index) % 2 === 0,
    };
  });
}

function createBaseBrandGlyphs(): BrandGlyph[] {
  return brandText.split("").map((character) => ({
    character,
    accent: false,
  }));
}

function getUserInitials(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "H";
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }

  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function brandAnimationMode(view: AppView, session: SessionResponse | undefined): "loop" | "hover" {
  if (view === "auth" && !session?.authenticated) {
    return "loop";
  }

  return "hover";
}

function resolveView(pathname: string): AppView {
  if (pathname === "/terms") {
    return "terms";
  }

  if (pathname === "/privacy") {
    return "privacy";
  }

  return "auth";
}

export default App;
