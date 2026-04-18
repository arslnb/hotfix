use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use tempfile::TempDir;
use tokio::{
    sync::mpsc,
    time::{MissedTickBehavior, interval, timeout},
};
use tracing::{error, warn};
use tree_sitter::{Language, Node, Parser};
use url::Url;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};
use zip::ZipArchive;

use crate::{AppConfig, AppError, decrypt_provider_token};

const INDEX_JOB_CHANNEL_CAPACITY: usize = 32;
const INDEX_JOB_TIMEOUT: Duration = Duration::from_secs(120);
const INDEX_JOB_LEASE_SECONDS: i32 = 300;
const MAX_INDEXED_FILE_BYTES: u64 = 512 * 1024;

#[derive(Clone)]
pub(crate) struct IndexingService {
    tx: mpsc::Sender<()>,
}

impl IndexingService {
    pub(crate) fn new(db: PgPool, http: reqwest::Client, config: Arc<AppConfig>) -> Self {
        let (tx, mut rx) = mpsc::channel(INDEX_JOB_CHANNEL_CAPACITY);
        let service = Self { tx: tx.clone() };

        let worker_db = db.clone();
        let worker_http = http.clone();
        let worker_config = Arc::clone(&config);
        tokio::spawn(async move {
            let resolver = GitHubSnapshotResolver::new(
                worker_db.clone(),
                worker_http.clone(),
                Arc::clone(&worker_config),
            );
            let sandbox = HttpSandboxProvider::new(worker_http, worker_config.sandbox_url.clone());
            let policy = ExecutionPolicy::default_indexing();
            let claimer_id = format!("api-{}", Uuid::new_v4());
            let mut ticker = interval(worker_config.index_job_poll_interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

            loop {
                tokio::select! {
                    maybe = rx.recv() => {
                        if maybe.is_none() {
                            break;
                        }
                    }
                    _ = ticker.tick() => {}
                }

                loop {
                    let Some(job) = (match claim_next_index_job(
                        &worker_db,
                        &claimer_id,
                        INDEX_JOB_LEASE_SECONDS,
                    )
                    .await
                    {
                        Ok(job) => job,
                        Err(error) => {
                            error!(error = ?error, "could not claim index job");
                            break;
                        }
                    }) else {
                        break;
                    };

                    if let Err(error) =
                        mark_snapshot_progress(&worker_db, job.repo_snapshot_id, 5, &claimer_id)
                            .await
                    {
                        error!(
                            snapshot_id = %job.repo_snapshot_id,
                            error = ?error,
                            "could not mark snapshot indexing progress"
                        );
                    }

                    if let Err(error) = run_claimed_index_job(
                        &worker_db,
                        &resolver,
                        &sandbox,
                        &policy,
                        &claimer_id,
                        &job,
                    )
                    .await
                    {
                        error!(
                            job_id = %job.job_id,
                            snapshot_id = %job.repo_snapshot_id,
                            error = ?error,
                            "index job failed"
                        );
                        if let Err(update_error) = mark_snapshot_failed(
                            &worker_db,
                            job.repo_snapshot_id,
                            error.client_message(),
                        )
                        .await
                        {
                            error!(
                                snapshot_id = %job.repo_snapshot_id,
                                error = ?update_error,
                                "could not persist index job failure"
                            );
                        }
                    }
                }
            }
        });

        service
    }

    pub(crate) async fn notify(&self) -> Result<(), AppError> {
        self.tx.send(()).await.map_err(|_| AppError::Internal)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ExecutionPolicy {
    pub allow_network: bool,
    pub max_duration_ms: u64,
    pub max_output_bytes: usize,
    pub max_memory_bytes: usize,
}

impl ExecutionPolicy {
    fn default_indexing() -> Self {
        Self {
            allow_network: false,
            max_duration_ms: INDEX_JOB_TIMEOUT.as_millis() as u64,
            max_output_bytes: 64 * 1024,
            max_memory_bytes: 256 * 1024 * 1024,
        }
    }

    fn max_duration(&self) -> Duration {
        Duration::from_millis(self.max_duration_ms)
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct SandboxCommand {
    program: String,
    args: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
struct CommandResult {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SandboxIndexRequest {
    pub artifact_path: PathBuf,
    pub base_directory: String,
    pub policy: ExecutionPolicy,
}

#[async_trait]
trait SnapshotResolver: Send + Sync {
    async fn ensure_artifact(&self, job: &ClaimedIndexJob) -> Result<PathBuf, AppError>;
}

trait WorkspaceProvider: Send + Sync {
    fn materialize(
        &self,
        artifact_path: &Path,
        base_directory: &str,
        policy: &ExecutionPolicy,
    ) -> Result<MaterializedWorkspace, AppError>;
}

trait CommandExecutor: Send + Sync {
    fn execute(
        &self,
        workspace: &MaterializedWorkspace,
        command: &SandboxCommand,
        policy: &ExecutionPolicy,
    ) -> Result<CommandResult, AppError>;
}

trait Indexer: Send + Sync {
    fn index(&self, workspace_root: &Path) -> Result<SnapshotIndex, AppError>;
}

#[async_trait]
trait SandboxProvider: Send + Sync {
    async fn index(&self, request: &SandboxIndexRequest) -> Result<SnapshotIndex, AppError>;
}

struct GitHubSnapshotResolver {
    db: PgPool,
    http: reqwest::Client,
    config: Arc<AppConfig>,
}

impl GitHubSnapshotResolver {
    fn new(db: PgPool, http: reqwest::Client, config: Arc<AppConfig>) -> Self {
        Self { db, http, config }
    }
}

#[async_trait]
impl SnapshotResolver for GitHubSnapshotResolver {
    async fn ensure_artifact(&self, job: &ClaimedIndexJob) -> Result<PathBuf, AppError> {
        let artifact_path = self
            .config
            .snapshot_cache_dir
            .join(&job.snapshot_artifact_key);
        if artifact_path.exists() {
            sqlx::query(
                r#"
                update repo_snapshots
                set artifact_ready_at = coalesce(artifact_ready_at, now()), updated_at = now()
                where id = $1
                "#,
            )
            .bind(job.repo_snapshot_id)
            .execute(&self.db)
            .await?;
            return Ok(artifact_path);
        }

        let access_token = load_github_access_token_for_node(
            &self.db,
            self.config.session_secret.as_slice(),
            job.node_id,
        )
        .await?;

        if let Some(parent) = artifact_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| AppError::Internal)?;
        }

        let url = format!(
            "https://api.github.com/repos/{}/zipball/{}",
            job.github_repo_full_name, job.commit_sha
        );
        let response = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            warn!(body, snapshot_id = %job.repo_snapshot_id, "github snapshot download failed");
            return Err(AppError::BadRequest(
                "Could not download the repository snapshot from GitHub.".into(),
            ));
        }

        let bytes = response.bytes().await?;
        tokio::fs::write(&artifact_path, bytes)
            .await
            .map_err(|_| AppError::Internal)?;

        sqlx::query(
            r#"
            update repo_snapshots
            set artifact_ready_at = now(), updated_at = now()
            where id = $1
            "#,
        )
        .bind(job.repo_snapshot_id)
        .execute(&self.db)
        .await?;

        Ok(artifact_path)
    }
}

struct HttpSandboxProvider {
    http: reqwest::Client,
    sandbox_url: Url,
}

impl HttpSandboxProvider {
    fn new(http: reqwest::Client, sandbox_url: Url) -> Self {
        Self { http, sandbox_url }
    }
}

#[async_trait]
impl SandboxProvider for HttpSandboxProvider {
    async fn index(&self, request: &SandboxIndexRequest) -> Result<SnapshotIndex, AppError> {
        let url = self
            .sandbox_url
            .join("/index-jobs")
            .map_err(|_| AppError::Internal)?;
        let response = timeout(
            request.policy.max_duration(),
            self.http.post(url).json(request).send(),
        )
        .await
        .map_err(|_| {
            AppError::BadRequest("The indexing sandbox timed out before returning a result.".into())
        })??;

        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            warn!(body, "sandbox indexing request failed");
            return Err(AppError::BadRequest(
                "The indexing sandbox could not complete the repository analysis.".into(),
            ));
        }

        response
            .json::<SnapshotIndex>()
            .await
            .map_err(AppError::from)
    }
}

#[derive(Clone)]
struct ContainerWorkspaceProvider {
    workspace_root: PathBuf,
}

impl ContainerWorkspaceProvider {
    fn new(workspace_root: PathBuf) -> Self {
        Self { workspace_root }
    }
}

impl WorkspaceProvider for ContainerWorkspaceProvider {
    fn materialize(
        &self,
        artifact_path: &Path,
        base_directory: &str,
        _policy: &ExecutionPolicy,
    ) -> Result<MaterializedWorkspace, AppError> {
        fs::create_dir_all(&self.workspace_root).map_err(|_| AppError::Internal)?;
        let tempdir = tempfile::Builder::new()
            .prefix("hotfix-workspace-")
            .tempdir_in(&self.workspace_root)
            .map_err(|_| AppError::Internal)?;
        let root = extract_zip_archive(artifact_path, tempdir.path())?;
        let selected_root = if base_directory.is_empty() {
            root
        } else {
            let candidate = root.join(base_directory);
            if !candidate.exists() || !candidate.is_dir() {
                return Err(AppError::BadRequest(format!(
                    "The base directory \"{base_directory}\" does not exist in the selected branch."
                )));
            }
            candidate
        };

        Ok(MaterializedWorkspace {
            _tempdir: tempdir,
            root: selected_root,
        })
    }
}

#[derive(Clone, Copy)]
struct NoopCommandExecutor;

impl CommandExecutor for NoopCommandExecutor {
    fn execute(
        &self,
        _workspace: &MaterializedWorkspace,
        command: &SandboxCommand,
        _policy: &ExecutionPolicy,
    ) -> Result<CommandResult, AppError> {
        let _ = (&command.program, &command.args);
        Ok(CommandResult::default())
    }
}

struct MaterializedWorkspace {
    _tempdir: TempDir,
    root: PathBuf,
}

#[derive(Clone, Default)]
struct TreeSitterIndexer;

impl Indexer for TreeSitterIndexer {
    fn index(&self, workspace_root: &Path) -> Result<SnapshotIndex, AppError> {
        let mut snapshot = SnapshotIndex::default();

        for entry in WalkDir::new(workspace_root)
            .into_iter()
            .filter_entry(should_descend)
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }

            let relative = entry
                .path()
                .strip_prefix(workspace_root)
                .map_err(|_| AppError::Internal)?
                .to_string_lossy()
                .replace('\\', "/");

            let deploy_signals = detect_deploy_signals(&relative);
            snapshot
                .deploy_signals
                .extend(deploy_signals.iter().cloned());

            let metadata = entry.metadata().map_err(|_| AppError::Internal)?;
            if metadata.len() > MAX_INDEXED_FILE_BYTES {
                if !deploy_signals.is_empty() {
                    snapshot.modules.push(IndexedModule {
                        path: relative,
                        language: Some("config".into()),
                        line_count: 0,
                        summary: "Configuration file skipped during indexing because it exceeds the size limit.".into(),
                    });
                }
                continue;
            }

            let bytes = fs::read(entry.path()).map_err(|_| AppError::Internal)?;
            let Ok(content) = String::from_utf8(bytes) else {
                continue;
            };

            let language = language_from_path(entry.path());
            let mut parsed_symbols = language
                .as_ref()
                .and_then(|kind| parse_source(kind, &content))
                .map(|(kind, tree)| extract_symbols(&kind, tree.root_node(), &content))
                .unwrap_or_default();
            for symbol in &mut parsed_symbols {
                symbol.path = relative.clone();
            }

            let mut entrypoints = detect_entrypoints(&relative, &content, &parsed_symbols);
            let imports = extract_imports(
                &relative,
                entry.path(),
                workspace_root,
                &content,
                language.as_ref(),
            );
            let logs = extract_log_statements(&relative, &content, language.as_ref());
            let summary = summarize_module(
                &relative,
                language.as_ref(),
                &parsed_symbols,
                &imports,
                &entrypoints,
                &logs,
                &deploy_signals,
            );

            if let Some(kind) = language.as_ref() {
                if kind == &LanguageKind::Rust
                    && relative.ends_with("main.rs")
                    && !entrypoints.iter().any(|item| item.label == "main")
                {
                    entrypoints.push(IndexedEntrypoint {
                        path: relative.clone(),
                        entrypoint_kind: "application_entrypoint".into(),
                        label: "main".into(),
                        line_number: parsed_symbols
                            .iter()
                            .find(|symbol| symbol.symbol_name == "main")
                            .and_then(|symbol| symbol.line_number),
                    });
                }
            }

            snapshot.modules.push(IndexedModule {
                path: relative.clone(),
                language: language.as_ref().map(LanguageKind::label),
                line_count: content.lines().count() as i32,
                summary,
            });
            snapshot.symbols.extend(parsed_symbols);
            snapshot.imports.extend(imports);
            snapshot.entrypoints.append(&mut entrypoints);
            snapshot.logs.extend(logs);
        }

        Ok(snapshot)
    }
}

pub(crate) fn execute_sandbox_index(
    request: &SandboxIndexRequest,
) -> Result<SnapshotIndex, AppError> {
    let workspace_provider = ContainerWorkspaceProvider::new(
        std::env::temp_dir().join("hotfix-mock-sandbox-workspaces"),
    );
    let executor = NoopCommandExecutor;
    let indexer = TreeSitterIndexer;
    let workspace = workspace_provider.materialize(
        &request.artifact_path,
        &request.base_directory,
        &request.policy,
    )?;
    let command_result = executor.execute(
        &workspace,
        &SandboxCommand {
            program: "index".into(),
            args: Vec::new(),
        },
        &request.policy,
    )?;
    let _ = (
        command_result.exit_code,
        command_result.stdout.len(),
        command_result.stderr.len(),
    );
    indexer.index(&workspace.root)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct SnapshotIndex {
    modules: Vec<IndexedModule>,
    imports: Vec<IndexedImport>,
    symbols: Vec<IndexedSymbol>,
    entrypoints: Vec<IndexedEntrypoint>,
    logs: Vec<IndexedLogStatement>,
    deploy_signals: Vec<IndexedDeploySignal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexedModule {
    path: String,
    language: Option<String>,
    line_count: i32,
    summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexedImport {
    source_path: String,
    raw_import: String,
    resolved_path: Option<String>,
    import_kind: String,
    line_number: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexedSymbol {
    path: String,
    symbol_kind: String,
    symbol_name: String,
    line_number: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexedEntrypoint {
    path: String,
    entrypoint_kind: String,
    label: String,
    line_number: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexedLogStatement {
    path: String,
    level: Option<String>,
    expression: String,
    line_number: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexedDeploySignal {
    path: String,
    signal_kind: String,
    evidence: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LanguageKind {
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Rust,
    Go,
    Java,
}

impl LanguageKind {
    fn label(&self) -> String {
        match self {
            Self::JavaScript => "javascript",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::Python => "python",
            Self::Rust => "rust",
            Self::Go => "go",
            Self::Java => "java",
        }
        .to_string()
    }
}

#[derive(Debug, FromRow)]
struct ClaimedIndexJob {
    job_id: Uuid,
    repo_snapshot_id: Uuid,
    node_id: Uuid,
    snapshot_artifact_key: String,
    github_repo_full_name: String,
    commit_sha: String,
    base_directory: String,
    indexed_at: Option<time::OffsetDateTime>,
}

#[derive(Debug, FromRow)]
struct ProviderTokenRow {
    access_token_nonce: Vec<u8>,
    access_token_ciphertext: Vec<u8>,
}

async fn claim_next_index_job(
    db: &PgPool,
    claimer_id: &str,
    lease_seconds: i32,
) -> Result<Option<ClaimedIndexJob>, AppError> {
    let mut tx = db.begin().await?;

    let claimed = sqlx::query_as::<_, ClaimedIndexJob>(
        r#"
        with candidate_snapshot as (
            select repo_snapshots.id
            from repo_snapshots
            where repo_snapshots.indexed_at is null
              and exists (
                  select 1
                  from index_jobs
                  where index_jobs.repo_snapshot_id = repo_snapshots.id
                    and (
                        index_jobs.status = 'queued'
                        or (
                            index_jobs.status = 'running'
                            and (
                                index_jobs.lease_expires_at is null
                                or index_jobs.lease_expires_at <= now()
                            )
                        )
                    )
              )
            order by repo_snapshots.created_at asc
            limit 1
            for update skip locked
        ),
        updated_jobs as (
            update index_jobs
            set status = 'running',
                progress_percentage = greatest(progress_percentage, 5),
                started_at = coalesce(started_at, now()),
                finished_at = null,
                updated_at = now(),
                error_summary = null,
                claimed_by = $1,
                claimed_at = now(),
                lease_expires_at = now() + make_interval(secs => $2),
                attempt_count = attempt_count + 1
            where repo_snapshot_id in (select id from candidate_snapshot)
              and (
                  status = 'queued'
                  or (
                      status = 'running'
                      and (
                          lease_expires_at is null
                          or lease_expires_at <= now()
                      )
                  )
              )
            returning
                index_jobs.id as job_id,
                index_jobs.repo_snapshot_id,
                index_jobs.hotfix_project_graph_node_id as node_id
        )
        select
            updated_jobs.job_id,
            updated_jobs.repo_snapshot_id,
            updated_jobs.node_id,
            repo_snapshots.snapshot_artifact_key,
            repo_snapshots.github_repo_full_name,
            repo_snapshots.commit_sha,
            repo_snapshots.base_directory,
            repo_snapshots.indexed_at
        from updated_jobs
        join repo_snapshots on repo_snapshots.id = updated_jobs.repo_snapshot_id
        order by updated_jobs.job_id asc
        limit 1
        "#,
    )
    .bind(claimer_id)
    .bind(lease_seconds)
    .fetch_optional(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(claimed)
}

async fn run_claimed_index_job(
    db: &PgPool,
    resolver: &dyn SnapshotResolver,
    sandbox: &dyn SandboxProvider,
    policy: &ExecutionPolicy,
    claimer_id: &str,
    job: &ClaimedIndexJob,
) -> Result<(), AppError> {
    if job.indexed_at.is_some() {
        mark_snapshot_jobs_completed(db, job.repo_snapshot_id, &job.commit_sha).await?;
        return Ok(());
    }

    let artifact_path = resolver.ensure_artifact(job).await?;
    mark_snapshot_progress(db, job.repo_snapshot_id, 35, claimer_id).await?;

    let request = SandboxIndexRequest {
        artifact_path,
        base_directory: job.base_directory.clone(),
        policy: policy.clone(),
    };
    let result = sandbox.index(&request).await?;
    mark_snapshot_progress(db, job.repo_snapshot_id, 80, claimer_id).await?;

    persist_snapshot_index(db, job.repo_snapshot_id, &result).await?;
    mark_snapshot_jobs_completed(db, job.repo_snapshot_id, &job.commit_sha).await?;
    Ok(())
}

async fn load_github_access_token_for_node(
    db: &PgPool,
    session_secret: &[u8],
    node_id: Uuid,
) -> Result<String, AppError> {
    let row = sqlx::query_as::<_, ProviderTokenRow>(
        r#"
        select
            provider_connections.access_token_nonce,
            provider_connections.access_token_ciphertext
        from hotfix_project_graph_nodes
        join hotfix_projects on hotfix_projects.id = hotfix_project_graph_nodes.hotfix_project_id
        join provider_connections
            on provider_connections.user_id = hotfix_projects.user_id
           and provider_connections.provider = 'github'
        where hotfix_project_graph_nodes.id = $1
        limit 1
        "#,
    )
    .bind(node_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| {
        AppError::BadRequest("Connect GitHub before indexing this repository.".into())
    })?;

    decrypt_provider_token(
        session_secret,
        &row.access_token_nonce,
        &row.access_token_ciphertext,
    )
}

async fn mark_snapshot_progress(
    db: &PgPool,
    snapshot_id: Uuid,
    progress: i32,
    claimer_id: &str,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;

    sqlx::query(
        r#"
        update index_jobs
        set status = 'running',
            progress_percentage = greatest(progress_percentage, $2),
            updated_at = now(),
            lease_expires_at = now() + make_interval(secs => $3)
        where repo_snapshot_id = $1
          and status = 'running'
          and claimed_by = $4
        "#,
    )
    .bind(snapshot_id)
    .bind(progress)
    .bind(INDEX_JOB_LEASE_SECONDS)
    .bind(claimer_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        update hotfix_project_graph_nodes
        set indexing_status = 'indexing',
            indexing_percentage = greatest(indexing_percentage, $2),
            updated_at = now()
        where id in (
            select hotfix_project_graph_node_id
            from index_jobs
            where repo_snapshot_id = $1
        )
        "#,
    )
    .bind(snapshot_id)
    .bind(progress)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

async fn mark_snapshot_jobs_completed(
    db: &PgPool,
    snapshot_id: Uuid,
    commit_sha: &str,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;

    sqlx::query(
        r#"
        update repo_snapshots
        set indexed_at = coalesce(indexed_at, now()),
            last_error = null,
            updated_at = now()
        where id = $1
        "#,
    )
    .bind(snapshot_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        update index_jobs
        set status = 'completed',
            progress_percentage = 100,
            finished_at = coalesce(finished_at, now()),
            updated_at = now(),
            error_summary = null,
            claimed_by = null,
            claimed_at = null,
            lease_expires_at = null
        where repo_snapshot_id = $1 and status in ('queued', 'running', 'completed')
        "#,
    )
    .bind(snapshot_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        update hotfix_project_graph_nodes
        set indexing_status = 'indexed',
            indexing_percentage = 100,
            indexed_commit_sha = $2,
            updated_at = now()
        where id in (
            select hotfix_project_graph_node_id
            from index_jobs
            where repo_snapshot_id = $1
        )
        "#,
    )
    .bind(snapshot_id)
    .bind(commit_sha)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

async fn mark_snapshot_failed(
    db: &PgPool,
    snapshot_id: Uuid,
    message: &str,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    sqlx::query(
        r#"
        update repo_snapshots
        set last_error = $2, updated_at = now()
        where id = $1
        "#,
    )
    .bind(snapshot_id)
    .bind(message)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        update index_jobs
        set status = 'failed',
            error_summary = $2,
            finished_at = now(),
            updated_at = now(),
            claimed_by = null,
            claimed_at = null,
            lease_expires_at = null
        where repo_snapshot_id = $1 and status in ('queued', 'running', 'failed')
        "#,
    )
    .bind(snapshot_id)
    .bind(message)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        update hotfix_project_graph_nodes
        set indexing_status = 'failed',
            updated_at = now()
        where id in (
            select hotfix_project_graph_node_id
            from index_jobs
            where repo_snapshot_id = $1
        )
        "#,
    )
    .bind(snapshot_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

async fn persist_snapshot_index(
    db: &PgPool,
    snapshot_id: Uuid,
    snapshot: &SnapshotIndex,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;

    for table in [
        "repo_snapshot_modules",
        "repo_snapshot_imports",
        "repo_snapshot_symbols",
        "repo_snapshot_entrypoints",
        "repo_snapshot_log_statements",
        "repo_snapshot_deploy_signals",
    ] {
        let query = format!("delete from {table} where repo_snapshot_id = $1");
        sqlx::query(&query)
            .bind(snapshot_id)
            .execute(&mut *tx)
            .await?;
    }

    for module in &snapshot.modules {
        sqlx::query(
            r#"
            insert into repo_snapshot_modules (
                id,
                repo_snapshot_id,
                path,
                language,
                line_count,
                summary
            )
            values ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(snapshot_id)
        .bind(&module.path)
        .bind(&module.language)
        .bind(module.line_count)
        .bind(&module.summary)
        .execute(&mut *tx)
        .await?;
    }

    for import in &snapshot.imports {
        sqlx::query(
            r#"
            insert into repo_snapshot_imports (
                id,
                repo_snapshot_id,
                source_path,
                raw_import,
                resolved_path,
                import_kind,
                line_number
            )
            values ($1, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(snapshot_id)
        .bind(&import.source_path)
        .bind(&import.raw_import)
        .bind(&import.resolved_path)
        .bind(&import.import_kind)
        .bind(import.line_number)
        .execute(&mut *tx)
        .await?;
    }

    for symbol in &snapshot.symbols {
        sqlx::query(
            r#"
            insert into repo_snapshot_symbols (
                id,
                repo_snapshot_id,
                path,
                symbol_kind,
                symbol_name,
                line_number
            )
            values ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(snapshot_id)
        .bind(&symbol.path)
        .bind(&symbol.symbol_kind)
        .bind(&symbol.symbol_name)
        .bind(symbol.line_number)
        .execute(&mut *tx)
        .await?;
    }

    for entrypoint in &snapshot.entrypoints {
        sqlx::query(
            r#"
            insert into repo_snapshot_entrypoints (
                id,
                repo_snapshot_id,
                path,
                entrypoint_kind,
                label,
                line_number
            )
            values ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(snapshot_id)
        .bind(&entrypoint.path)
        .bind(&entrypoint.entrypoint_kind)
        .bind(&entrypoint.label)
        .bind(entrypoint.line_number)
        .execute(&mut *tx)
        .await?;
    }

    for log in &snapshot.logs {
        sqlx::query(
            r#"
            insert into repo_snapshot_log_statements (
                id,
                repo_snapshot_id,
                path,
                level,
                expression,
                line_number
            )
            values ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(snapshot_id)
        .bind(&log.path)
        .bind(&log.level)
        .bind(&log.expression)
        .bind(log.line_number)
        .execute(&mut *tx)
        .await?;
    }

    for signal in &snapshot.deploy_signals {
        sqlx::query(
            r#"
            insert into repo_snapshot_deploy_signals (
                id,
                repo_snapshot_id,
                path,
                signal_kind,
                evidence
            )
            values ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(snapshot_id)
        .bind(&signal.path)
        .bind(&signal.signal_kind)
        .bind(&signal.evidence)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

fn extract_zip_archive(artifact_path: &Path, destination: &Path) -> Result<PathBuf, AppError> {
    let bytes = fs::read(artifact_path).map_err(|_| AppError::Internal)?;
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader).map_err(|_| AppError::Internal)?;
    let mut root_dir: Option<PathBuf> = None;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|_| AppError::Internal)?;
        let Some(enclosed_name) = file.enclosed_name().map(PathBuf::from) else {
            continue;
        };
        let output_path = destination.join(&enclosed_name);
        if file.name().ends_with('/') {
            fs::create_dir_all(&output_path).map_err(|_| AppError::Internal)?;
        } else {
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|_| AppError::Internal)?;
            }
            let mut output = fs::File::create(&output_path).map_err(|_| AppError::Internal)?;
            std::io::copy(&mut file, &mut output).map_err(|_| AppError::Internal)?;
        }

        if root_dir.is_none() {
            let first_component = enclosed_name
                .components()
                .next()
                .map(|component| PathBuf::from(component.as_os_str()));
            if let Some(component) = first_component {
                root_dir = Some(destination.join(component));
            }
        }
    }

    root_dir.ok_or(AppError::Internal)
}

fn should_descend(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }

    let name = entry.file_name().to_string_lossy();
    if entry.file_type().is_dir() {
        !matches!(
            name.as_ref(),
            ".git" | "node_modules" | "dist" | "build" | "target" | ".next" | "coverage" | "out"
        )
    } else {
        true
    }
}

fn language_from_path(path: &Path) -> Option<LanguageKind> {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    match path.extension().and_then(|value| value.to_str()) {
        Some("js") | Some("mjs") | Some("cjs") | Some("jsx") => Some(LanguageKind::JavaScript),
        Some("ts") => Some(LanguageKind::TypeScript),
        Some("tsx") => Some(LanguageKind::Tsx),
        Some("py") => Some(LanguageKind::Python),
        Some("rs") => Some(LanguageKind::Rust),
        Some("go") => Some(LanguageKind::Go),
        Some("java") => Some(LanguageKind::Java),
        _ if filename == "Dockerfile" => None,
        _ => None,
    }
}

fn parse_source(
    language_kind: &LanguageKind,
    source: &str,
) -> Option<(LanguageKind, tree_sitter::Tree)> {
    let mut parser = Parser::new();
    let language = language_for_kind(language_kind)?;
    parser.set_language(&language).ok()?;
    parser
        .parse(source, None)
        .map(|tree| (*language_kind, tree))
}

fn language_for_kind(language_kind: &LanguageKind) -> Option<Language> {
    match language_kind {
        LanguageKind::JavaScript => Some(tree_sitter_javascript::LANGUAGE.into()),
        LanguageKind::TypeScript => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        LanguageKind::Tsx => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        LanguageKind::Python => Some(tree_sitter_python::LANGUAGE.into()),
        LanguageKind::Rust => Some(tree_sitter_rust::LANGUAGE.into()),
        LanguageKind::Go => Some(tree_sitter_go::LANGUAGE.into()),
        LanguageKind::Java => Some(tree_sitter_java::LANGUAGE.into()),
    }
}

fn extract_symbols(
    language_kind: &LanguageKind,
    root: Node<'_>,
    source: &str,
) -> Vec<IndexedSymbol> {
    let mut symbols = Vec::new();
    collect_symbols(language_kind, root, source, &mut symbols);
    symbols
}

fn collect_symbols(
    language_kind: &LanguageKind,
    node: Node<'_>,
    source: &str,
    symbols: &mut Vec<IndexedSymbol>,
) {
    if let Some((symbol_kind, name)) = symbol_from_node(language_kind, node, source) {
        symbols.push(IndexedSymbol {
            path: String::new(),
            symbol_kind,
            symbol_name: name,
            line_number: Some((node.start_position().row + 1) as i32),
        });
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_symbols(language_kind, child, source, symbols);
    }
}

fn symbol_from_node(
    language_kind: &LanguageKind,
    node: Node<'_>,
    source: &str,
) -> Option<(String, String)> {
    let kind = node.kind();
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| node.named_child(0))
        .filter(|candidate| candidate.is_named());

    let name = name_node
        .and_then(|candidate| candidate.utf8_text(source.as_bytes()).ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    let symbol_kind = match language_kind {
        LanguageKind::JavaScript | LanguageKind::TypeScript | LanguageKind::Tsx => match kind {
            "function_declaration" => "function",
            "class_declaration" => "class",
            "interface_declaration" => "interface",
            "enum_declaration" => "enum",
            "type_alias_declaration" => "type",
            _ => return None,
        },
        LanguageKind::Python => match kind {
            "function_definition" => "function",
            "class_definition" => "class",
            _ => return None,
        },
        LanguageKind::Rust => match kind {
            "function_item" => "function",
            "struct_item" => "struct",
            "enum_item" => "enum",
            "trait_item" => "trait",
            _ => return None,
        },
        LanguageKind::Go => match kind {
            "function_declaration" | "method_declaration" => "function",
            "type_spec" => "type",
            _ => return None,
        },
        LanguageKind::Java => match kind {
            "class_declaration" => "class",
            "interface_declaration" => "interface",
            "enum_declaration" => "enum",
            "record_declaration" => "record",
            "method_declaration" => "method",
            _ => return None,
        },
    };

    Some((symbol_kind.into(), name.to_string()))
}

fn extract_imports(
    relative_path: &str,
    full_path: &Path,
    workspace_root: &Path,
    content: &str,
    language: Option<&LanguageKind>,
) -> Vec<IndexedImport> {
    match language {
        Some(LanguageKind::JavaScript)
        | Some(LanguageKind::TypeScript)
        | Some(LanguageKind::Tsx) => {
            extract_javascript_imports(relative_path, full_path, workspace_root, content)
        }
        Some(LanguageKind::Python) => {
            extract_python_imports(relative_path, full_path, workspace_root, content)
        }
        Some(LanguageKind::Rust) => extract_simple_imports(
            relative_path,
            content,
            "use",
            Regex::new(r"^\s*use\s+([^;]+);").expect("valid rust import regex"),
        ),
        Some(LanguageKind::Go) => extract_go_imports(relative_path, content),
        Some(LanguageKind::Java) => extract_simple_imports(
            relative_path,
            content,
            "import",
            Regex::new(r"^\s*import\s+([a-zA-Z0-9_.*]+);").expect("valid java import regex"),
        ),
        None => Vec::new(),
    }
}

fn extract_javascript_imports(
    relative_path: &str,
    full_path: &Path,
    workspace_root: &Path,
    content: &str,
) -> Vec<IndexedImport> {
    let import_regex =
        Regex::new(r#"(?m)^\s*(?:import(?:.+?\sfrom\s+)?|export.+?\sfrom\s+)["']([^"']+)["']"#)
            .expect("valid javascript import regex");
    let require_regex = Regex::new(r#"(?m)\b(?:require|import)\(\s*["']([^"']+)["']\s*\)"#)
        .expect("valid js require regex");

    let mut imports = Vec::new();
    for (line_index, line) in content.lines().enumerate() {
        for capture in import_regex.captures_iter(line) {
            let raw_import = capture[1].to_string();
            imports.push(IndexedImport {
                source_path: relative_path.to_string(),
                resolved_path: resolve_js_import(full_path, workspace_root, &raw_import),
                raw_import,
                import_kind: "module".into(),
                line_number: Some((line_index + 1) as i32),
            });
        }
        for capture in require_regex.captures_iter(line) {
            let raw_import = capture[1].to_string();
            imports.push(IndexedImport {
                source_path: relative_path.to_string(),
                resolved_path: resolve_js_import(full_path, workspace_root, &raw_import),
                raw_import,
                import_kind: "dynamic".into(),
                line_number: Some((line_index + 1) as i32),
            });
        }
    }

    imports
}

fn extract_python_imports(
    relative_path: &str,
    full_path: &Path,
    workspace_root: &Path,
    content: &str,
) -> Vec<IndexedImport> {
    let import_regex =
        Regex::new(r#"^\s*import\s+([A-Za-z0-9_., ]+)"#).expect("valid python import regex");
    let from_regex =
        Regex::new(r#"^\s*from\s+([.\w]+)\s+import\s+"#).expect("valid python from-import regex");
    let mut imports = Vec::new();

    for (line_index, line) in content.lines().enumerate() {
        if let Some(capture) = from_regex.captures(line) {
            let raw_import = capture[1].trim().to_string();
            imports.push(IndexedImport {
                source_path: relative_path.to_string(),
                resolved_path: resolve_python_import(full_path, workspace_root, &raw_import),
                raw_import,
                import_kind: "module".into(),
                line_number: Some((line_index + 1) as i32),
            });
            continue;
        }

        if let Some(capture) = import_regex.captures(line) {
            let names = capture[1]
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty());
            for name in names {
                let raw_import = name.to_string();
                imports.push(IndexedImport {
                    source_path: relative_path.to_string(),
                    resolved_path: resolve_python_import(full_path, workspace_root, &raw_import),
                    raw_import,
                    import_kind: "module".into(),
                    line_number: Some((line_index + 1) as i32),
                });
            }
        }
    }

    imports
}

fn extract_go_imports(relative_path: &str, content: &str) -> Vec<IndexedImport> {
    let mut imports = Vec::new();
    let quoted_path = Regex::new(r#""([^"]+)""#).expect("valid go import regex");

    for (line_index, line) in content.lines().enumerate() {
        if !line.trim_start().starts_with("import") && !line.contains('"') {
            continue;
        }

        for capture in quoted_path.captures_iter(line) {
            imports.push(IndexedImport {
                source_path: relative_path.to_string(),
                raw_import: capture[1].to_string(),
                resolved_path: None,
                import_kind: "package".into(),
                line_number: Some((line_index + 1) as i32),
            });
        }
    }

    imports
}

fn extract_simple_imports(
    relative_path: &str,
    content: &str,
    import_kind: &str,
    regex: Regex,
) -> Vec<IndexedImport> {
    let mut imports = Vec::new();

    for (line_index, line) in content.lines().enumerate() {
        if let Some(capture) = regex.captures(line) {
            imports.push(IndexedImport {
                source_path: relative_path.to_string(),
                raw_import: capture[1].trim().to_string(),
                resolved_path: None,
                import_kind: import_kind.to_string(),
                line_number: Some((line_index + 1) as i32),
            });
        }
    }

    imports
}

fn resolve_js_import(full_path: &Path, workspace_root: &Path, raw_import: &str) -> Option<String> {
    if !raw_import.starts_with('.') {
        return None;
    }

    let base_dir = full_path.parent()?;
    let import_path = base_dir.join(raw_import);
    let candidates = [
        import_path.clone(),
        import_path.with_extension("ts"),
        import_path.with_extension("tsx"),
        import_path.with_extension("js"),
        import_path.with_extension("jsx"),
        import_path.with_extension("mjs"),
        import_path.with_extension("cjs"),
        import_path.join("index.ts"),
        import_path.join("index.tsx"),
        import_path.join("index.js"),
        import_path.join("index.jsx"),
    ];

    resolve_existing_path(workspace_root, &candidates)
}

fn resolve_python_import(
    full_path: &Path,
    workspace_root: &Path,
    raw_import: &str,
) -> Option<String> {
    let current_dir = full_path.parent()?;
    if raw_import.starts_with('.') {
        let dot_count = raw_import
            .chars()
            .take_while(|character| *character == '.')
            .count();
        let suffix = raw_import.trim_start_matches('.');
        let mut ancestor = current_dir.to_path_buf();
        for _ in 1..dot_count {
            ancestor = ancestor.parent()?.to_path_buf();
        }
        let candidate = if suffix.is_empty() {
            ancestor.join("__init__.py")
        } else {
            ancestor.join(suffix.replace('.', "/"))
        };
        let candidates = [
            candidate.clone(),
            candidate.with_extension("py"),
            candidate.join("__init__.py"),
        ];
        return resolve_existing_path(workspace_root, &candidates);
    }

    let candidate = workspace_root.join(raw_import.replace('.', "/"));
    let candidates = [
        candidate.clone(),
        candidate.with_extension("py"),
        candidate.join("__init__.py"),
    ];
    resolve_existing_path(workspace_root, &candidates)
}

fn resolve_existing_path(workspace_root: &Path, candidates: &[PathBuf]) -> Option<String> {
    candidates.iter().find_map(|candidate| {
        if candidate.exists() && candidate.is_file() {
            candidate
                .strip_prefix(workspace_root)
                .ok()
                .map(|value| value.to_string_lossy().replace('\\', "/"))
        } else {
            None
        }
    })
}

fn extract_log_statements(
    relative_path: &str,
    content: &str,
    language: Option<&LanguageKind>,
) -> Vec<IndexedLogStatement> {
    let mut logs = Vec::new();
    for (line_index, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        let level = match language {
            Some(LanguageKind::JavaScript)
            | Some(LanguageKind::TypeScript)
            | Some(LanguageKind::Tsx)
                if trimmed.contains("console.error") =>
            {
                Some("error")
            }
            Some(LanguageKind::JavaScript)
            | Some(LanguageKind::TypeScript)
            | Some(LanguageKind::Tsx)
                if trimmed.contains("console.warn") =>
            {
                Some("warn")
            }
            Some(LanguageKind::JavaScript)
            | Some(LanguageKind::TypeScript)
            | Some(LanguageKind::Tsx)
                if trimmed.contains("console.info") =>
            {
                Some("info")
            }
            Some(LanguageKind::JavaScript)
            | Some(LanguageKind::TypeScript)
            | Some(LanguageKind::Tsx)
                if trimmed.contains("console.log") =>
            {
                Some("log")
            }
            Some(LanguageKind::Python) if trimmed.contains("logging.error") => Some("error"),
            Some(LanguageKind::Python) if trimmed.contains("logging.warning") => Some("warn"),
            Some(LanguageKind::Python) if trimmed.contains("logging.info") => Some("info"),
            Some(LanguageKind::Python) if trimmed.contains("print(") => Some("log"),
            Some(LanguageKind::Rust)
                if trimmed.contains("tracing::error!") || trimmed.contains("error!") =>
            {
                Some("error")
            }
            Some(LanguageKind::Rust)
                if trimmed.contains("tracing::warn!") || trimmed.contains("warn!") =>
            {
                Some("warn")
            }
            Some(LanguageKind::Rust)
                if trimmed.contains("tracing::info!") || trimmed.contains("info!") =>
            {
                Some("info")
            }
            Some(LanguageKind::Rust) if trimmed.contains("println!") => Some("log"),
            Some(LanguageKind::Go) if trimmed.contains("slog.Error") => Some("error"),
            Some(LanguageKind::Go) if trimmed.contains("slog.Warn") => Some("warn"),
            Some(LanguageKind::Go) if trimmed.contains("slog.Info") => Some("info"),
            Some(LanguageKind::Go)
                if trimmed.contains("log.Print") || trimmed.contains("fmt.Print") =>
            {
                Some("log")
            }
            Some(LanguageKind::Java) if trimmed.contains("logger.error") => Some("error"),
            Some(LanguageKind::Java) if trimmed.contains("logger.warn") => Some("warn"),
            Some(LanguageKind::Java) if trimmed.contains("logger.info") => Some("info"),
            Some(LanguageKind::Java) if trimmed.contains("System.out.println") => Some("log"),
            _ => None,
        };

        if let Some(level) = level {
            logs.push(IndexedLogStatement {
                path: relative_path.to_string(),
                level: Some(level.to_string()),
                expression: trimmed.to_string(),
                line_number: Some((line_index + 1) as i32),
            });
        }
    }
    logs
}

fn detect_entrypoints(
    relative_path: &str,
    content: &str,
    symbols: &[IndexedSymbol],
) -> Vec<IndexedEntrypoint> {
    let mut entrypoints = Vec::new();
    let lower_path = relative_path.to_ascii_lowercase();

    for symbol in symbols {
        if symbol.symbol_name == "main" {
            entrypoints.push(IndexedEntrypoint {
                path: relative_path.to_string(),
                entrypoint_kind: "application_entrypoint".into(),
                label: "main".into(),
                line_number: symbol.line_number,
            });
        }
    }

    if matches!(
        lower_path.as_str(),
        path if path.ends_with("src/index.tsx")
            || path.ends_with("src/index.ts")
            || path.ends_with("src/main.ts")
            || path.ends_with("src/main.tsx")
            || path.ends_with("app.tsx")
            || path.ends_with("main.py")
            || path.ends_with("__main__.py")
            || path.ends_with("main.go")
            || path.ends_with("main.rs")
            || path.ends_with("main.java")
    ) {
        entrypoints.push(IndexedEntrypoint {
            path: relative_path.to_string(),
            entrypoint_kind: "application_entrypoint".into(),
            label: "root entrypoint".into(),
            line_number: None,
        });
    }

    for (line_index, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        let route_label = if trimmed.contains("Router::new()") || trimmed.contains(".route(") {
            Some("http route")
        } else if trimmed.contains("app.get(")
            || trimmed.contains("app.post(")
            || trimmed.contains("router.get(")
            || trimmed.contains("router.post(")
            || trimmed.contains("router.use(")
        {
            Some("http route")
        } else if trimmed.starts_with("@app.")
            || trimmed.starts_with("@router.")
            || trimmed.contains("FastAPI(")
        {
            Some("http route")
        } else if trimmed.contains("http.HandleFunc(")
            || trimmed.contains(".GET(")
            || trimmed.contains(".POST(")
        {
            Some("http route")
        } else if trimmed.contains("@GetMapping")
            || trimmed.contains("@PostMapping")
            || trimmed.contains("@RequestMapping")
        {
            Some("http route")
        } else if trimmed.contains("fetch(") {
            Some("frontend request callsite")
        } else {
            None
        };

        if let Some(label) = route_label {
            entrypoints.push(IndexedEntrypoint {
                path: relative_path.to_string(),
                entrypoint_kind: if label == "frontend request callsite" {
                    "frontend_callsite".into()
                } else {
                    "http_route".into()
                },
                label: label.into(),
                line_number: Some((line_index + 1) as i32),
            });
        }
    }

    entrypoints
}

fn detect_deploy_signals(relative_path: &str) -> Vec<IndexedDeploySignal> {
    let file_name = Path::new(relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let lower = relative_path.to_ascii_lowercase();
    let mut signals = Vec::new();

    let add_signal = |signals: &mut Vec<IndexedDeploySignal>, signal_kind: &str, evidence: &str| {
        signals.push(IndexedDeploySignal {
            path: relative_path.to_string(),
            signal_kind: signal_kind.to_string(),
            evidence: evidence.to_string(),
        });
    };

    if file_name == "Dockerfile" {
        add_signal(&mut signals, "dockerfile", "Dockerfile detected");
    }
    if matches!(file_name, "docker-compose.yml" | "docker-compose.yaml") {
        add_signal(
            &mut signals,
            "docker_compose",
            "Docker Compose manifest detected",
        );
    }
    if matches!(file_name, "cloudbuild.yaml" | "cloudbuild.yml") {
        add_signal(
            &mut signals,
            "cloudbuild",
            "Google Cloud Build manifest detected",
        );
    }
    if file_name == "railway.json" {
        add_signal(&mut signals, "railway", "Railway manifest detected");
    }
    if file_name == "vercel.json" {
        add_signal(&mut signals, "vercel", "Vercel manifest detected");
    }
    if file_name == "Procfile" {
        add_signal(&mut signals, "procfile", "Procfile detected");
    }
    if file_name == "fly.toml" {
        add_signal(&mut signals, "fly", "Fly.io configuration detected");
    }
    if lower.starts_with(".github/workflows/")
        && matches!(
            Path::new(relative_path)
                .extension()
                .and_then(|value| value.to_str()),
            Some("yml") | Some("yaml")
        )
    {
        add_signal(
            &mut signals,
            "github_actions",
            "GitHub Actions workflow detected",
        );
    }

    signals
}

fn summarize_module(
    relative_path: &str,
    language: Option<&LanguageKind>,
    symbols: &[IndexedSymbol],
    imports: &[IndexedImport],
    entrypoints: &[IndexedEntrypoint],
    logs: &[IndexedLogStatement],
    deploy_signals: &[IndexedDeploySignal],
) -> String {
    let label = language
        .map(LanguageKind::label)
        .unwrap_or_else(|| "config".into());
    let named_symbols = symbols
        .iter()
        .take(3)
        .map(|symbol| symbol.symbol_name.as_str())
        .collect::<Vec<_>>();
    let mut summary = format!("{label} module");

    if !named_symbols.is_empty() {
        summary.push_str(&format!(" defining {}", named_symbols.join(", ")));
    }
    if !imports.is_empty() {
        summary.push_str(&format!(
            ", importing {} dependency{}",
            imports.len(),
            if imports.len() == 1 { "" } else { "ies" }
        ));
    }
    if !entrypoints.is_empty() {
        summary.push_str(&format!(
            ", with {} entrypoint{}",
            entrypoints.len(),
            if entrypoints.len() == 1 { "" } else { "s" }
        ));
    }
    if !logs.is_empty() {
        summary.push_str(&format!(
            ", and {} log statement{}",
            logs.len(),
            if logs.len() == 1 { "" } else { "s" }
        ));
    }
    if !deploy_signals.is_empty() {
        summary.push_str(&format!(
            ". Deployment signal: {}",
            deploy_signals[0].signal_kind
        ));
    } else if relative_path.ends_with(".tsx")
        && named_symbols
            .iter()
            .any(|name| name.chars().next().unwrap_or('a').is_uppercase())
    {
        summary.push_str(". Likely contains UI components.");
    } else {
        summary.push('.');
    }

    summary
}
