import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";

const sentryIcon = new URL("../assets/sentry.svg", import.meta.url).href;

type ProjectGraphNodeMetadata = {
  provider?: string;
  sentryProjectId?: string;
  slug?: string;
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
  githubRepoFullName?: string | null;
  githubRepoUrl?: string | null;
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

type GraphVisualState = {
  selectedNodeId: string | null;
};

type EdgeDraft = CreateProjectGraphEdgeInput;

type PendingConnectionDraft = {
  connectionId: string;
  sourceNodeId: string;
  targetNodeId: string;
};

type ProjectHomeGraphProps = {
  projectId: string;
  refreshKey: string;
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
  removeConnection: (connectionId: string) => Promise<void>;
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

function nodeSubtitle(node: ProjectGraphNode) {
  return node.metadata.slug ?? node.description ?? "Imported from Sentry";
}

function nodeFooter(node: ProjectGraphNode) {
  return node.metadata.platform ?? "Sentry project";
}

function nodeStatus(node: ProjectGraphNode) {
  return node.metadata.included === false ? "Excluded" : "Included";
}

function nodeStatusClass(node: ProjectGraphNode) {
  return node.metadata.included === false ? "is-muted" : "is-online";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function buildSnappyConnectorPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const lead = 18;
  const deltaX = end.x - start.x;
  const midpointOffset = clamp(deltaX / 2, -40, 40);
  const trunkX = start.x + (Math.abs(deltaX) > lead * 2 ? midpointOffset : (deltaX >= 0 ? lead : -lead));

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

function normalizeSeries(series: number[] | undefined, total: number | undefined, bucketCount = 12) {
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
    transactions: normalizeSeries(node.metadata.transactions24hSeries, node.metadata.transactions24h),
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
      label: "24h errors",
      value: formatMetricCount(node.metadata.errors24h),
    },
    {
      label: "24h transactions",
      value: formatMetricCount(node.metadata.transactions24h),
    },
    {
      label: "Platform",
      value: node.metadata.platform ?? "Not reported",
    },
    {
      label: "Included",
      value: nodeStatus(node),
    },
    {
      label: "Sentry repo",
      value: node.metadata.sentryRepoConnected ? "Connected" : "Not connected",
    },
    {
      label: "Hotfix repo",
      value: node.metadata.hotfixRepoConnected
        ? node.metadata.githubRepoFullName ?? "Connected"
        : "Not connected",
    },
  ];
}

async function mountProjectGraphEditor(
  container: HTMLDivElement,
  graph: ProjectGraphPayload,
  onLayoutChange: (nodes: ProjectGraphLayoutNode[]) => Promise<void>,
  onNodeActivate: (nodeId: string | null) => void,
  onConnectionDraft: (draft: PendingConnectionDraft) => void,
): Promise<EditorHandle> {
  const [
    { NodeEditor, ClassicPreset },
    { AreaPlugin, AreaExtensions },
    { LitPlugin, Presets: LitPresets },
    { ConnectionPlugin, Presets: ConnectionPresets },
    { html },
  ] =
    await Promise.all([
      import("rete"),
      import("rete-area-plugin"),
      import("@retejs/lit-plugin"),
      import("rete-connection-plugin"),
      import("lit"),
    ]);

  container.replaceChildren();

  const editor = new NodeEditor<any>();
  const area = new AreaPlugin<any>(container);
  const render = new LitPlugin<any>();
  const connection = new ConnectionPlugin<any>();
  const resizeObserver = new ResizeObserver(() => {
    void area.area.translate(area.area.transform.x, area.area.transform.y);
  });

  editor.use(area);
  area.use(connection as any);
  area.use(render);
  connection.addPreset(ConnectionPresets.classic.setup());
  connection.addPipe((context: any) => {
    if (context.type === "connectionpick") {
      container.classList.add("is-connecting");
    } else if (context.type === "connectiondrop") {
      container.classList.remove("is-connecting");
    }

    return context;
  });
  AreaExtensions.restrictor(area, {
    scaling: {
      min: GRAPH_ZOOM_MIN,
      max: GRAPH_ZOOM_MAX,
    },
  });

  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));

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
                <div class="project-graph-node-card-body">
                  <div class="project-graph-node-card-top">
                    <div class="project-graph-node-card-header">
                      <span class="project-graph-node-card-icon" aria-hidden="true">
                        <img src=${sentryIcon} alt="" />
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

                      <span class="project-graph-node-connect-handle" aria-hidden="true">
                        <span class="project-graph-node-connect-icon" aria-hidden="true">
                          <svg viewBox="0 0 16 16" fill="none">
                            <path d="M4.25 8h7.5" />
                            <path d="M5.5 5.5H3.75v1.75H5.5z" />
                            <path d="M12.25 8.75h-1.75v1.75h1.75z" />
                            <path d="M12.25 3.75h-1.75V5.5h1.75z" />
                          </svg>
                        </span>
                        <span class="project-graph-node-socket-anchor is-input">
                          <rete-ref .data=${inputSocketData} .emit=${emit}></rete-ref>
                        </span>
                        <span class="project-graph-node-socket-anchor is-output">
                          <rete-ref .data=${outputSocketData} .emit=${emit}></rete-ref>
                        </span>
                      </span>
                    </div>
                  </div>

                  <div class="project-graph-node-card-metrics">
                    <p class="project-graph-node-card-status ${nodeStatusClass(node)}">
                      ${nodeStatus(node)}
                    </p>
                    <p class="project-graph-node-card-footer-platform">${nodeFooter(node)}</p>
                  </div>

                  <div class="project-graph-node-card-badges">
                    <span
                      class=${nodeConnectionBadgeClass(Boolean(node.metadata.sentryRepoConnected))}
                    >
                      ${node.metadata.sentryRepoConnected ? "Sentry linked" : "Sentry missing"}
                    </span>
                    <span
                      class=${nodeConnectionBadgeClass(Boolean(node.metadata.hotfixRepoConnected))}
                    >
                      ${node.metadata.hotfixRepoConnected ? "Hotfix linked" : "Hotfix missing"}
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
          return () =>
            html`
              <span
                class="project-graph-socket project-graph-socket--${context.side}"
                data-node-socket
                data-node-id=${context.nodeId}
                data-socket-side=${context.side}
                aria-hidden="true"
              ></span>
            `;
        },
        connection(context) {
          const edge = edgesById.get(context.payload.id);
          return ({ path }) =>
            html`
              <svg
                class="project-graph-connection-svg"
                data-edge-id=${context.payload.id}
                style="overflow: visible !important; position: absolute; pointer-events: none; width: 9999px; height: 9999px;"
              >
                <path
                  class="project-graph-connection-path ${edge?.isSystem ? "is-system" : "is-relationship"}"
                  d=${path}
                  fill="none"
                  stroke=${edge?.isSystem ? "rgba(255, 255, 255, 0.18)" : "rgba(127, 220, 255, 0.84)"}
                  stroke-width=${edge?.isSystem ? "1.2" : "1.55"}
                  stroke-linecap="round"
                  stroke-dasharray=${edge?.isSystem ? "0" : "4 8"}
                  vector-effect="non-scaling-stroke"
                  pointer-events="none"
                >
                  ${edge?.isSystem
                    ? null
                    : html`
                        <animate
                          attributeName="stroke-dashoffset"
                          values="0;-24"
                          dur="1.05s"
                          repeatCount="indefinite"
                        />
                      `}
                </path>
              </svg>
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

  let hydratingConnections = true;

  editor.addPipe((context: any) => {
    if (context.type === "connectioncreated") {
      const nextConnection = context.data as {
        id: string;
        source: string;
        target: string;
        isPseudo?: boolean;
      };

      if (!hydratingConnections && !nextConnection.isPseudo) {
        window.queueMicrotask(() => {
          if (!editor.getConnection(nextConnection.id)) {
            return;
          }

          onConnectionDraft({
            connectionId: nextConnection.id,
            sourceNodeId: nextConnection.source,
            targetNodeId: nextConnection.target,
          });
        });
      }
    }

    return context;
  });

  const nodesById = new Map<string, ProjectGraphNodeInstance>();
  for (const node of graph.nodes) {
    const nextNode = new ProjectGraphNodeInstance(node);
    nodesById.set(node.id, nextNode);
    await editor.addNode(nextNode);
    await area.translate(nextNode.id, { x: node.positionX, y: node.positionY });
  }

  for (const edge of graph.edges) {
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (!source || !target) {
      continue;
    }

    const connection = new ClassicPreset.Connection(source, "out", target, "in");
    connection.id = edge.id;
    await editor.addConnection(connection);
  }
  hydratingConnections = false;

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
    }
  };

  let pointerCandidate:
    | {
        nodeId: string;
        x: number;
        y: number;
      }
    | null = null;
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

    if (target.closest("[data-node-socket]")) {
      pointerCandidate = null;
      activePointerNodeId = null;
      draggedNodeId = null;
      translatedDuringPointer = false;
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

    if (target.closest(GRAPH_DRAG_HANDLE_SELECTOR) || target.closest("[data-node-socket]")) {
      return;
    }

    const nodeId = card.dataset.nodeId ?? null;
    if (
      nodeId &&
      suppressClickNodeId === nodeId &&
      performance.now() < suppressClickUntil
    ) {
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
      container.classList.remove("is-connecting");
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
    async removeConnection(connectionId: string) {
      if (!editor.getConnection(connectionId)) {
        return;
      }

      await editor.removeConnection(connectionId);
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
        <button class="project-home-control-button" type="button" aria-label="Zoom in" onClick={props.onZoomIn}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 6.5v11M6.5 12h11" />
          </svg>
        </button>
        <button class="project-home-control-button" type="button" aria-label="Zoom out" onClick={props.onZoomOut}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6.5 12h11" />
          </svg>
        </button>
        <button class="project-home-control-button" type="button" aria-label="Fit graph to view" onClick={props.onFit}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4" />
            <path d="M9 5 5 9M15 5l4 4M9 19l-4-4M15 19l4-4" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function ProjectNodePanel(props: {
  node: ProjectGraphNode;
  onClose: () => void;
}) {
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
            <img src={sentryIcon} alt="" />
          </span>
          <div class="project-node-panel-copy">
            <h2 class="project-node-panel-title">{props.node.label}</h2>
            <p class="project-node-panel-subtitle">{nodeSubtitle(props.node)}</p>
          </div>
        </div>

        <button class="project-node-panel-close" type="button" onClick={props.onClose} aria-label="Close panel">
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

          <Show when={activity.loading}>
            <p class="project-node-panel-copyline">Loading Sentry activity…</p>
          </Show>

          <Show when={activity.error}>
            {(error) => (
              <p class="project-node-panel-copyline">
                {error() instanceof Error ? error().message : "Could not load recent Sentry events."}
              </p>
            )}
          </Show>

          <Show when={!activity.loading && !activity.error && (activity()?.errors.length ?? 0) === 0}>
            <p class="project-node-panel-copyline">No recent Sentry error events were returned for this project.</p>
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
                  <p class="project-node-panel-log-meta">{formatActivityTimestamp(entry.timestamp)}</p>
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

          <Show when={activity.loading}>
            <p class="project-node-panel-copyline">Loading Sentry transactions…</p>
          </Show>

          <Show when={!activity.loading && !activity.error && (activity()?.transactions.length ?? 0) === 0}>
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
                      <span class="project-node-panel-log-chip">{formatMetricCount(entry.count)} hits</span>
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
  const isSubmitDisabled = createMemo(
    () => props.saving || props.draft.label.trim().length === 0,
  );

  return (
    <div class="project-modal-backdrop project-edge-modal-backdrop" role="presentation" onClick={props.onClose}>
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
          <button class="project-modal-close" type="button" onClick={props.onClose} aria-label="Close">
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
                })}
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
                    })}
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
                  })}
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
                })}
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
                })}
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
                })}
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

export function ProjectHomeGraph(props: ProjectHomeGraphProps) {
  const [graph, { mutate }] = createResource(
    () => `${props.projectId}:${props.refreshKey}`,
    async () => fetchProjectGraph(props.projectId),
  );
  const [selectedNodeId, setSelectedNodeId] = createSignal<string | null>(null);
  const [pendingEdgeConnectionId, setPendingEdgeConnectionId] = createSignal<string | null>(null);
  const [edgeDraft, setEdgeDraft] = createSignal<EdgeDraft | null>(null);
  const [edgeSaveError, setEdgeSaveError] = createSignal<string | null>(null);
  const [edgeSaving, setEdgeSaving] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;
  let editorHandle: EditorHandle | null = null;
  let buildToken = 0;
  let lastPersistedLayout = "";

  const selectedNode = createMemo(
    () => graph()?.nodes.find((node) => node.id === selectedNodeId()) ?? null,
  );
  const isEmpty = createMemo(() => !graph.loading && !graph.error && (graph()?.nodes.length ?? 0) === 0);
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

  const applyEditorVisualState = () => {
    editorHandle?.setVisualState({
      selectedNodeId: selectedNodeId(),
    });
  };

  const resetEdgeComposerState = () => {
    setEdgeDraft(null);
    setEdgeSaveError(null);
    setEdgeSaving(false);
  };

  const removePendingEdgeConnection = async () => {
    const connectionId = pendingEdgeConnectionId();
    setPendingEdgeConnectionId(null);

    if (!connectionId) {
      return;
    }

    try {
      await editorHandle?.removeConnection(connectionId);
    } catch (error) {
      console.error("Could not remove draft graph connection", error);
    }
  };

  const closeEdgeComposer = (options?: { removeConnection?: boolean }) => {
    resetEdgeComposerState();
    if (options?.removeConnection === false) {
      setPendingEdgeConnectionId(null);
      return;
    }

    void removePendingEdgeConnection();
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

    setSelectedNodeId(nodeId);
  };

  const handleConnectionDraft = (draft: PendingConnectionDraft) => {
    if (draft.sourceNodeId === draft.targetNodeId) {
      void editorHandle?.removeConnection(draft.connectionId);
      return;
    }

    const previousConnectionId = pendingEdgeConnectionId();
    if (previousConnectionId && previousConnectionId !== draft.connectionId) {
      void editorHandle?.removeConnection(previousConnectionId);
    }

    setSelectedNodeId(null);
    setPendingEdgeConnectionId(draft.connectionId);
    setEdgeSaveError(null);
    setEdgeSaving(false);
    setEdgeDraft(createDefaultEdgeDraft(draft.sourceNodeId, draft.targetNodeId));
    applyEditorVisualState();
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
      closeEdgeComposer({
        removeConnection: false,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save the relationship edge.";
      setEdgeSaveError(message);
    } finally {
      setEdgeSaving(false);
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

    const draft = edgeDraft();
    if (
      draft &&
      (!payload.nodes.some((node) => node.id === draft.sourceNodeId) ||
        !payload.nodes.some((node) => node.id === draft.targetNodeId))
    ) {
      resetEdgeComposerState();
      setPendingEdgeConnectionId(null);
    }
  });

  createEffect(() => {
    applyEditorVisualState();
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
        handleConnectionDraft,
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
      });
    })();

    onCleanup(() => {
      disposed = true;
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
      classList={{ "has-panel": hasPanel() }}
    >
      <div class="project-home-stage">
        <div ref={containerRef} class="project-home-canvas" />

        <GraphControls
          onReorganize={() => void reorganizeGraph()}
          onZoomIn={() => void editorHandle?.zoomBy(1.12)}
          onZoomOut={() => void editorHandle?.zoomBy(0.9)}
          onFit={() =>
            void editorHandle?.fitToView(hasPanel() ? GRAPH_PANEL_FIT_SCALE : GRAPH_DEFAULT_FIT_SCALE)
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
              <p class="project-home-status-label">No Sentry graph yet</p>
              <p class="project-home-status-copy">
                Connect a Sentry organization or refresh imported projects to populate this canvas.
              </p>
            </div>
          </div>
        </Show>
      </div>

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
