import { For, Show, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js";

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

type DashboardPayload = {
  sentryOrganizations: SentryOrganizationSummary[];
  projects: HotfixProject[];
};

type SentryOrganizationSummary = {
  connectionId: string;
  slug: string;
  name: string;
};

type HotfixProject = {
  id: string;
  name: string;
  sentryOrganization: SentryOrganizationSummary | null;
  sentryProjects: ImportedSentryProject[];
};

type ImportedSentryProject = {
  id: string;
  sentryProjectId: string;
  slug: string;
  name: string;
  platform: string | null;
  repoMapping: GitHubRepoMapping | null;
};

type GitHubRepoMapping = {
  repoId: number;
  fullName: string;
  url: string;
  defaultBranch: string | null;
};

type GitHubRepository = {
  id: number;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string | null;
  private: boolean;
};

type AppView = "auth" | "terms" | "privacy";
type BrandGlyph = {
  character: string;
  accent: boolean;
};

const fetchSession = async (): Promise<SessionResponse> => {
  return fetchJson<SessionResponse>("/api/session", {
    headers: {
      Accept: "application/json",
    },
  });
};

const fetchDashboard = async (): Promise<DashboardPayload> =>
  fetchJson<DashboardPayload>("/api/dashboard", {
    headers: {
      Accept: "application/json",
    },
  });

const fetchGitHubRepositories = async (): Promise<GitHubRepository[]> =>
  fetchJson<GitHubRepository[]>("/api/github/repositories", {
    headers: {
      Accept: "application/json",
    },
  });

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

  return (
    <main class="relative min-h-screen overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]">
      <div class="relative flex min-h-screen w-full flex-col p-4">
        <header class="absolute left-4 top-[0.7rem] z-10">
          <a href="/" class="brand-wordmark-link" aria-label="Go to home">
            <BrandWordmark mode={brandAnimationMode(view(), session())} />
          </a>
        </header>

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
                    <Show
                      when={session()?.authenticated && session()?.user}
                      fallback={<LoginPanel notice={notice()} />}
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
                </Show>
              </div>
            </div>
          </section>
        </Show>

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
  const [projectName, setProjectName] = createSignal("");
  const [projectBusyId, setProjectBusyId] = createSignal<string | null>(null);
  const [mappingBusyId, setMappingBusyId] = createSignal<string | null>(null);
  const [creatingProject, setCreatingProject] = createSignal(false);
  const [localNotice, setLocalNotice] = createSignal<string | null>(null);
  const [dashboard, { refetch: refetchDashboard }] = createResource(fetchDashboard);
  const [githubRepos, { refetch: refetchGitHubRepos }] = createResource(
    () => props.user?.providers.github,
    async (connected) => {
      if (!connected) {
        return [] as GitHubRepository[];
      }

      return fetchGitHubRepositories();
    },
  );

  const combinedNotice = () => localNotice() ?? props.notice;

  const createProject = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = projectName().trim();
    if (!name) {
      setLocalNotice("Project name cannot be empty.");
      return;
    }

    setCreatingProject(true);
    setLocalNotice(null);

    try {
      await fetchJson<HotfixProject>("/api/hotfix-projects", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });
      setProjectName("");
      await refetchDashboard();
    } catch (error) {
      setLocalNotice(error instanceof Error ? error.message : "Could not create the project.");
    } finally {
      setCreatingProject(false);
    }
  };

  const assignSentryOrganization = async (projectId: string, connectionId: string) => {
    if (!connectionId) {
      return;
    }

    setProjectBusyId(projectId);
    setLocalNotice(null);

    try {
      await fetchJson<HotfixProject>(`/api/hotfix-projects/${projectId}/sentry-connection`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ connectionId }),
      });
      await refetchDashboard();
    } catch (error) {
      setLocalNotice(
        error instanceof Error ? error.message : "Could not connect the Sentry organization.",
      );
    } finally {
      setProjectBusyId(null);
    }
  };

  const updateMapping = async (importedProjectId: string, repoId: string) => {
    setMappingBusyId(importedProjectId);
    setLocalNotice(null);

    try {
      await fetchJson<HotfixProject>(`/api/imported-sentry-projects/${importedProjectId}/repo-mapping`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repoId: repoId ? Number(repoId) : null,
        }),
      });
      await refetchDashboard();
      if (props.user?.providers.github) {
        await refetchGitHubRepos();
      }
    } catch (error) {
      setLocalNotice(
        error instanceof Error ? error.message : "Could not update the repository mapping.",
      );
    } finally {
      setMappingBusyId(null);
    }
  };

  const connectProvider = (provider: "github" | "sentry") => {
    window.location.assign(`/api/auth/${provider}/start`);
  };

  return (
    <div class="space-y-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div class="space-y-2">
          <p class="text-[0.68rem] font-medium uppercase tracking-[0.28em] text-[var(--text-muted)]">
            Hotfix projects
          </p>
          <div class="space-y-1">
            <h1 class="text-[1.9rem] font-medium tracking-[-0.05em] text-[var(--text-primary)] sm:text-[2.3rem]">
              Hello, {props.user?.displayName}
            </h1>
            <p class="text-sm text-[var(--text-secondary)]">
              Connect a Sentry organization, import its projects, and map each one to a GitHub repo.
            </p>
          </div>
        </div>

        <button
          class="auth-button w-full sm:w-auto sm:min-w-[9rem]"
          type="button"
          onClick={() => void props.onLogout()}
          disabled={props.loggingOut}
        >
          <span>{props.loggingOut ? "Logging out..." : "Log out"}</span>
        </button>
      </div>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div class="rounded-[4px] bg-[var(--surface)] px-4 py-4">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-1">
              <p class="text-sm font-medium text-[var(--text-primary)]">GitHub</p>
              <p class="text-sm text-[var(--text-secondary)]">
                {props.user?.providers.github
                  ? githubRepos.loading
                    ? "Loading repositories..."
                    : `${githubRepos()?.length ?? 0} accessible repositories`
                  : "Connect GitHub to map Sentry projects to repositories."}
              </p>
            </div>
            <button
              class="secondary-button"
              type="button"
              onClick={() => connectProvider("github")}
            >
              {props.user?.providers.github ? "Reconnect GitHub" : "Connect GitHub"}
            </button>
          </div>
        </div>

        <div class="rounded-[4px] bg-[var(--surface)] px-4 py-4">
          <div class="flex items-start justify-between gap-4">
            <div class="space-y-1">
              <p class="text-sm font-medium text-[var(--text-primary)]">Sentry organizations</p>
              <p class="text-sm text-[var(--text-secondary)]">
                {dashboard.loading
                  ? "Loading connected organizations..."
                  : dashboard()?.sentryOrganizations.length
                    ? `${dashboard()?.sentryOrganizations.length ?? 0} connected`
                    : "Connect a Sentry organization to import its projects."}
              </p>
            </div>
            <button
              class="secondary-button"
              type="button"
              onClick={() => connectProvider("sentry")}
            >
              Connect Sentry
            </button>
          </div>

          <Show when={dashboard()?.sentryOrganizations.length}>
            <div class="mt-3 flex flex-wrap gap-2">
              <For each={dashboard()?.sentryOrganizations}>
                {(organization) => (
                  <span class="rounded-[4px] bg-[rgba(255,255,255,0.05)] px-2.5 py-1.5 text-[0.74rem] text-[var(--text-secondary)]">
                    {organization.name}
                    <span class="ml-1 text-[var(--text-muted)]">/{organization.slug}</span>
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>

      <form class="rounded-[4px] bg-[var(--surface)] px-4 py-4" onSubmit={(event) => void createProject(event)}>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label class="flex-1 space-y-2">
            <span class="text-sm font-medium text-[var(--text-primary)]">Create a Hotfix project</span>
            <input
              class="dashboard-input w-full"
              type="text"
              value={projectName()}
              onInput={(event) => setProjectName(event.currentTarget.value)}
              placeholder="Payments API"
              maxLength={80}
            />
          </label>
          <button class="secondary-button h-10 min-w-[8.5rem]" type="submit" disabled={creatingProject()}>
            {creatingProject() ? "Creating..." : "Create project"}
          </button>
        </div>
      </form>

      <Show
        when={!dashboard.error}
        fallback={
          <FeedbackPanel
            eyebrow="Dashboard issue"
            title="The project dashboard is unavailable"
            message="Reconnect your providers or retry the request."
            actionLabel="Retry"
            onAction={() => void refetchDashboard()}
          />
        }
      >
        <Show
          when={!dashboard.loading}
          fallback={
            <div class="space-y-3">
              <div class="h-24 rounded-[4px] bg-[rgba(255,255,255,0.05)]" />
              <div class="h-24 rounded-[4px] bg-[rgba(255,255,255,0.05)]" />
            </div>
          }
        >
          <Show
            when={dashboard()?.projects.length}
            fallback={
              <div class="rounded-[4px] bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
                Create your first Hotfix project to start importing Sentry projects.
              </div>
            }
          >
            <div class="space-y-4">
              <For each={dashboard()?.projects}>
                {(project) => (
                  <section class="rounded-[4px] bg-[var(--surface)] px-4 py-4">
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div class="space-y-1">
                        <h2 class="text-lg font-medium tracking-[-0.03em] text-[var(--text-primary)]">
                          {project.name}
                        </h2>
                        <p class="text-sm text-[var(--text-secondary)]">
                          {project.sentryOrganization
                            ? `Importing from ${project.sentryOrganization.name} / ${project.sentryOrganization.slug}`
                            : "Select a connected Sentry organization to import projects."}
                        </p>
                      </div>

                      <label class="space-y-2 lg:w-[18rem]">
                        <span class="text-[0.72rem] font-medium uppercase tracking-[0.24em] text-[var(--text-muted)]">
                          Sentry org
                        </span>
                        <select
                          class="dashboard-select w-full"
                          value={project.sentryOrganization?.connectionId ?? ""}
                          onChange={(event) =>
                            void assignSentryOrganization(project.id, event.currentTarget.value)
                          }
                          disabled={projectBusyId() === project.id || !dashboard()?.sentryOrganizations.length}
                        >
                          <option value="">Select organization</option>
                          <For each={dashboard()?.sentryOrganizations}>
                            {(organization) => (
                              <option value={organization.connectionId}>
                                {organization.name} / {organization.slug}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                    </div>

                    <div class="mt-4 space-y-3">
                      <Show
                        when={project.sentryProjects.length}
                        fallback={
                          <div class="rounded-[4px] bg-[rgba(255,255,255,0.03)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                            {project.sentryOrganization
                              ? "No Sentry projects were imported for this organization yet."
                              : "No Sentry organization selected."}
                          </div>
                        }
                      >
                        <For each={project.sentryProjects}>
                          {(sentryProject) => (
                            <div class="grid gap-3 rounded-[4px] bg-[rgba(255,255,255,0.03)] px-3 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] lg:items-center">
                              <div class="space-y-1">
                                <div class="flex flex-wrap items-center gap-2">
                                  <p class="text-sm font-medium text-[var(--text-primary)]">
                                    {sentryProject.name}
                                  </p>
                                  <span class="rounded-[4px] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[0.7rem] text-[var(--text-secondary)]">
                                    {sentryProject.slug}
                                  </span>
                                  <Show when={sentryProject.platform}>
                                    <span class="rounded-[4px] bg-[rgba(127,220,255,0.08)] px-2 py-1 text-[0.7rem] text-[#8edbff]">
                                      {sentryProject.platform}
                                    </span>
                                  </Show>
                                </div>
                                <p class="text-sm text-[var(--text-secondary)]">
                                  {sentryProject.repoMapping
                                    ? `Linked to ${sentryProject.repoMapping.fullName}`
                                    : "No GitHub repository linked"}
                                </p>
                              </div>

                              <div class="space-y-2">
                                <label class="text-[0.72rem] font-medium uppercase tracking-[0.24em] text-[var(--text-muted)]">
                                  GitHub repo
                                </label>
                                <select
                                  class="dashboard-select w-full"
                                  value={sentryProject.repoMapping?.repoId?.toString() ?? ""}
                                  onChange={(event) =>
                                    void updateMapping(sentryProject.id, event.currentTarget.value)
                                  }
                                  disabled={
                                    mappingBusyId() === sentryProject.id ||
                                    !props.user?.providers.github ||
                                    githubRepos.loading
                                  }
                                >
                                  <option value="">
                                    {props.user?.providers.github
                                      ? githubRepos.loading
                                        ? "Loading repositories..."
                                        : "Select repository"
                                      : "Connect GitHub first"}
                                  </option>
                                  <For each={githubRepos()}>
                                    {(repo) => (
                                      <option value={repo.id.toString()}>
                                        {repo.fullName}
                                      </option>
                                    )}
                                  </For>
                                </select>
                              </div>
                            </div>
                          )}
                        </For>
                      </Show>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={combinedNotice()}>
        {(message) => (
          <p class="rounded-[4px] border border-[rgba(229,99,99,0.18)] bg-[rgba(71,24,24,0.35)] px-4 py-3 text-sm text-[rgba(255,197,197,0.94)]">
            {message()}
          </p>
        )}
      </Show>
    </div>
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
