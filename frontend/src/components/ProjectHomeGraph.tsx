import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";

const githubIcon = new URL("../assets/github.svg", import.meta.url).href;
const connectIcon = new URL("../assets/sidebar/icons8-connect-50.svg", import.meta.url).href;

type ProjectGraphNodeMetadata = {
  githubRepoId?: number;
  githubRepoFullName?: string | null;
  githubRepoUrl?: string | null;
  githubRepoDefaultBranch?: string | null;
  githubRepoSelectedBranch?: string | null;
  indexedCommitSha?: string | null;
  baseDirectory?: string | null;
  indexingStatus?: string | null;
  indexingPercentage?: number;
  sentryProjectId?: string;
  slug?: string;
  linkedSentryProjectName?: string | null;
  linkedSentryProjectSlug?: string | null;
  linkedSentryProjectPlatform?: string | null;
  platform?: string | null;
  included?: boolean;
  errors24h?: number;
  transactions24h?: number;
  errors24hSeries?: number[];
  transactions24hSeries?: number[];
  replays24h?: number;
  profiles24h?: number;
  sentryRepoConnected?: boolean;
  hotfixRepoConnected?: boolean;
};

type ProjectGraphNode = {
  id: string;
  importedSentryProjectId: string | null;
  nodeKey: string;
  nodeType: string;
  label: string;
  description: string | null;
  positionX: number;
  positionY: number;
  metadata: ProjectGraphNodeMetadata;
  isSystem: boolean;
};

type ProjectGraphEdge = {
  id: string;
  edgeKey: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
  metadata: ProjectGraphEdgeMetadata;
  isSystem: boolean;
};

type ProjectGraphEdgeMetadata = {
  summary?: string;
  interactionType?: string | null;
  transport?: string | null;
  touchpoints?: string | null;
  dataContract?: string | null;
  contextNotInCode?: string | null;
  [key: string]: unknown;
};

type ProjectGraphPayload = {
  projectId: string;
  projectSlug: string;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
};

type ProjectGraphLayoutNode = {
  id: string;
  positionX: number;
  positionY: number;
};

type ImportedProjectActivityPayload = {
  importedProjectId: string;
  projectName: string;
  errors: ImportedProjectErrorLog[];
  transactions: ImportedProjectTransactionLog[];
};

type ImportedProjectErrorLog = {
  id: string;
  eventId?: string | null;
  title: string;
  culprit?: string | null;
  level?: string | null;
  eventType?: string | null;
  timestamp: string;
};

type ImportedProjectTransactionLog = {
  name: string;
  count: number;
  avgDurationMs?: number | null;
};

type ProjectMiniChartData = {
  errors: number[];
  transactions: number[];
};

type CreateProjectGraphEdgeInput = {
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  interactionType: string;
  transport: string;
  touchpoints: string;
  dataContract: string;
  contextNotInCode: string;
};

type CreateProjectGraphItemInput = {
  name: string;
  description: string;
  githubRepoId: number;
  branch: string;
  baseDirectory: string;
  linkedImportedSentryProjectId: string | null;
};

type GitHubRepositoryPayload = {
  id: number;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string | null;
  private: boolean;
};

type GitHubBranchPayload = {
  name: string;
  commitSha: string;
  isDefault: boolean;
};

type ImportedSentryProjectSummary = {
  id: string;
  sentryProjectId: string;
  slug: string;
  name: string;
  platform: string | null;
  included: boolean;
};

type GraphVisualState = {
  selectedNodeId: string | null;
  linkSourceNodeId: string | null;
};

type EdgeDraft = CreateProjectGraphEdgeInput;

type ProjectHomeGraphProps = {
  projectId: string;
  refreshKey: string;
  sentryProjects: ImportedSentryProjectSummary[];
};

const GRAPH_CARD_WIDTH = 248;
const GRAPH_CARD_HEIGHT = 154;
const GRAPH_CARD_COLUMN_GAP = 88;
const GRAPH_CARD_ROW_GAP = 72;
const GRAPH_GRID_MAX_COLUMNS = 4;
const GRAPH_LAYOUT_START_Y = 120;
const GRAPH_ZOOM_MIN = 0.62;
const GRAPH_ZOOM_MAX = 1.55;
const GRAPH_DEFAULT_FIT_SCALE = 0.9;
const GRAPH_PANEL_FIT_SCALE = 0.68;
const GRAPH_DRAG_CLICK_SUPPRESSION_MS = 280;
const GRAPH_DRAG_HANDLE_SELECTOR = "[data-node-drag-handle]";

let echartsModulePromise: Promise<typeof import("echarts")> | null = null;

type EditorHandle = {
  destroy: () => void;
  setVisualState: (state: GraphVisualState) => void;
  fitToView: (scale?: number) => Promise<void>;
  zoomBy: (multiplier: number) => Promise<void>;
};

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? "Request failed.");
  }

  return payload as T;
}

async function fetchProjectGraph(projectId: string) {
  return fetchJson<ProjectGraphPayload>(`/api/hotfix-projects/${projectId}/graph`, {
    headers: {
      Accept: "application/json",
    },
  });
}

async function fetchImportedProjectActivity(importedProjectId: string) {
  return fetchJson<ImportedProjectActivityPayload>(
    `/api/imported-sentry-projects/${importedProjectId}/activity`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );
}

async function persistProjectGraphLayout(projectId: string, nodes: ProjectGraphLayoutNode[]) {
  await fetchJson(`/api/hotfix-projects/${projectId}/graph/layout`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      nodes,
    }),
  });
}

async function createProjectGraphEdge(projectId: string, input: CreateProjectGraphEdgeInput) {
  return fetchJson<ProjectGraphPayload>(`/api/hotfix-projects/${projectId}/graph/edges`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

async function fetchGitHubRepositories() {
  return fetchJson<GitHubRepositoryPayload[]>("/api/github/repositories", {
    headers: {
      Accept: "application/json",
    },
  });
}

async function fetchGitHubBranches(repoId: number, query: string) {
  const search = query.trim();
  const url =
    search.length > 0
      ? `/api/github/repositories/${repoId}/branches?q=${encodeURIComponent(search)}`
      : `/api/github/repositories/${repoId}/branches`;
  return fetchJson<GitHubBranchPayload[]>(url, {
    headers: {
      Accept: "application/json",
    },
  });
}

async function createProjectGraphItem(projectId: string, input: CreateProjectGraphItemInput) {
  return fetchJson<ProjectGraphPayload>(`/api/hotfix-projects/${projectId}/graph/items`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

function nodeSubtitle(node: ProjectGraphNode) {
  return node.description ?? node.metadata.linkedSentryProjectSlug ?? "No description";
}

function nodeFooter(node: ProjectGraphNode) {
  const branch = node.metadata.githubRepoSelectedBranch ?? node.metadata.githubRepoDefaultBranch;
  const repoLabel = branch
    ? `${node.metadata.githubRepoFullName ?? "GitHub repo"} @ ${branch}`
    : (node.metadata.githubRepoFullName ?? "GitHub repo");
  if (node.metadata.baseDirectory) {
    return `${repoLabel} · ${node.metadata.baseDirectory}`;
  }

  return repoLabel;
}

function nodeStatus(node: ProjectGraphNode) {
  const indexingStatus = (node.metadata.indexingStatus ?? "pending").toLowerCase();
  const percentage = Math.max(0, Math.min(100, Number(node.metadata.indexingPercentage ?? 0)));

  if (indexingStatus === "indexed" || indexingStatus === "ready" || percentage >= 100) {
    return "Indexed";
  }

  if (indexingStatus === "indexing" || percentage > 0) {
    return `Indexing ${percentage}%`;
  }

  if (indexingStatus === "failed") {
    return "Indexing failed";
  }

  return "Queued for indexing";
}

function nodeStatusClass(node: ProjectGraphNode) {
  const indexingStatus = (node.metadata.indexingStatus ?? "pending").toLowerCase();
  if (indexingStatus === "failed") {
    return "is-muted";
  }
  if (indexingStatus === "indexed" || indexingStatus === "ready") {
    return "is-online";
  }
  return "is-pending";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function buildSnappyConnectorPath(start: { x: number; y: number }, end: { x: number; y: number }) {
  const lead = 18;
  const deltaX = end.x - start.x;
  const midpointOffset = clamp(deltaX / 2, -40, 40);
  const trunkX =
    start.x + (Math.abs(deltaX) > lead * 2 ? midpointOffset : deltaX >= 0 ? lead : -lead);

  return `M ${start.x} ${start.y} L ${trunkX} ${start.y} L ${trunkX} ${end.y} L ${end.x} ${end.y}`;
}

function formatMetricCount(value: number | undefined) {
  const count = value ?? 0;
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}m`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`;
  }
  return count.toString();
}

function formatDuration(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  }
  return `${Math.round(value)}ms`;
}

function formatActivityTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fallbackSeries(total: number | undefined, bucketCount = 12) {
  const count = Math.max(0, total ?? 0);
  if (count === 0) {
    return Array.from({ length: bucketCount }, () => 0);
  }

  const values = Array.from({ length: bucketCount }, () => 0);
  values[bucketCount - 1] = count;
  return values;
}

function normalizeSeries(
  series: number[] | undefined,
  total: number | undefined,
  bucketCount = 12,
) {
  if (!Array.isArray(series) || series.length === 0) {
    return fallbackSeries(total, bucketCount);
  }

  const trimmed = series.slice(-bucketCount).map((value) => Math.max(0, Number(value) || 0));
  if (trimmed.length === bucketCount) {
    return trimmed;
  }

  return [...Array.from({ length: bucketCount - trimmed.length }, () => 0), ...trimmed];
}

function chartDataForNode(node: ProjectGraphNode): ProjectMiniChartData {
  return {
    errors: normalizeSeries(node.metadata.errors24hSeries, node.metadata.errors24h),
    transactions: normalizeSeries(
      node.metadata.transactions24hSeries,
      node.metadata.transactions24h,
    ),
  };
}

function nodeConnectionBadgeClass(isConnected: boolean | undefined) {
  return `project-graph-node-card-badge ${isConnected ? "is-connected" : "is-disconnected"}`;
}

const EDGE_INTERACTION_TYPES = [
  { value: "http_api", label: "HTTP API" },
  { value: "background_job", label: "Background job" },
  { value: "queue_or_event", label: "Queue or event" },
  { value: "database_dependency", label: "Database dependency" },
  { value: "shared_state", label: "Shared state or cache" },
  { value: "auth_or_session", label: "Auth or session" },
  { value: "internal_library", label: "Internal package or SDK" },
  { value: "other", label: "Other" },
] as const;

function createDefaultEdgeDraft(sourceNodeId: string, targetNodeId: string): EdgeDraft {
  return {
    sourceNodeId,
    targetNodeId,
    label: "",
    interactionType: "http_api",
    transport: "",
    touchpoints: "",
    dataContract: "",
    contextNotInCode: "",
  };
}

function loadEcharts() {
  if (!echartsModulePromise) {
    echartsModulePromise = import("echarts");
  }

  return echartsModulePromise;
}

class ProjectMiniChartElement extends HTMLElement {
  private chartDataValue: ProjectMiniChartData = { errors: [], transactions: [] };
  private chartInstance: import("echarts").ECharts | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private renderFrame = 0;

  connectedCallback() {
    this.style.display = "block";
    this.style.width = "100%";
    this.style.height = "100%";
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.chartInstance) {
          this.chartInstance.resize();
        }
        void this.renderChart();
      });
      this.resizeObserver.observe(this);
    }
    void this.renderChart();
  }

  disconnectedCallback() {
    if (this.renderFrame) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.chartInstance?.dispose();
    this.chartInstance = null;
  }

  set chartData(value: ProjectMiniChartData) {
    this.chartDataValue = value;
    void this.renderChart();
  }

  get chartData() {
    return this.chartDataValue;
  }

  private async renderChart() {
    if (!this.isConnected) {
      return;
    }

    if (this.clientWidth < 16 || this.clientHeight < 12) {
      if (this.renderFrame) {
        window.cancelAnimationFrame(this.renderFrame);
      }
      this.renderFrame = window.requestAnimationFrame(() => {
        this.renderFrame = 0;
        void this.renderChart();
      });
      return;
    }

    const echarts = await loadEcharts();
    if (!this.isConnected) {
      return;
    }

    if (!this.chartInstance) {
      this.chartInstance = echarts.init(this, undefined, {
        renderer: "canvas",
      });
    }

    const transactions = this.chartDataValue.transactions;
    const errors = this.chartDataValue.errors;
    const length = Math.max(transactions.length, errors.length, 12);
    const transactionValues = normalizeSeries(transactions, undefined, length);
    const errorValues = normalizeSeries(errors, undefined, length);

    this.chartInstance.setOption(
      {
        animation: false,
        grid: {
          left: 0,
          right: 0,
          top: 2,
          bottom: 0,
        },
        tooltip: {
          trigger: "axis",
          axisPointer: {
            type: "shadow",
          },
          backgroundColor: "rgba(4, 4, 6, 0.94)",
          borderColor: "rgba(255, 255, 255, 0.08)",
          textStyle: {
            color: "rgba(248, 245, 238, 0.92)",
            fontFamily: "Geist, sans-serif",
            fontSize: 11,
          },
        },
        xAxis: {
          type: "category",
          show: false,
          data: transactionValues.map((_, index) => index + 1),
        },
        yAxis: {
          type: "value",
          show: false,
        },
        series: [
          {
            type: "bar",
            stack: "activity",
            silent: true,
            data: transactionValues,
            barWidth: "58%",
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: "rgba(127, 220, 255, 0.62)" },
                { offset: 1, color: "rgba(127, 220, 255, 0.18)" },
              ]),
              borderRadius: [2, 2, 0, 0],
            },
            emphasis: {
              disabled: true,
            },
          },
          {
            type: "bar",
            stack: "activity",
            silent: true,
            data: errorValues,
            barWidth: "58%",
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: "rgba(171, 197, 255, 0.82)" },
                { offset: 1, color: "rgba(171, 197, 255, 0.28)" },
              ]),
              borderRadius: [2, 2, 0, 0],
            },
            emphasis: {
              disabled: true,
            },
          },
        ],
      },
      true,
    );
  }
}

if (!customElements.get("project-mini-chart")) {
  customElements.define("project-mini-chart", ProjectMiniChartElement);
}

function waitForAnimationFrame(count = 1) {
  return new Promise<void>((resolve) => {
    const tick = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }

      window.requestAnimationFrame(() => tick(remaining - 1));
    };

    tick(count);
  });
}

function buildGridLayout(nodes: ProjectGraphNode[]) {
  const columns = Math.min(Math.max(Math.ceil(Math.sqrt(nodes.length)), 1), GRAPH_GRID_MAX_COLUMNS);
  const totalWidth = columns * GRAPH_CARD_WIDTH + (columns - 1) * GRAPH_CARD_COLUMN_GAP;
  const startX = totalWidth * -0.5;

  const nextNodes = nodes.map((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);

    return {
      ...node,
      positionX: startX + column * (GRAPH_CARD_WIDTH + GRAPH_CARD_COLUMN_GAP),
      positionY: GRAPH_LAYOUT_START_Y + row * (GRAPH_CARD_HEIGHT + GRAPH_CARD_ROW_GAP),
    };
  });

  return {
    nextNodes,
    layout: nextNodes.map((node) => ({
      id: node.id,
      positionX: node.positionX,
      positionY: node.positionY,
    })),
  };
}

function normalizeGraphLayout(graph: ProjectGraphPayload) {
  const intersects = graph.nodes.some((node, index) =>
    graph.nodes.slice(index + 1).some((other) => {
      const horizontalOverlap =
        node.positionX < other.positionX + GRAPH_CARD_WIDTH + 16 &&
        node.positionX + GRAPH_CARD_WIDTH + 16 > other.positionX;
      const verticalOverlap =
        node.positionY < other.positionY + GRAPH_CARD_HEIGHT + 16 &&
        node.positionY + GRAPH_CARD_HEIGHT + 16 > other.positionY;

      return horizontalOverlap && verticalOverlap;
    }),
  );

  if (!intersects) {
    return {
      graph,
      layout: [] as ProjectGraphLayoutNode[],
      changed: false,
    };
  }

  const { nextNodes, layout } = buildGridLayout(graph.nodes);

  return {
    graph: {
      ...graph,
      nodes: nextNodes,
    },
    layout,
    changed: true,
  };
}

function panelFacts(node: ProjectGraphNode) {
  return [
    {
      label: "GitHub repo",
      value: node.metadata.githubRepoFullName ?? "Not connected",
    },
    {
      label: "Selected branch",
      value:
        node.metadata.githubRepoSelectedBranch ??
        node.metadata.githubRepoDefaultBranch ??
        "Not selected",
    },
    {
      label: "Indexed commit",
      value: node.metadata.indexedCommitSha?.slice(0, 12) ?? "Pending",
    },
    {
      label: "Base directory",
      value: node.metadata.baseDirectory ?? "Repository root",
    },
    {
      label: "Indexing",
      value: nodeStatus(node),
    },
    {
      label: "Linked Sentry project",
      value: node.metadata.linkedSentryProjectName ?? "Not connected",
    },
    {
      label: "24h errors",
      value: formatMetricCount(node.metadata.errors24h),
    },
    {
      label: "24h transactions",
      value: formatMetricCount(node.metadata.transactions24h),
    },
    {
      label: "Sentry repo",
      value: node.metadata.sentryRepoConnected ? "Connected" : "Not connected",
    },
    {
      label: "Hotfix repo",
      value: node.metadata.hotfixRepoConnected
        ? (node.metadata.githubRepoFullName ?? "Connected")
        : "Not connected",
    },
  ];
}

async function mountProjectGraphEditor(
  container: HTMLDivElement,
  graph: ProjectGraphPayload,
  onLayoutChange: (nodes: ProjectGraphLayoutNode[]) => Promise<void>,
  onNodeActivate: (nodeId: string | null) => void,
): Promise<EditorHandle> {
  const [
    { NodeEditor, ClassicPreset },
    { AreaPlugin, AreaExtensions },
    { LitPlugin, Presets: LitPresets },
    { html },
  ] = await Promise.all([
    import("rete"),
    import("rete-area-plugin"),
    import("@retejs/lit-plugin"),
    import("lit"),
  ]);

  container.replaceChildren();

  const editor = new NodeEditor<any>();
  const area = new AreaPlugin<any>(container);
  const render = new LitPlugin<any>();
  const resizeObserver = new ResizeObserver(() => {
    void area.area.translate(area.area.transform.x, area.area.transform.y);
  });

  editor.use(area);
  area.use(render);
  AreaExtensions.restrictor(area, {
    scaling: {
      min: GRAPH_ZOOM_MIN,
      max: GRAPH_ZOOM_MAX,
    },
  });

  const svgNamespace = "http://www.w3.org/2000/svg";
  const backgroundSvg = document.createElementNS(svgNamespace, "svg");
  backgroundSvg.classList.add("project-graph-background-svg");
  const backgroundPaths = new Map<string, SVGPathElement>();

  render.addPipe((context: any) => {
    if (context.type === "connectionpath") {
      const [start, end] = context.data.points;
      return {
        ...context,
        data: {
          ...context.data,
          path: buildSnappyConnectorPath(start, end),
        },
      };
    }

    return context;
  });

  render.addPreset(
    LitPresets.classic.setup({
      customize: {
        node(context) {
          const node = (context.payload as ProjectGraphNodeInstance).graphNode as ProjectGraphNode;
          return ({ emit }) => {
            const inputSocketData = {
              type: "socket",
              side: "input",
              key: "in",
              nodeId: node.id,
              payload: (context.payload as any).inputs?.in?.socket ?? null,
            };
            const outputSocketData = {
              type: "socket",
              side: "output",
              key: "out",
              nodeId: node.id,
              payload: (context.payload as any).outputs?.out?.socket ?? null,
            };

            return html`
              <article
                class="project-graph-node-card ${nodeStatusClass(node)}"
                data-node-id=${node.id}
                aria-label=${node.label}
              >
                <span class="project-graph-node-socket-anchor is-input" aria-hidden="true">
                  <rete-ref .data=${inputSocketData} .emit=${emit}></rete-ref>
                </span>

                <span class="project-graph-node-socket-anchor is-output" aria-hidden="true">
                  <rete-ref .data=${outputSocketData} .emit=${emit}></rete-ref>
                </span>

                <div class="project-graph-node-card-body">
                  <div class="project-graph-node-card-top">
                    <div class="project-graph-node-card-header">
                      <span class="project-graph-node-card-icon" aria-hidden="true">
                        <img src=${githubIcon} alt="" />
                      </span>
                      <div class="project-graph-node-card-copy">
                        <p class="project-graph-node-card-title">${node.label}</p>
                        <p class="project-graph-node-card-subtitle">${nodeSubtitle(node)}</p>
                      </div>
                    </div>

                    <div class="project-graph-node-actions">
                      <button
                        class="project-graph-node-drag-handle"
                        type="button"
                        tabindex="-1"
                        data-node-drag-handle
                        aria-label="Drag node"
                      >
                        <span></span>
                        <span></span>
                        <span></span>
                        <span></span>
                      </button>

                      <button
                        class="project-graph-node-connect-handle"
                        type="button"
                        tabindex="-1"
                        data-node-connect-handle
                        data-node-id=${node.id}
                        aria-label=${`Start connection from ${node.label}`}
                      >
                        <span class="project-graph-node-connect-icon" aria-hidden="true">
                          <span
                            class="project-graph-node-connect-icon-mask"
                            style=${`--connect-icon: url("${connectIcon}")`}
                          ></span>
                        </span>
                      </button>
                    </div>
                  </div>

                  <div class="project-graph-node-card-metrics">
                    <p class="project-graph-node-card-status ${nodeStatusClass(node)}">
                      ${nodeStatus(node)}
                    </p>
                    <p class="project-graph-node-card-footer-platform">${nodeFooter(node)}</p>
                  </div>

                  <div class="project-graph-node-card-badges">
                    <span class=${nodeConnectionBadgeClass(Boolean(node.importedSentryProjectId))}>
                      ${node.importedSentryProjectId ? "Sentry linked" : "Sentry missing"}
                    </span>
                    <span
                      class=${nodeConnectionBadgeClass(Boolean(node.metadata.hotfixRepoConnected))}
                    >
                      ${node.metadata.hotfixRepoConnected ? "GitHub linked" : "GitHub missing"}
                    </span>
                  </div>
                </div>

                <div class="project-graph-node-card-footer">
                  <project-mini-chart
                    class="project-graph-node-mini-chart"
                    .chartData=${chartDataForNode(node)}
                  ></project-mini-chart>
                </div>
              </article>
            `;
          };
        },
        socket(context) {
          return () => html`
            <span
              class="project-graph-socket project-graph-socket--${context.side}"
              aria-hidden="true"
            ></span>
          `;
        },
      },
    }) as any,
  );

  const socket = new ClassicPreset.Socket("hotfix-graph");

  class ProjectGraphNodeInstance extends ClassicPreset.Node {
    graphNode: ProjectGraphNode;

    constructor(graphNode: ProjectGraphNode) {
      super(graphNode.label);
      this.id = graphNode.id;
      this.graphNode = graphNode;

      Object.assign(this, {
        width: GRAPH_CARD_WIDTH,
        height: GRAPH_CARD_HEIGHT,
      });

      this.addInput("in", new ClassicPreset.Input(socket, "", true));
      this.addOutput("out", new ClassicPreset.Output(socket, "", true));
    }
  }

  const nodesById = new Map<string, ProjectGraphNodeInstance>();
  for (const node of graph.nodes) {
    const nextNode = new ProjectGraphNodeInstance(node);
    nodesById.set(node.id, nextNode);
    await editor.addNode(nextNode);
    await area.translate(nextNode.id, { x: node.positionX, y: node.positionY });
  }

  area.area.content.holder.insertBefore(backgroundSvg, area.area.content.holder.firstChild);

  const nodeCenterFromView = (nodeId: string) => {
    const view = area.nodeViews.get(nodeId);
    if (!view) {
      return null;
    }

    return {
      x: view.position.x + GRAPH_CARD_WIDTH / 2,
      y: view.position.y + GRAPH_CARD_HEIGHT / 2,
    };
  };

  const updateBackgroundPath = (edge: ProjectGraphEdge) => {
    const sourceCenter = nodeCenterFromView(edge.sourceNodeId);
    const targetCenter = nodeCenterFromView(edge.targetNodeId);
    if (!sourceCenter || !targetCenter) {
      return;
    }

    let pathElement = backgroundPaths.get(edge.id);
    if (!pathElement) {
      pathElement = document.createElementNS(svgNamespace, "path");
      pathElement.classList.add(
        "project-graph-background-path",
        edge.isSystem ? "is-system" : "is-relationship",
      );
      pathElement.setAttribute("vector-effect", "non-scaling-stroke");
      backgroundSvg.appendChild(pathElement);
      backgroundPaths.set(edge.id, pathElement);
    }

    pathElement.setAttribute("d", buildSnappyConnectorPath(sourceCenter, targetCenter));
  };

  const updateBackgroundPaths = () => {
    for (const edge of graph.edges) {
      updateBackgroundPath(edge);
    }
  };

  updateBackgroundPaths();

  if (nodesById.size > 0) {
    await AreaExtensions.zoomAt(area, Array.from(nodesById.values()) as any[], {
      scale: 0.9,
    });
  }

  const applyVisualState = (state: GraphVisualState) => {
    const nodeCards = container.querySelectorAll<HTMLElement>("[data-node-id]");
    for (const card of nodeCards) {
      const nodeId = card.dataset.nodeId ?? null;
      card.classList.toggle("is-selected", nodeId === state.selectedNodeId);
      card.classList.toggle("is-link-source", nodeId === state.linkSourceNodeId);

      const connectButton = card.querySelector<HTMLButtonElement>("[data-node-connect-handle]");
      if (connectButton) {
        const isOtherConnectorArmed =
          Boolean(state.linkSourceNodeId) && state.linkSourceNodeId !== nodeId;
        connectButton.disabled = isOtherConnectorArmed;
        connectButton.classList.toggle("is-disabled", isOtherConnectorArmed);
        connectButton.classList.toggle("is-active", nodeId === state.linkSourceNodeId);
      }
    }
  };

  let pointerCandidate: {
    nodeId: string;
    x: number;
    y: number;
  } | null = null;
  let activePointerNodeId: string | null = null;
  let draggedNodeId: string | null = null;
  let translatedDuringPointer = false;
  let suppressClickNodeId: string | null = null;
  let suppressClickUntil = 0;

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const card = target.closest<HTMLElement>("[data-node-id]");
    if (!card?.dataset.nodeId) {
      return;
    }

    if (!target.closest(GRAPH_DRAG_HANDLE_SELECTOR)) {
      pointerCandidate = null;
      activePointerNodeId = null;
      draggedNodeId = null;
      translatedDuringPointer = false;
      event.stopPropagation();
      return;
    }

    pointerCandidate = {
      nodeId: card.dataset.nodeId,
      x: event.clientX,
      y: event.clientY,
    };
    activePointerNodeId = card.dataset.nodeId;
    draggedNodeId = null;
    translatedDuringPointer = false;
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!pointerCandidate) {
      return;
    }

    const deltaX = Math.abs(event.clientX - pointerCandidate.x);
    const deltaY = Math.abs(event.clientY - pointerCandidate.y);
    if (deltaX > 4 || deltaY > 4) {
      draggedNodeId = pointerCandidate.nodeId;
    }
  };

  const clearPointerTracking = () => {
    if (draggedNodeId || translatedDuringPointer) {
      suppressClickNodeId = draggedNodeId ?? activePointerNodeId;
      suppressClickUntil = performance.now() + GRAPH_DRAG_CLICK_SUPPRESSION_MS;
    }

    pointerCandidate = null;
    activePointerNodeId = null;
    draggedNodeId = null;
    translatedDuringPointer = false;
  };

  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const card = target.closest<HTMLElement>("[data-node-id]");
    if (!card) {
      return;
    }

    const connectHandle = target.closest<HTMLElement>("[data-node-connect-handle]");
    if (connectHandle?.dataset.nodeId) {
      event.preventDefault();
      event.stopPropagation();
      onNodeActivate(`connect:${connectHandle.dataset.nodeId}`);
      return;
    }

    if (target.closest(GRAPH_DRAG_HANDLE_SELECTOR)) {
      return;
    }

    const nodeId = card.dataset.nodeId ?? null;
    if (nodeId && suppressClickNodeId === nodeId && performance.now() < suppressClickUntil) {
      suppressClickNodeId = null;
      return;
    }

    onNodeActivate(nodeId);
  };

  container.addEventListener("pointerdown", handlePointerDown, true);
  container.addEventListener("click", handleClick);
  window.addEventListener("pointermove", handlePointerMove, true);
  window.addEventListener("pointerup", clearPointerTracking, true);
  window.addEventListener("pointercancel", clearPointerTracking, true);
  resizeObserver.observe(container);

  const pendingLayout = new Map<string, ProjectGraphLayoutNode>();
  let saveTimeoutId: number | undefined;

  const flushLayout = async () => {
    if (pendingLayout.size === 0) {
      return;
    }

    const nodes = Array.from(pendingLayout.values());
    pendingLayout.clear();
    await onLayoutChange(nodes);
  };

  area.addPipe((context: any) => {
    if (context.type === "nodetranslated") {
      if (
        typeof context.data.id === "string" &&
        activePointerNodeId &&
        context.data.id === activePointerNodeId
      ) {
        translatedDuringPointer = true;
        draggedNodeId = context.data.id;
      }

      pendingLayout.set(context.data.id, {
        id: context.data.id,
        positionX: context.data.position.x,
        positionY: context.data.position.y,
      });

      for (const edge of graph.edges) {
        if (edge.sourceNodeId === context.data.id || edge.targetNodeId === context.data.id) {
          updateBackgroundPath(edge);
        }
      }

      if (saveTimeoutId !== undefined) {
        window.clearTimeout(saveTimeoutId);
      }

      saveTimeoutId = window.setTimeout(() => {
        void flushLayout();
      }, 260);
    }

    return context;
  });

  return {
    destroy() {
      if (saveTimeoutId !== undefined) {
        window.clearTimeout(saveTimeoutId);
      }

      container.removeEventListener("pointerdown", handlePointerDown, true);
      container.removeEventListener("click", handleClick);
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", clearPointerTracking, true);
      window.removeEventListener("pointercancel", clearPointerTracking, true);
      resizeObserver.disconnect();
      backgroundSvg.remove();
      backgroundPaths.clear();
      area.destroy();
      container.replaceChildren();
    },
    setVisualState(state: GraphVisualState) {
      applyVisualState(state);
    },
    async fitToView(scale = 0.9) {
      if (nodesById.size === 0) {
        return;
      }

      await AreaExtensions.zoomAt(area, Array.from(nodesById.values()) as any[], {
        scale: clamp(scale, GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX),
      });
    },
    async zoomBy(multiplier: number) {
      const currentZoom = area.area.transform.k;
      const nextZoom = clamp(currentZoom * multiplier, GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX);
      const delta = nextZoom / currentZoom - 1;
      const offsetX = container.clientWidth * -0.5 * delta;
      const offsetY = container.clientHeight * -0.5 * delta;

      if (Math.abs(nextZoom - currentZoom) < 0.0001) {
        return;
      }

      await area.area.zoom(nextZoom, offsetX, offsetY);
    },
  };
}

function GraphControls(props: {
  onReorganize: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  return (
    <div class="project-home-controls" aria-label="Graph controls">
      <div class="project-home-control-group">
        <button
          class="project-home-control-button"
          type="button"
          aria-label="Reorganize nodes"
          onClick={props.onReorganize}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="4.5" y="4.5" width="5" height="5" rx="1.15" />
            <rect x="14.5" y="4.5" width="5" height="5" rx="1.15" />
            <rect x="4.5" y="14.5" width="5" height="5" rx="1.15" />
            <rect x="14.5" y="14.5" width="5" height="5" rx="1.15" />
          </svg>
        </button>
        <button
          class="project-home-control-button"
          type="button"
          aria-label="Zoom in"
          onClick={props.onZoomIn}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 6.5v11M6.5 12h11" />
          </svg>
        </button>
        <button
          class="project-home-control-button"
          type="button"
          aria-label="Zoom out"
          onClick={props.onZoomOut}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6.5 12h11" />
          </svg>
        </button>
        <button
          class="project-home-control-button"
          type="button"
          aria-label="Fit graph to view"
          onClick={props.onFit}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4" />
            <path d="M9 5 5 9M15 5l4 4M9 19l-4-4M15 19l4-4" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function ProjectNodePanel(props: { node: ProjectGraphNode; onClose: () => void }) {
  const [activity] = createResource(
    () => props.node.importedSentryProjectId,
    async (importedProjectId) => {
      if (!importedProjectId) {
        return null;
      }

      return fetchImportedProjectActivity(importedProjectId);
    },
  );

  return (
    <aside class="project-node-panel">
      <header class="project-node-panel-header">
        <div class="project-node-panel-heading">
          <span class="project-node-panel-icon" aria-hidden="true">
            <img src={githubIcon} alt="" />
          </span>
          <div class="project-node-panel-copy">
            <h2 class="project-node-panel-title">{props.node.label}</h2>
            <p class="project-node-panel-subtitle">{nodeSubtitle(props.node)}</p>
          </div>
        </div>

        <button
          class="project-node-panel-close"
          type="button"
          onClick={props.onClose}
          aria-label="Close panel"
        >
          ×
        </button>
      </header>

      <div class="project-node-panel-body">
        <div class="project-node-panel-facts">
          <For each={panelFacts(props.node)}>
            {(fact) => (
              <div class="project-node-panel-fact">
                <p class="project-node-panel-fact-label">{fact.label}</p>
                <p class="project-node-panel-fact-value">{fact.value}</p>
              </div>
            )}
          </For>
        </div>

        <div class="project-node-panel-section">
          <div class="project-node-panel-section-header">
            <p class="project-node-panel-section-title">Recent errors & events</p>
            <span class="project-node-panel-badge">24h</span>
          </div>

          <Show when={!props.node.importedSentryProjectId}>
            <p class="project-node-panel-copyline">
              This item is not linked to a Sentry project yet. Connect one from the item modal or
              project settings.
            </p>
          </Show>

          <Show when={activity.loading}>
            <p class="project-node-panel-copyline">Loading Sentry activity…</p>
          </Show>

          <Show when={activity.error}>
            {(error) => (
              <p class="project-node-panel-copyline">
                {error() instanceof Error
                  ? error().message
                  : "Could not load recent Sentry events."}
              </p>
            )}
          </Show>

          <Show
            when={!activity.loading && !activity.error && (activity()?.errors.length ?? 0) === 0}
          >
            <p class="project-node-panel-copyline">
              No recent Sentry error events were returned for this project.
            </p>
          </Show>

          <div class="project-node-panel-log-list">
            <For each={activity()?.errors ?? []}>
              {(entry) => (
                <article class="project-node-panel-log-item">
                  <div class="project-node-panel-log-copy">
                    <div class="project-node-panel-log-topline">
                      <p class="project-node-panel-log-title">{entry.title}</p>
                      <Show when={entry.level}>
                        <span class="project-node-panel-log-chip">{entry.level}</span>
                      </Show>
                    </div>
                    <Show when={entry.culprit}>
                      <p class="project-node-panel-log-subtitle">{entry.culprit}</p>
                    </Show>
                  </div>
                  <p class="project-node-panel-log-meta">
                    {formatActivityTimestamp(entry.timestamp)}
                  </p>
                </article>
              )}
            </For>
          </div>
        </div>

        <div class="project-node-panel-section">
          <div class="project-node-panel-section-header">
            <p class="project-node-panel-section-title">Transaction activity</p>
            <span class="project-node-panel-badge">Esc closes</span>
          </div>

          <Show when={!props.node.importedSentryProjectId}>
            <p class="project-node-panel-copyline">
              Link a Sentry project to this item if you want Hotfix to surface its transactions
              here.
            </p>
          </Show>

          <Show when={activity.loading}>
            <p class="project-node-panel-copyline">Loading Sentry transactions…</p>
          </Show>

          <Show
            when={
              !activity.loading && !activity.error && (activity()?.transactions.length ?? 0) === 0
            }
          >
            <p class="project-node-panel-copyline">
              No transaction activity was returned for this project in the last 24 hours.
            </p>
          </Show>

          <div class="project-node-panel-log-list">
            <For each={activity()?.transactions ?? []}>
              {(entry) => (
                <article class="project-node-panel-log-item is-transaction">
                  <div class="project-node-panel-log-copy">
                    <div class="project-node-panel-log-topline">
                      <p class="project-node-panel-log-title">{entry.name}</p>
                      <span class="project-node-panel-log-chip">
                        {formatMetricCount(entry.count)} hits
                      </span>
                    </div>
                    <p class="project-node-panel-log-subtitle">
                      Average duration {formatDuration(entry.avgDurationMs)}
                    </p>
                  </div>
                </article>
              )}
            </For>
          </div>
        </div>
      </div>
    </aside>
  );
}

function EdgeCreationModal(props: {
  sourceNode: ProjectGraphNode;
  targetNode: ProjectGraphNode;
  draft: EdgeDraft;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onChange: (next: EdgeDraft) => void;
  onSubmit: () => void;
}) {
  const isSubmitDisabled = createMemo(() => props.saving || props.draft.label.trim().length === 0);

  return (
    <div
      class="project-modal-backdrop project-edge-modal-backdrop"
      role="presentation"
      onClick={props.onClose}
    >
      <section
        class="project-modal project-edge-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-edge-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="project-modal-header">
          <div>
            <h2 id="project-edge-modal-title" class="project-modal-title">
              Describe this relationship
            </h2>
            <p class="project-edge-modal-copy">
              Capture the context an agent will not reliably infer from code alone.
            </p>
          </div>
          <button
            class="project-modal-close"
            type="button"
            onClick={props.onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div class="project-edge-modal-route">
          <span>{props.sourceNode.label}</span>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          <span>{props.targetNode.label}</span>
        </div>

        <form
          class="project-modal-form project-edge-modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <label class="project-field">
            <span class="project-field-label">Edge description</span>
            <textarea
              class="project-field-textarea project-edge-modal-textarea is-large"
              rows={3}
              value={props.draft.label}
              placeholder="Project A calls backend endpoints over HTTP and uses SWR to cache and revalidate responses."
              onInput={(event) =>
                props.onChange({
                  ...props.draft,
                  label: event.currentTarget.value,
                })
              }
            />
          </label>

          <div class="project-edge-modal-grid">
            <label class="project-field">
              <span class="project-field-label">Interaction type</span>
              <div class="projects-select-wrap">
                <select
                  class="project-field-input project-field-select"
                  value={props.draft.interactionType}
                  onInput={(event) =>
                    props.onChange({
                      ...props.draft,
                      interactionType: event.currentTarget.value,
                    })
                  }
                >
                  <For each={EDGE_INTERACTION_TYPES}>
                    {(option) => <option value={option.value}>{option.label}</option>}
                  </For>
                </select>
                <span class="projects-select-caret" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path d="M4.25 6.5 8 10l3.75-3.5" stroke="currentColor" stroke-width="1.3" />
                  </svg>
                </span>
              </div>
            </label>

            <label class="project-field">
              <span class="project-field-label">Transport / protocol</span>
              <input
                class="project-field-input"
                type="text"
                value={props.draft.transport}
                placeholder="HTTPS, queue, cron, shared Redis"
                onInput={(event) =>
                  props.onChange({
                    ...props.draft,
                    transport: event.currentTarget.value,
                  })
                }
              />
            </label>
          </div>

          <label class="project-field">
            <span class="project-field-label">Touchpoints to inspect</span>
            <textarea
              class="project-field-textarea project-edge-modal-textarea"
              rows={3}
              value={props.draft.touchpoints}
              placeholder="checkout page, /api/orders, order service client, SWR hook, auth middleware"
              onInput={(event) =>
                props.onChange({
                  ...props.draft,
                  touchpoints: event.currentTarget.value,
                })
              }
            />
          </label>

          <label class="project-field">
            <span class="project-field-label">Data contract notes</span>
            <textarea
              class="project-field-textarea project-edge-modal-textarea"
              rows={3}
              value={props.draft.dataContract}
              placeholder="Headers, payload shape, cache keys, retry semantics, response fields the frontend depends on"
              onInput={(event) =>
                props.onChange({
                  ...props.draft,
                  dataContract: event.currentTarget.value,
                })
              }
            />
          </label>

          <label class="project-field">
            <span class="project-field-label">Context not obvious from code</span>
            <textarea
              class="project-field-textarea project-edge-modal-textarea"
              rows={4}
              value={props.draft.contextNotInCode}
              placeholder="Feature flags, auth assumptions, rollout quirks, rate limits, third-party constraints, failure behavior"
              onInput={(event) =>
                props.onChange({
                  ...props.draft,
                  contextNotInCode: event.currentTarget.value,
                })
              }
            />
          </label>

          <Show when={props.error}>
            {(message) => <p class="project-modal-error">{message()}</p>}
          </Show>

          <div class="project-modal-actions">
            <button class="project-modal-secondary" type="button" onClick={props.onClose}>
              Cancel
            </button>
            <button class="brand-button" type="submit" disabled={isSubmitDisabled()}>
              {props.saving ? "Saving..." : "Save edge"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AddProjectItemModal(props: {
  githubRepos: GitHubRepositoryPayload[];
  sentryProjects: ImportedSentryProjectSummary[];
  saving: boolean;
  error: string | null;
  githubLoading: boolean;
  githubError: string | null;
  onClose: () => void;
  onSubmit: (input: CreateProjectGraphItemInput) => void;
}) {
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [githubRepoId, setGitHubRepoId] = createSignal("");
  const [branchSearch, setBranchSearch] = createSignal("");
  const [branchName, setBranchName] = createSignal("");
  const [baseDirectory, setBaseDirectory] = createSignal("");
  const [linkedImportedSentryProjectId, setLinkedImportedSentryProjectId] = createSignal("");
  const [githubBranches] = createResource(
    () => {
      const repoId = githubRepoId().trim();
      if (!repoId) {
        return null;
      }
      return {
        repoId: Number(repoId),
        query: branchSearch(),
      };
    },
    async (source) => fetchGitHubBranches(source.repoId, source.query),
  );

  createEffect(
    on(githubRepoId, () => {
      setBranchSearch("");
      setBranchName("");
    }),
  );

  createEffect(() => {
    const branches = githubBranches();
    if (!branches || branches.length === 0 || branchName().trim().length > 0) {
      return;
    }

    const defaultBranch = branches.find((branch) => branch.isDefault) ?? branches[0];
    if (defaultBranch) {
      setBranchName(defaultBranch.name);
    }
  });

  const canSubmit = createMemo(
    () =>
      !props.saving &&
      name().trim().length > 0 &&
      githubRepoId().trim().length > 0 &&
      branchName().trim().length > 0,
  );

  return (
    <div
      class="project-modal-backdrop project-edge-modal-backdrop"
      role="presentation"
      onClick={props.onClose}
    >
      <section
        class="project-modal project-edge-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-item-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="project-modal-header">
          <div>
            <h2 id="project-item-modal-title" class="project-modal-title">
              Add an item to the canvas
            </h2>
            <p class="project-edge-modal-copy">
              Create a repo-backed item, optionally attach one imported Sentry project, and let
              Hotfix track indexing state on it.
            </p>
          </div>
          <button
            class="project-modal-close"
            type="button"
            onClick={props.onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form
          class="project-modal-form project-edge-modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit()) {
              return;
            }
            props.onSubmit({
              name: name().trim(),
              description: description(),
              githubRepoId: Number(githubRepoId()),
              branch: branchName().trim(),
              baseDirectory: baseDirectory(),
              linkedImportedSentryProjectId:
                linkedImportedSentryProjectId().trim().length > 0
                  ? linkedImportedSentryProjectId()
                  : null,
            });
          }}
        >
          <label class="project-field">
            <span class="project-field-label">Name</span>
            <input
              class="project-field-input"
              type="text"
              value={name()}
              placeholder="Frontend app"
              maxlength={120}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>

          <label class="project-field">
            <span class="project-field-label">GitHub repository</span>
            <Show
              when={props.githubRepos.length > 0}
              fallback={
                <p class="project-field-helper">
                  {props.githubLoading ? (
                    "Loading connected GitHub repositories..."
                  ) : props.githubError ? (
                    <>
                      <a class="project-inline-link" href="/api/auth/github/start">
                        Connect GitHub
                      </a>{" "}
                      to pick a repository for this item.
                    </>
                  ) : (
                    "No connected GitHub repositories are available for this account."
                  )}
                </p>
              }
            >
              <div class="projects-select-wrap">
                <select
                  class="project-field-input project-field-select"
                  value={githubRepoId()}
                  onInput={(event) => setGitHubRepoId(event.currentTarget.value)}
                >
                  <option value="">Select a repository</option>
                  <For each={props.githubRepos}>
                    {(repo) => <option value={repo.id}>{repo.fullName}</option>}
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
            </Show>
          </label>

          <label class="project-field">
            <span class="project-field-label">Branch</span>
            <Show
              when={githubRepoId().trim().length > 0}
              fallback={
                <p class="project-field-helper">
                  Select a GitHub repository first to load branches.
                </p>
              }
            >
              <input
                class="project-field-input"
                type="search"
                value={branchSearch()}
                placeholder="Filter branches"
                onInput={(event) => setBranchSearch(event.currentTarget.value)}
              />
              <div class="projects-select-wrap">
                <select
                  class="project-field-input project-field-select"
                  value={branchName()}
                  onInput={(event) => setBranchName(event.currentTarget.value)}
                  disabled={githubBranches.loading || (githubBranches()?.length ?? 0) === 0}
                >
                  <option value="">
                    {githubBranches.loading ? "Loading branches..." : "Select a branch"}
                  </option>
                  <For each={githubBranches() ?? []}>
                    {(branch) => (
                      <option value={branch.name}>
                        {branch.isDefault ? `${branch.name} (default)` : branch.name}
                      </option>
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
              <p class="project-field-helper">
                {githubBranches.error
                  ? githubBranches.error instanceof Error
                    ? githubBranches.error.message
                    : "Could not load branches for that repository."
                  : githubBranches.loading
                    ? "Loading branches for the selected repository."
                    : (githubBranches()?.length ?? 0) === 0
                      ? "No branches matched the current search."
                      : "Choose the branch from the dropdown. The search field only filters the list."}
              </p>
            </Show>
          </label>

          <label class="project-field">
            <span class="project-field-label">Description</span>
            <textarea
              class="project-field-textarea project-edge-modal-textarea"
              rows={3}
              value={description()}
              placeholder="Optional context about the role of this codebase or service."
              onInput={(event) => setDescription(event.currentTarget.value)}
            />
          </label>

          <label class="project-field">
            <span class="project-field-label">Base directory</span>
            <input
              class="project-field-input"
              type="text"
              value={baseDirectory()}
              placeholder="apps/web"
              onInput={(event) => setBaseDirectory(event.currentTarget.value)}
            />
            <p class="project-field-helper">
              Optional. Use this when the repository is a monorepo and this item lives below the
              repository root.
            </p>
          </label>

          <label class="project-field">
            <span class="project-field-label">Linked Sentry project</span>
            <div
              class="projects-select-wrap"
              classList={{ "is-disabled": props.sentryProjects.length === 0 }}
            >
              <select
                class="project-field-input project-field-select"
                value={linkedImportedSentryProjectId()}
                onInput={(event) => setLinkedImportedSentryProjectId(event.currentTarget.value)}
                disabled={props.sentryProjects.length === 0}
              >
                <option value="">None</option>
                <For each={props.sentryProjects}>
                  {(project) => (
                    <option value={project.id}>
                      {project.name} ({project.slug})
                    </option>
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
            <p class="project-field-helper">
              Optional. Import Sentry projects in Settings first if you want this item to show
              Sentry activity and metrics.
            </p>
          </label>

          <Show when={props.error}>
            {(message) => <p class="project-modal-error">{message()}</p>}
          </Show>

          <div class="project-modal-actions">
            <button class="project-modal-secondary" type="button" onClick={props.onClose}>
              Cancel
            </button>
            <button class="brand-button" type="submit" disabled={!canSubmit()}>
              {props.saving ? "Adding..." : "Add item"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function ProjectHomeGraph(props: ProjectHomeGraphProps) {
  const [graph, { mutate, refetch }] = createResource(
    () => `${props.projectId}:${props.refreshKey}`,
    async () => fetchProjectGraph(props.projectId),
  );
  const [itemModalOpen, setItemModalOpen] = createSignal(false);
  const [itemSaveError, setItemSaveError] = createSignal<string | null>(null);
  const [itemSaving, setItemSaving] = createSignal(false);
  const [selectedNodeId, setSelectedNodeId] = createSignal<string | null>(null);
  const [linkSourceNodeId, setLinkSourceNodeId] = createSignal<string | null>(null);
  const [linkPreviewPoint, setLinkPreviewPoint] = createSignal<{ x: number; y: number } | null>(
    null,
  );
  const [edgeDraft, setEdgeDraft] = createSignal<EdgeDraft | null>(null);
  const [edgeSaveError, setEdgeSaveError] = createSignal<string | null>(null);
  const [edgeSaving, setEdgeSaving] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;
  let editorHandle: EditorHandle | null = null;
  let buildToken = 0;
  let lastPersistedLayout = "";
  const [githubRepos] = createResource(
    () => (itemModalOpen() ? props.projectId : null),
    async () => fetchGitHubRepositories(),
  );

  const selectedNode = createMemo(
    () => graph()?.nodes.find((node) => node.id === selectedNodeId()) ?? null,
  );
  const isEmpty = createMemo(
    () => !graph.loading && !graph.error && (graph()?.nodes.length ?? 0) === 0,
  );
  const hasPanel = createMemo(() => Boolean(selectedNode()));
  const edgeTargetNode = createMemo(
    () => graph()?.nodes.find((node) => node.id === edgeDraft()?.targetNodeId) ?? null,
  );
  const edgeSourceNode = createMemo(
    () => graph()?.nodes.find((node) => node.id === edgeDraft()?.sourceNodeId) ?? null,
  );
  const edgeComposerState = createMemo(() => {
    const draft = edgeDraft();
    const source = edgeSourceNode();
    const target = edgeTargetNode();

    return draft && source && target
      ? {
          draft,
          source,
          target,
        }
      : null;
  });
  const normalizedGraph = createMemo(() => {
    const payload = graph();
    return payload ? normalizeGraphLayout(payload) : null;
  });

  const resolveNodeCenter = (nodeId: string) => {
    const container = containerRef;
    if (!container) {
      return null;
    }

    const card = container.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!card) {
      return null;
    }

    const containerRect = container.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      x: cardRect.left - containerRect.left + cardRect.width / 2,
      y: cardRect.top - containerRect.top + cardRect.height / 2,
    };
  };

  const previewPath = createMemo(() => {
    const sourceNodeId = linkSourceNodeId();
    const pointer = linkPreviewPoint();
    if (!sourceNodeId || !pointer || edgeDraft()) {
      return null;
    }

    const sourceCenter = resolveNodeCenter(sourceNodeId);
    if (!sourceCenter) {
      return null;
    }

    return buildSnappyConnectorPath(sourceCenter, pointer);
  });

  const applyEditorVisualState = () => {
    editorHandle?.setVisualState({
      selectedNodeId: selectedNodeId(),
      linkSourceNodeId: linkSourceNodeId(),
    });
  };

  const resetEdgeComposerState = () => {
    setEdgeDraft(null);
    setEdgeSaveError(null);
    setEdgeSaving(false);
  };

  const clearLinkSourceSelection = () => {
    setLinkSourceNodeId(null);
    setLinkPreviewPoint(null);
  };

  const closeEdgeComposer = () => {
    resetEdgeComposerState();
  };

  const closeItemModal = () => {
    if (itemSaving()) {
      return;
    }
    setItemModalOpen(false);
    setItemSaveError(null);
  };

  const armLinkSource = (nodeId: string) => {
    if (linkSourceNodeId() === nodeId) {
      clearLinkSourceSelection();
      applyEditorVisualState();
      return;
    }

    const center = resolveNodeCenter(nodeId);
    setSelectedNodeId(null);
    setLinkSourceNodeId(nodeId);
    setLinkPreviewPoint(center ? { x: center.x + 24, y: center.y } : null);
    resetEdgeComposerState();
    applyEditorVisualState();
  };

  const reorganizeGraph = async () => {
    const payload = graph();
    if (!payload || payload.nodes.length === 0) {
      return;
    }

    const { nextNodes, layout } = buildGridLayout(payload.nodes);
    const signature = JSON.stringify(layout);
    lastPersistedLayout = signature;

    mutate({
      ...payload,
      nodes: nextNodes,
    });

    try {
      await persistProjectGraphLayout(props.projectId, layout);
    } catch (error) {
      console.error("Could not reorganize graph layout", error);
    }
  };

  const handleNodeActivate = (nodeId: string | null) => {
    if (!nodeId || edgeDraft()) {
      return;
    }

    if (nodeId.startsWith("connect:")) {
      armLinkSource(nodeId.slice("connect:".length));
      return;
    }

    const sourceNodeId = linkSourceNodeId();
    if (sourceNodeId) {
      if (sourceNodeId === nodeId) {
        return;
      }

      setEdgeSaveError(null);
      setEdgeSaving(false);
      setEdgeDraft(createDefaultEdgeDraft(sourceNodeId, nodeId));
      clearLinkSourceSelection();
      applyEditorVisualState();
      return;
    }

    setSelectedNodeId(nodeId);
  };

  const handleEdgeSave = async () => {
    const draft = edgeDraft();
    if (!draft || !draft.label.trim()) {
      return;
    }

    setEdgeSaving(true);
    setEdgeSaveError(null);

    try {
      const payload = await createProjectGraphEdge(props.projectId, draft);
      mutate(payload);
      setSelectedNodeId(null);
      closeEdgeComposer();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save the relationship edge.";
      setEdgeSaveError(message);
    } finally {
      setEdgeSaving(false);
    }
  };

  const handleItemCreate = async (input: CreateProjectGraphItemInput) => {
    setItemSaving(true);
    setItemSaveError(null);

    try {
      const payload = await createProjectGraphItem(props.projectId, input);
      mutate(payload);
      setItemModalOpen(false);
      setSelectedNodeId(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not add the item to the canvas.";
      setItemSaveError(message);
    } finally {
      setItemSaving(false);
    }
  };

  createEffect(() => {
    const payload = graph();
    if (!payload) {
      return;
    }

    if (selectedNodeId() && !payload.nodes.some((node) => node.id === selectedNodeId())) {
      setSelectedNodeId(null);
    }

    if (linkSourceNodeId() && !payload.nodes.some((node) => node.id === linkSourceNodeId())) {
      clearLinkSourceSelection();
    }

    const draft = edgeDraft();
    if (
      draft &&
      (!payload.nodes.some((node) => node.id === draft.sourceNodeId) ||
        !payload.nodes.some((node) => node.id === draft.targetNodeId))
    ) {
      resetEdgeComposerState();
    }
  });

  createEffect(() => {
    applyEditorVisualState();
  });

  createEffect(() => {
    const payload = graph();
    if (!payload || typeof window === "undefined") {
      return;
    }

    const hasActiveIndexing = payload.nodes.some((node) => {
      const indexingStatus = (node.metadata.indexingStatus ?? "pending").toLowerCase();
      return (
        indexingStatus === "queued" || indexingStatus === "pending" || indexingStatus === "indexing"
      );
    });
    if (!hasActiveIndexing) {
      return;
    }

    const interval = window.setInterval(() => {
      void refetch();
    }, 3000);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    const panelOpen = hasPanel();
    const handle = editorHandle;

    if (!handle) {
      return;
    }

    let cancelled = false;

    void (async () => {
      await waitForAnimationFrame(3);
      if (cancelled) {
        return;
      }

      await handle.fitToView(panelOpen ? GRAPH_PANEL_FIT_SCALE : GRAPH_DEFAULT_FIT_SCALE);
      handle.setVisualState({
        selectedNodeId: selectedNodeId(),
        linkSourceNodeId: linkSourceNodeId(),
      });
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const normalized = normalizedGraph();
    const container = containerRef;

    if (!normalized || !container) {
      return;
    }

    const payload = normalized.graph;
    if (payload.nodes.length === 0) {
      editorHandle?.destroy();
      editorHandle = null;
      return;
    }

    const currentBuild = ++buildToken;
    let disposed = false;

    void (async () => {
      const previousHandle = editorHandle;
      editorHandle = null;
      previousHandle?.destroy();

      if (normalized.changed && normalized.layout.length > 0) {
        const signature = JSON.stringify(normalized.layout);
        if (signature !== lastPersistedLayout) {
          lastPersistedLayout = signature;
          try {
            await persistProjectGraphLayout(props.projectId, normalized.layout);
          } catch (error) {
            console.error("Could not normalize graph layout", error);
          }
        }
      }

      const handle = await mountProjectGraphEditor(
        container,
        payload,
        async (nodes) => {
          const signature = JSON.stringify(nodes);
          if (signature === lastPersistedLayout) {
            return;
          }

          lastPersistedLayout = signature;
          try {
            await persistProjectGraphLayout(props.projectId, nodes);
          } catch (error) {
            console.error("Could not persist graph layout", error);
          }
        },
        handleNodeActivate,
      );

      if (disposed || currentBuild !== buildToken) {
        handle.destroy();
        return;
      }

      editorHandle = handle;
      await handle.fitToView(
        untrack(() => (hasPanel() ? GRAPH_PANEL_FIT_SCALE : GRAPH_DEFAULT_FIT_SCALE)),
      );
      handle.setVisualState({
        selectedNodeId: untrack(() => selectedNodeId()),
        linkSourceNodeId: untrack(() => linkSourceNodeId()),
      });
    })();

    onCleanup(() => {
      disposed = true;
    });
  });

  createEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const sourceNodeId = linkSourceNodeId();
      const container = containerRef;
      if (!sourceNodeId || !container || edgeDraft()) {
        return;
      }

      const rect = container.getBoundingClientRect();
      setLinkPreviewPoint({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    onCleanup(() => {
      window.removeEventListener("pointermove", handlePointerMove, true);
    });
  });

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (edgeDraft()) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeEdgeComposer();
        return;
      }

      if (linkSourceNodeId()) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        clearLinkSourceSelection();
        applyEditorVisualState();
        return;
      }

      if (selectedNodeId()) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setSelectedNodeId(null);
        applyEditorVisualState();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown, true);
    });
  });

  onCleanup(() => {
    buildToken += 1;
    editorHandle?.destroy();
    editorHandle = null;
  });

  return (
    <section
      class="project-home-shell"
      classList={{ "has-panel": hasPanel(), "is-link-armed": Boolean(linkSourceNodeId()) }}
    >
      <div class="project-home-stage">
        <div
          ref={(value) => {
            containerRef = value;
          }}
          class="project-home-canvas"
        />

        <Show when={previewPath()}>
          {(path) => (
            <svg class="project-home-link-preview" aria-hidden="true">
              <path class="project-home-link-preview-path" d={path()} />
            </svg>
          )}
        </Show>

        <Show when={linkSourceNodeId() && !edgeDraft()}>
          <div class="project-home-link-hint" role="status" aria-live="polite">
            <p class="project-home-link-hint-title">Connecting projects</p>
            <p class="project-home-link-hint-copy">
              Click another card to connect it. Press <kbd>Esc</kbd> to cancel.
            </p>
          </div>
        </Show>

        <div class="project-home-actions">
          <button
            class="brand-button"
            type="button"
            onClick={() => {
              setItemSaveError(null);
              setItemModalOpen(true);
            }}
          >
            <span class="brand-button-plus" aria-hidden="true">
              +
            </span>
            <span>Add</span>
          </button>
        </div>

        <GraphControls
          onReorganize={() => void reorganizeGraph()}
          onZoomIn={() => void editorHandle?.zoomBy(1.12)}
          onZoomOut={() => void editorHandle?.zoomBy(0.9)}
          onFit={() =>
            void editorHandle?.fitToView(
              hasPanel() ? GRAPH_PANEL_FIT_SCALE : GRAPH_DEFAULT_FIT_SCALE,
            )
          }
        />

        <Show when={graph.loading}>
          <div class="project-home-overlay">
            <div class="project-home-status">
              <p class="project-home-status-label">Loading graph</p>
              <p class="project-home-status-copy">Pulling the saved Sentry project topology.</p>
            </div>
          </div>
        </Show>

        <Show when={graph.error}>
          {(error) => (
            <div class="project-home-overlay">
              <div class="project-home-status is-error">
                <p class="project-home-status-label">Graph unavailable</p>
                <p class="project-home-status-copy">
                  {error() instanceof Error ? error().message : "Could not load the project graph."}
                </p>
              </div>
            </div>
          )}
        </Show>

        <Show when={isEmpty()}>
          <div class="project-home-overlay">
            <div class="project-home-status">
              <p class="project-home-status-label">No canvas items yet</p>
              <p class="project-home-status-copy">
                Add your first repo-backed item, then optionally link one imported Sentry project to
                it.
              </p>
            </div>
          </div>
        </Show>
      </div>

      <Show when={itemModalOpen()}>
        <AddProjectItemModal
          githubRepos={githubRepos() ?? []}
          sentryProjects={props.sentryProjects}
          saving={itemSaving()}
          error={itemSaveError()}
          githubLoading={githubRepos.loading}
          githubError={
            githubRepos.error
              ? githubRepos.error instanceof Error
                ? githubRepos.error.message
                : "GitHub is unavailable."
              : null
          }
          onClose={closeItemModal}
          onSubmit={(input) => void handleItemCreate(input)}
        />
      </Show>

      <Show when={edgeComposerState()} keyed>
        {(state) => (
          <EdgeCreationModal
            sourceNode={state.source}
            targetNode={state.target}
            draft={state.draft}
            saving={edgeSaving()}
            error={edgeSaveError()}
            onChange={(next) => setEdgeDraft(next)}
            onClose={() => closeEdgeComposer()}
            onSubmit={() => void handleEdgeSave()}
          />
        )}
      </Show>

      <Show when={selectedNode()}>
        {(node) => (
          <ProjectNodePanel
            node={node()}
            onClose={() => {
              setSelectedNodeId(null);
              applyEditorVisualState();
            }}
          />
        )}
      </Show>
    </section>
  );
}
