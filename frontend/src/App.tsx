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

const sentryIcon = new URL("./assets/sentry.svg", import.meta.url).href;
const githubIcon = new URL("./assets/github.svg", import.meta.url).href;
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
    providers: {
      github: boolean;
      sentry: boolean;
    };
  } | null;
};

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
  repoMapping: GitHubRepoMapping | null;
};

type HotfixProject = {
  id: string;
  name: string;
  slug: string;
  createdAt: number | string;
  sentryOrganization: SentryOrganizationSummary | null;
  sentryProjects: ImportedSentryProject[];
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
type AppTab = "projects" | "usage" | "settings";
type ProjectsSort = "created" | "alphabetical";
type ProjectsView = "list" | "grid";

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
        <a class="inline-flex items-center text-[0.75rem] uppercase tracking-[0.24em] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]" href="/">
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
        <a class="inline-flex items-center text-[0.75rem] uppercase tracking-[0.24em] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]" href="/">
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
  user: SessionResponse["user"];
  notice: string | null;
  loggingOut: boolean;
  onLogout: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = createSignal<AppTab>("projects");
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [showSidebarShortcuts, setShowSidebarShortcuts] = createSignal(false);
  const [projectsResetToken, setProjectsResetToken] = createSignal(0);
  const [forceSidebarCollapsed, setForceSidebarCollapsed] = createSignal(false);
  const tabs: Array<{ id: AppTab; label: string; shortcut: string }> = [
    { id: "projects", label: "Projects", shortcut: "1" },
    { id: "usage", label: "Usage", shortcut: "2" },
    { id: "settings", label: "Settings", shortcut: "3" },
  ];

  const activateTab = (nextTab: AppTab) => {
    if (nextTab === "projects" && activeTab() === "projects") {
      setProjectsResetToken((token) => token + 1);
      setForceSidebarCollapsed(false);
      return;
    }

    if (nextTab !== "projects") {
      setForceSidebarCollapsed(false);
    }

    setActiveTab(nextTab);
  };

  onMount(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-account-menu]")) {
        return;
      }

      setAccountMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.ctrlKey) {
        setShowSidebarShortcuts(true);
      }

      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      const nextTab = tabs.find((tab) => tab.shortcut === event.key);
      if (!nextTab) {
        return;
      }

      event.preventDefault();
      setAccountMenuOpen(false);
      activateTab(nextTab.id);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!event.ctrlKey) {
        setShowSidebarShortcuts(false);
      }
    };

    const handleWindowBlur = () => {
      setShowSidebarShortcuts(false);
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    onCleanup(() => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    });
  });

  return (
    <section class="logged-in-shell flex w-full flex-1">
      <aside class="app-sidebar" classList={{ "is-collapsed": forceSidebarCollapsed() }}>
        <a href="/" class="app-sidebar-brand" aria-label="Go to dashboard">
          <BrandWordmark mode="hover" />
        </a>

        <div class="app-sidebar-gap" aria-hidden="true" />

        <nav class="app-sidebar-nav" aria-label="Primary">
          <For each={tabs}>
            {(tab) => (
              <button
                class="app-sidebar-item"
                classList={{
                  "is-active": activeTab() === tab.id,
                  "show-shortcut": showSidebarShortcuts(),
                }}
                type="button"
                onClick={() => activateTab(tab.id)}
                aria-pressed={activeTab() === tab.id}
                title={`${tab.label} (Ctrl+${tab.shortcut})`}
              >
                <SidebarIcon tab={tab.id} />
                <span class="app-sidebar-label">{tab.label}</span>
                <span class="app-sidebar-shortcut" aria-hidden="true">
                  ^{tab.shortcut}
                </span>
              </button>
            )}
          </For>
        </nav>

        <div class="app-sidebar-spacer" />

        <div class="app-sidebar-account" data-account-menu>
          <div class="app-sidebar-account-copy">
            <p class="app-sidebar-account-name">{props.user?.displayName}</p>
            <p class="app-sidebar-account-subtitle">{props.user?.email ?? "Signed in"}</p>
          </div>
          <div class="app-sidebar-account-actions">
            <button
              class="app-sidebar-menu-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen()}
              onClick={() => setAccountMenuOpen((open) => !open)}
              title="Account menu"
            >
              <span />
              <span />
              <span />
            </button>
          </div>

          <Show when={accountMenuOpen()}>
            <div class="app-sidebar-popover" role="menu">
              <button
                class="app-sidebar-popover-item"
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
      </aside>

      <div
        class="logged-in-main"
        classList={{ "has-blueprint": activeTab() === "projects" && forceSidebarCollapsed() }}
      >
        <div class="logged-in-panel">
          <Show when={activeTab() === "projects"}>
            <ProjectsTab
              resetToken={projectsResetToken()}
              onProjectOpenChange={setForceSidebarCollapsed}
            />
          </Show>
          <Show when={activeTab() === "usage"}>
            <UsageTab />
          </Show>
          <Show when={activeTab() === "settings"}>
            <SettingsTab
              user={props.user}
              notice={props.notice}
              loggingOut={props.loggingOut}
              onLogout={props.onLogout}
            />
          </Show>
        </div>
      </div>
    </section>
  );
}

function ProjectsTab(props: { resetToken: number; onProjectOpenChange: (open: boolean) => void }) {
  const [sortBy, setSortBy] = createSignal<ProjectsSort>("created");
  const [viewMode, setViewMode] = createSignal<ProjectsView>("list");
  const [createModalOpen, setCreateModalOpen] = createSignal(false);
  const [projectName, setProjectName] = createSignal("");
  const [selectedConnectionId, setSelectedConnectionId] = createSignal("");
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null);
  const [openedProjectId, setOpenedProjectId] = createSignal<string | null>(null);
  const [routeProjectSlug, setRouteProjectSlug] = createSignal<string | null>(
    typeof window === "undefined" ? null : getProjectSlugFromPath(window.location.pathname),
  );
  const [createError, setCreateError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [dashboard, { refetch, mutate }] = createResource(() => "dashboard", async () => fetchDashboard());

  const sentryOrganizations = createMemo(() => dashboard()?.sentryOrganizations ?? []);
  const canCreateProject = createMemo(
    () => projectName().trim().length > 0 && selectedConnectionId().length > 0 && !creating(),
  );
  const sortedProjects = createMemo(() => {
    const projects = [...(dashboard()?.projects ?? [])];

    if (sortBy() === "alphabetical") {
      projects.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
      return projects;
    }

    projects.sort(
      (left, right) =>
        getProjectCreatedAtTimestamp(right.createdAt) - getProjectCreatedAtTimestamp(left.createdAt),
    );
    return projects;
  });
  const selectedProject = createMemo(() =>
    sortedProjects().find((project) => project.id === selectedProjectId()) ?? null,
  );
  const openedProject = createMemo(() =>
    sortedProjects().find((project) => project.id === openedProjectId()) ?? null,
  );
  let handledResetToken = props.resetToken;

  const openCreateModal = () => {
    setProjectName("");
    setCreateError(null);
    setSelectedConnectionId("");
    setCreateModalOpen(true);
  };

  const syncProjectUrl = (slug: string | null, mode: "push" | "replace" = "push") => {
    if (typeof window === "undefined") {
      return;
    }

    const nextPath = getProjectPath(slug);
    if (window.location.pathname !== nextPath) {
      if (mode === "replace") {
        window.history.replaceState({}, "", nextPath);
      } else {
        window.history.pushState({}, "", nextPath);
      }
    }

    setRouteProjectSlug(slug);
  };

  const closeCreateModal = () => {
    if (creating()) {
      return;
    }

    setCreateModalOpen(false);
    setCreateError(null);
  };

  const openProject = (projectId: string) => {
    const project = sortedProjects().find((item) => item.id === projectId);
    if (!project) {
      return;
    }

    setSelectedProjectId(projectId);
    setOpenedProjectId(projectId);
    syncProjectUrl(project.slug);
  };

  const closeProject = (mode: "push" | "replace" = "push") => {
    setOpenedProjectId(null);
    syncProjectUrl(null, mode);
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
    if (!createModalOpen()) {
      return;
    }

    const organizations = sentryOrganizations();
    if (!organizations.length) {
      setSelectedConnectionId("");
      return;
    }

    if (!organizations.some((organization) => organization.connectionId === selectedConnectionId())) {
      setSelectedConnectionId("");
    }
  });

  createEffect(() => {
    const projects = sortedProjects();

    if (!projects.length) {
      setSelectedProjectId(null);
      setOpenedProjectId(null);
      if (routeProjectSlug() && !dashboard.loading) {
        syncProjectUrl(null, "replace");
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
    const slug = routeProjectSlug();
    const projects = sortedProjects();

    if (!slug) {
      if (openedProjectId()) {
        setOpenedProjectId(null);
      }
      return;
    }

    const project = projects.find((item) => item.slug === slug);
    if (project) {
      if (selectedProjectId() !== project.id) {
        setSelectedProjectId(project.id);
      }
      if (openedProjectId() !== project.id) {
        setOpenedProjectId(project.id);
      }
      return;
    }

    if (!dashboard.loading) {
      setOpenedProjectId(null);
      syncProjectUrl(null, "replace");
    }
  });

  createEffect(() => {
    const nextResetToken = props.resetToken;
    if (nextResetToken === handledResetToken) {
      return;
    }

    handledResetToken = nextResetToken;
    setOpenedProjectId(null);
    syncProjectUrl(null);
  });

  createEffect(() => {
    props.onProjectOpenChange(Boolean(openedProjectId()));
  });

  onCleanup(() => {
    props.onProjectOpenChange(false);
  });

  onMount(() => {
    const handlePopState = () => {
      setRouteProjectSlug(getProjectSlugFromPath(window.location.pathname));
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (createModalOpen()) {
        return;
      }

      if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        openCreateModal();
        return;
      }

      if (openedProject()) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeProject();
        }
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

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("keydown", handleKeyDown);
    });
  });

  createEffect(() => {
    if (!createModalOpen()) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCreateModal();
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

    if (!selectedConnectionId()) {
      setCreateError("Select a Sentry organization before creating the project.");
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

      await fetchJson<HotfixProject>(`/api/hotfix-projects/${project.id}/sentry-connection`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connectionId: selectedConnectionId(),
        }),
      });

      setCreateModalOpen(false);
      setProjectName("");
      setSelectedConnectionId("");
      setSelectedProjectId(project.id);
      closeProject("replace");
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
        syncProjectUrl(updatedProject.slug, "replace");
      }
    } catch (error) {
      mutate(previousDashboard);
      throw error;
    }
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
            <div class="projects-loading-list" aria-hidden="true">
              <div class="projects-loading-row" />
              <div class="projects-loading-row" />
              <div class="projects-loading-row" />
            </div>
          }
        >
          <Show when={openedProject()}>
            {(project) => (
              <ProjectWorkspace
                project={project()}
                onBack={closeProject}
                onRename={renameProject}
              />
            )}
          </Show>
          <Show when={!openedProject()}>
            <div class="projects-header">
              <div class="projects-header-copy">
                <h1 class="projects-title">Projects</h1>
              </div>

              <button class="brand-button" type="button" onClick={openCreateModal} disabled={dashboard.loading}>
                <span class="brand-button-plus" aria-hidden="true">
                  +
                </span>
                <span>New project</span>
                <span class="brand-button-shortcut" aria-hidden="true">
                  N
                </span>
              </button>
            </div>

            <div class="projects-toolbar">
              <div class="projects-toolbar-meta">
                <span class="projects-toolbar-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 3.25h3v3H3v-3Zm7 0h3v3h-3v-3ZM3 9.75h3v3H3v-3Zm7 0h3v3h-3v-3Z"
                      stroke="currentColor"
                      stroke-width="1.1"
                    />
                  </svg>
                </span>
                <span>{sortedProjects().length} Projects</span>
                <span class="projects-toolbar-divider" aria-hidden="true" />
                <label class="projects-sort-label" for="projects-sort">
                  Sort by:
                </label>
                <div class="projects-select-wrap">
                  <select
                    id="projects-sort"
                    class="projects-select"
                    value={sortBy()}
                    onInput={(event) => setSortBy(event.currentTarget.value as ProjectsSort)}
                  >
                    <option value="created">Date Created</option>
                    <option value="alphabetical">Alphabetical</option>
                  </select>
                  <span class="projects-select-caret" aria-hidden="true">
                    <svg viewBox="0 0 16 16" fill="none">
                      <path d="m4.25 6.25 3.75 3.75 3.75-3.75" stroke="currentColor" stroke-width="1.15" />
                    </svg>
                  </span>
                </div>
              </div>

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
            </div>

            <Show
              when={sortedProjects().length > 0}
              fallback={
                <div class="projects-empty-state">
                  <div class="projects-empty-illustration" aria-hidden="true">
                    <svg viewBox="0 0 80 80" fill="none">
                      <rect x="18" y="16" width="44" height="48" rx="4" fill="rgba(255,255,255,0.03)" />
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
                        <linearGradient id="empty-graph-stroke" x1="24" y1="54" x2="55" y2="18" gradientUnits="userSpaceOnUse">
                          <stop stop-color="rgba(70,136,220,0.78)" />
                          <stop offset="0.56" stop-color="rgba(127,220,255,0.9)" />
                          <stop offset="1" stop-color="#a4f0ff" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>
                  <p class="projects-empty-title">No projects yet</p>
                  <p class="projects-empty-copy">
                    Create a project, connect a Sentry organization, and Hotfix will pull in its
                    Sentry projects.
                  </p>
                </div>
              }
            >
              <div class="projects-collection" classList={{ "is-grid": viewMode() === "grid" }}>
                <For each={sortedProjects()}>
                  {(project) => (
                    <button
                      class="project-card"
                      classList={{
                        "is-grid": viewMode() === "grid",
                        "is-selected": selectedProjectId() === project.id,
                      }}
                      type="button"
                      aria-selected={selectedProjectId() === project.id}
                      onFocus={() => setSelectedProjectId(project.id)}
                      onMouseEnter={() => setSelectedProjectId(project.id)}
                      onClick={() => openProject(project.id)}
                    >
                      <div class="project-card-copy">
                        <h2 class="project-card-title">{project.name}</h2>
                        <Show when={viewMode() === "grid"}>
                          <p class="project-card-subtitle">
                            {project.sentryOrganization?.name ?? "No Sentry organization selected"}
                          </p>
                        </Show>
                        <p class="project-card-meta">{formatProjectDate(project.createdAt)}</p>
                      </div>

                      <div class="project-card-stats" classList={{ "is-inline": viewMode() === "list" }}>
                        <p class="project-card-count">
                          {formatSentryProjectCount(project.sentryProjects.length)}
                        </p>
                        <ProjectSparkline
                          seed={`${project.id}:${project.name}`}
                          compact={viewMode() === "list"}
                        />
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
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
              <button class="project-modal-close" type="button" onClick={closeCreateModal} aria-label="Close">
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
                <span class="project-field-label">Sentry organization</span>
                <div
                  class="projects-select-wrap"
                  classList={{ "is-disabled": sentryOrganizations().length === 0 }}
                >
                  <select
                    class="project-field-input project-field-select"
                    value={selectedConnectionId()}
                    onInput={(event) => setSelectedConnectionId(event.currentTarget.value)}
                    disabled={sentryOrganizations().length === 0}
                  >
                    <option value="">Select a Sentry organization</option>
                    <Show when={sentryOrganizations().length > 0}>
                      <For each={sentryOrganizations()}>
                        {(organization) => (
                          <option value={organization.connectionId}>
                            {organization.name}
                          </option>
                        )}
                      </For>
                    </Show>
                  </select>
                  <span class="projects-select-caret" aria-hidden="true">
                    <svg viewBox="0 0 16 16" fill="none">
                      <path d="m4.25 6.25 3.75 3.75 3.75-3.75" stroke="currentColor" stroke-width="1.15" />
                    </svg>
                  </span>
                </div>
                <Show when={sentryOrganizations().length > 0}>
                  <p class="project-field-helper">
                    Choose the Sentry organization Hotfix should import from.
                  </p>
                </Show>
                <Show when={sentryOrganizations().length === 0}>
                  <p class="project-field-helper">
                    <a class="project-inline-link" href="/api/auth/sentry/start">
                      Connect Sentry
                    </a>{" "}
                    to choose which organization to import.
                  </p>
                </Show>
              </label>

              <Show when={createError()}>
                {(message) => <p class="project-modal-error">{message()}</p>}
              </Show>

              <div class="project-modal-actions">
                <button class="project-modal-secondary" type="button" onClick={closeCreateModal}>
                  Cancel
                </button>
                <button
                  class="brand-button"
                  type="submit"
                  disabled={!canCreateProject()}
                >
                  {creating() ? "Creating..." : "Create project"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}

function ProjectWorkspace(props: {
  project: HotfixProject;
  onBack: () => void;
  onRename: (projectId: string, nextName: string) => Promise<void>;
}) {
  const [editingName, setEditingName] = createSignal(false);
  const [draftName, setDraftName] = createSignal(props.project.name);
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
      <header class="project-page-header">
        <div class="project-page-header-side">
          <button class="project-workspace-back" type="button" onClick={props.onBack}>
            <span aria-hidden="true">←</span>
            <span>Projects</span>
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
          <span class="project-page-header-meta">
            {savingName() ? "Saving..." : formatProjectDate(props.project.createdAt)}
          </span>
        </div>
      </header>

      <Show when={renameError()}>
        {(message) => <p class="project-workspace-error">{message()}</p>}
      </Show>

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

      <div class="project-workspace-grid">
        <div class="logged-in-card">
          <p class="logged-in-card-label">Project Overview</p>
          <h3 class="logged-in-card-title">Telemetry ingestion</h3>
          <p class="logged-in-card-copy">
            This project workspace will hold imported Sentry issues, traces, and logs for the
            linked repositories.
          </p>
        </div>
        <div class="logged-in-card">
          <p class="logged-in-card-label">Next Section</p>
          <h3 class="logged-in-card-title">Repository matching</h3>
          <p class="logged-in-card-copy">
            GitHub repo associations and unresolved Sentry project mappings will live in this area.
          </p>
        </div>
        <div class="logged-in-card">
          <p class="logged-in-card-label">Keyboard</p>
          <h3 class="logged-in-card-title">Navigation</h3>
          <p class="logged-in-card-copy">
            Press <span class="project-inline-kbd">Esc</span> to return to the project list.
          </p>
        </div>
      </div>
    </div>
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
          <path d="M4 4h8M4 8h8M4 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" stroke="currentColor" stroke-width="1.15" />
        </svg>
      </Show>
    </span>
  );
}

function UsageTab() {
  return (
    <div class="space-y-6">
      <div class="space-y-2">
        <p class="text-[0.68rem] font-medium uppercase tracking-[0.28em] text-[var(--text-muted)]">
          Usage
        </p>
        <h1 class="text-[1.62rem] font-medium tracking-[-0.05em] text-[var(--text-primary)] sm:text-[1.82rem]">
          Usage placeholder
        </h1>
        <p class="max-w-2xl text-sm text-[var(--text-secondary)]">
          This tab will eventually show quota, sync volume, imported telemetry volume, and model
          consumption.
        </p>
      </div>

      <div class="logged-in-metric-grid">
        <div class="logged-in-metric">
          <p class="logged-in-metric-label">Projects synced</p>
          <p class="logged-in-metric-value">12</p>
          <p class="logged-in-metric-copy">Sample value for the future usage dashboard.</p>
        </div>
        <div class="logged-in-metric">
          <p class="logged-in-metric-label">Events analyzed</p>
          <p class="logged-in-metric-value">84k</p>
          <p class="logged-in-metric-copy">Placeholder aggregate for errors, traces, and logs.</p>
        </div>
        <div class="logged-in-metric">
          <p class="logged-in-metric-label">Repo matches</p>
          <p class="logged-in-metric-value">91%</p>
          <p class="logged-in-metric-copy">This will become a real mapping-confidence view later.</p>
        </div>
      </div>
    </div>
  );
}

function SettingsTab(props: {
  user: SessionResponse["user"];
  notice: string | null;
  loggingOut: boolean;
  onLogout: () => Promise<void>;
}) {
  return (
    <div class="space-y-6">
      <div class="space-y-2">
        <p class="text-[0.68rem] font-medium uppercase tracking-[0.28em] text-[var(--text-muted)]">
          Settings
        </p>
        <h1 class="text-[1.62rem] font-medium tracking-[-0.05em] text-[var(--text-primary)] sm:text-[1.82rem]">
          Account placeholder
        </h1>
        <p class="max-w-2xl text-sm text-[var(--text-secondary)]">
          Provider connection controls and account preferences will live here.
        </p>
      </div>

      <div class="logged-in-card-grid">
        <div class="logged-in-card">
          <p class="logged-in-card-label">Signed in as</p>
          <h2 class="logged-in-card-title">{props.user?.displayName}</h2>
          <p class="logged-in-card-copy">{props.user?.email ?? "No email exposed by the provider."}</p>
        </div>
        <div class="logged-in-card">
          <p class="logged-in-card-label">Connections</p>
          <h2 class="logged-in-card-title">Provider status</h2>
          <p class="logged-in-card-copy">
            Sentry: {props.user?.providers.sentry ? "connected" : "not connected"}
          </p>
          <p class="logged-in-card-copy">
            GitHub: {props.user?.providers.github ? "connected" : "not connected"}
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm text-[var(--text-secondary)]">
          This is placeholder settings content. The logout action remains available here.
        </p>
        <button
          class="secondary-button w-full sm:w-auto sm:min-w-[9rem]"
          type="button"
          onClick={() => void props.onLogout()}
          disabled={props.loggingOut}
        >
          {props.loggingOut ? "Logging out..." : "Log out"}
        </button>
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

function SidebarIcon(props: { tab: AppTab }) {
  return (
    <span class="app-sidebar-icon" aria-hidden="true">
      <Show when={props.tab === "projects"}>
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M2.5 3.5h11v3h-11zM2.5 8.5h11v4h-11z" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </Show>
      <Show when={props.tab === "usage"}>
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M3 11.5V8.25M8 11.5V4.5M13 11.5V6.25" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </Show>
      <Show when={props.tab === "settings"}>
        <svg viewBox="0 0 16 16" fill="none">
          <path
            d="M8 4.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Zm0-2.25 1 .4.95-.55 1.2 1.2-.55.95.4 1 .95.55v1.7l-.95.55-.4 1 .55.95-1.2 1.2-.95-.55-1 .4-.55.95h-1.7l-.55-.95-1-.4-.95.55-1.2-1.2.55-.95-.4-1-.95-.55v-1.7l.95-.55.4-1-.55-.95 1.2-1.2.95.55 1-.4.55-.95h1.7L8 2.5Z"
            stroke="currentColor"
            stroke-width="1"
          />
        </svg>
      </Show>
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
      <h2 class="text-[1rem] font-medium tracking-[-0.02em] text-[var(--text-primary)]">{props.title}</h2>
      <p>{props.body}</p>
    </section>
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
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

function getProjectSlugFromPath(pathname: string) {
  if (!pathname || pathname === "/") {
    return null;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 1) {
    return null;
  }

  const [segment] = segments;
  if (!segment || segment === "api" || segment === "terms" || segment === "privacy") {
    return null;
  }

  return decodeURIComponent(segment);
}

function getProjectPath(slug: string | null) {
  return slug ? `/${encodeURIComponent(slug)}` : "/";
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

  return brandText
    .split("")
    .map((character, index) => {
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
