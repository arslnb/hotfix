use std::{
    collections::{HashMap, HashSet},
    env,
    fmt::Display,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::{get, patch, post},
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use dotenvy::dotenv;
use rand::random;
use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection, PgPool, postgres::PgPoolOptions, types::Json as SqlJson};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tower_sessions::{
    Expiry, Session, SessionManagerLayer, SessionStore,
    cookie::{Key, SameSite, time::Duration as CookieDuration},
    session::Error as SessionError,
    session::{Id as SessionId, Record as SessionRecord},
    session_store,
};
use tracing::{error, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use url::Url;
use uuid::Uuid;

const SESSION_COOKIE_NAME: &str = "hotfix.sid";
const SESSION_USER_ID_KEY: &str = "user_id";
const OAUTH_FLOW_KEY: &str = "oauth_flow";
const USER_AGENT_VALUE: &str = "hotfix-auth/0.1";

#[derive(Clone)]
struct AppState {
    config: Arc<AppConfig>,
    db: PgPool,
    http: reqwest::Client,
}

#[derive(Clone, Debug)]
struct PgSessionStore {
    pool: PgPool,
}

impl PgSessionStore {
    fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    async fn migrate(&self) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(r#"create schema if not exists "tower_sessions""#)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"
            create table if not exists "tower_sessions"."session" (
                id text primary key not null,
                data bytea not null,
                expiry_date timestamptz not null
            )
            "#,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn id_exists(
        &self,
        conn: &mut PgConnection,
        session_id: &SessionId,
    ) -> session_store::Result<bool> {
        let exists = sqlx::query_scalar::<_, bool>(
            r#"
            select exists(
                select 1
                from "tower_sessions"."session"
                where id = $1
            )
            "#,
        )
        .bind(session_id.to_string())
        .fetch_one(conn)
        .await
        .map_err(backend_error)?;

        Ok(exists)
    }

    async fn save_with_conn(
        &self,
        conn: &mut PgConnection,
        record: &SessionRecord,
    ) -> session_store::Result<()> {
        let encoded = rmp_serde::to_vec(record).map_err(|error| {
            session_store::Error::Encode(format!("Could not encode session record: {error}"))
        })?;

        sqlx::query(
            r#"
            insert into "tower_sessions"."session" (id, data, expiry_date)
            values ($1, $2, $3)
            on conflict (id) do update
            set data = excluded.data, expiry_date = excluded.expiry_date
            "#,
        )
        .bind(record.id.to_string())
        .bind(encoded)
        .bind(record.expiry_date)
        .execute(conn)
        .await
        .map_err(backend_error)?;

        Ok(())
    }
}

#[async_trait]
impl SessionStore for PgSessionStore {
    async fn create(&self, record: &mut SessionRecord) -> session_store::Result<()> {
        let mut tx = self.pool.begin().await.map_err(backend_error)?;

        while self.id_exists(&mut tx, &record.id).await? {
            record.id = SessionId::default();
        }

        self.save_with_conn(&mut tx, record).await?;
        tx.commit().await.map_err(backend_error)?;

        Ok(())
    }

    async fn save(&self, record: &SessionRecord) -> session_store::Result<()> {
        let mut conn = self.pool.acquire().await.map_err(backend_error)?;
        self.save_with_conn(&mut conn, record).await
    }

    async fn load(&self, session_id: &SessionId) -> session_store::Result<Option<SessionRecord>> {
        let maybe_record = sqlx::query_as::<_, (Vec<u8>,)>(
            r#"
            select data
            from "tower_sessions"."session"
            where id = $1 and expiry_date > $2
            "#,
        )
        .bind(session_id.to_string())
        .bind(OffsetDateTime::now_utc())
        .fetch_optional(&self.pool)
        .await
        .map_err(backend_error)?;

        match maybe_record {
            Some((data,)) => {
                let record = rmp_serde::from_slice(&data).map_err(|error| {
                    session_store::Error::Decode(format!(
                        "Could not decode session record: {error}"
                    ))
                })?;
                Ok(Some(record))
            }
            None => Ok(None),
        }
    }

    async fn delete(&self, session_id: &SessionId) -> session_store::Result<()> {
        sqlx::query(
            r#"
            delete from "tower_sessions"."session"
            where id = $1
            "#,
        )
        .bind(session_id.to_string())
        .execute(&self.pool)
        .await
        .map_err(backend_error)?;

        Ok(())
    }
}

#[derive(Clone, Debug)]
struct AppConfig {
    listen_addr: SocketAddr,
    public_url: Url,
    database_url: String,
    session_secret: Vec<u8>,
    github_client_id: String,
    github_client_secret: String,
    sentry_client_id: String,
    sentry_client_secret: String,
    frontend_dist: Option<PathBuf>,
}

impl AppConfig {
    fn from_env() -> Result<Self, AppError> {
        let public_url = parse_url("HOTFIX_PUBLIC_URL")?;
        let listen_addr = env::var("HOTFIX_LISTEN_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:3000".to_string())
            .parse()
            .map_err(|_| AppError::Config("HOTFIX_LISTEN_ADDR must be host:port".into()))?;
        let database_url = required_env("HOTFIX_DATABASE_URL")?;
        let session_secret = decode_session_secret(&required_env("HOTFIX_SESSION_SECRET")?)?;

        let frontend_dist = env::var("HOTFIX_STATIC_DIR")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../frontend/dist");
                candidate.join("index.html").exists().then_some(candidate)
            });

        Ok(Self {
            listen_addr,
            public_url,
            database_url,
            session_secret,
            github_client_id: required_env("HOTFIX_GITHUB_CLIENT_ID")?,
            github_client_secret: required_env("HOTFIX_GITHUB_CLIENT_SECRET")?,
            sentry_client_id: required_env("HOTFIX_SENTRY_CLIENT_ID")?,
            sentry_client_secret: required_env("HOTFIX_SENTRY_CLIENT_SECRET")?,
            frontend_dist,
        })
    }
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("{0}")]
    Config(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("authentication failed")]
    Auth(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error("internal server error")]
    Internal,
}

impl AppError {
    fn client_message(&self) -> &str {
        match self {
            Self::Config(message)
            | Self::BadRequest(message)
            | Self::NotFound(message)
            | Self::Auth(message) => message,
            Self::Database(_) | Self::Http(_) | Self::Session(_) | Self::Internal => {
                "Something went wrong. Please try again."
            }
        }
    }

    fn status_code(&self) -> StatusCode {
        match self {
            Self::Config(_) | Self::Internal | Self::Database(_) | Self::Http(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Auth(_) => StatusCode::UNAUTHORIZED,
            Self::Session(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        error!(error = ?self, "request failed");
        (
            self.status_code(),
            Json(ErrorPayload {
                error: self.client_message().to_string(),
            }),
        )
            .into_response()
    }
}

#[derive(Serialize)]
struct ErrorPayload {
    error: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Provider {
    GitHub,
    Sentry,
}

impl Provider {
    fn from_slug(slug: &str) -> Result<Self, AppError> {
        match slug {
            "github" => Ok(Self::GitHub),
            "sentry" => Ok(Self::Sentry),
            _ => Err(AppError::BadRequest("Unsupported login provider.".into())),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::Sentry => "sentry",
        }
    }

    fn authorize_url(self) -> &'static str {
        match self {
            Self::GitHub => "https://github.com/login/oauth/authorize",
            Self::Sentry => "https://sentry.io/oauth/authorize/",
        }
    }

    fn token_url(self) -> &'static str {
        match self {
            Self::GitHub => "https://github.com/login/oauth/access_token",
            Self::Sentry => "https://sentry.io/oauth/token/",
        }
    }

    fn callback_path(self) -> &'static str {
        match self {
            Self::GitHub => "/api/auth/github/callback",
            Self::Sentry => "/api/auth/sentry/callback",
        }
    }

    fn client_id<'a>(self, config: &'a AppConfig) -> &'a str {
        match self {
            Self::GitHub => &config.github_client_id,
            Self::Sentry => &config.sentry_client_id,
        }
    }

    fn scope(self) -> &'static str {
        match self {
            Self::GitHub => "read:user user:email read:org repo",
            Self::Sentry => "org:read project:read event:read",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OAuthFlow {
    provider: Provider,
    state: String,
    code_verifier: String,
    started_at: i64,
    link_user_id: Option<Uuid>,
}

impl OAuthFlow {
    fn new(provider: Provider, link_user_id: Option<Uuid>) -> Self {
        Self {
            provider,
            state: random_urlsafe(32),
            code_verifier: random_urlsafe(64),
            started_at: OffsetDateTime::now_utc().unix_timestamp(),
            link_user_id,
        }
    }

    fn is_fresh(&self) -> bool {
        OffsetDateTime::now_utc().unix_timestamp() - self.started_at <= 600
    }
}

#[derive(Debug, Deserialize)]
struct OAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Clone)]
struct ExternalProfile {
    provider: Provider,
    provider_user_id: String,
    username: Option<String>,
    display_name: String,
    email: Option<String>,
    avatar_url: Option<String>,
    connection: ProviderConnectionSeed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    authenticated: bool,
    user: Option<SessionUser>,
}

impl SessionPayload {
    fn anonymous() -> Self {
        Self {
            authenticated: false,
            user: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionUser {
    id: Uuid,
    display_name: String,
    email: Option<String>,
    avatar_url: Option<String>,
    providers: ConnectedProviders,
}

#[derive(Debug, FromRow)]
struct SessionUserRow {
    id: Uuid,
    display_name: String,
    email: Option<String>,
    avatar_url: Option<String>,
    github_connected: bool,
    sentry_connected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectedProviders {
    github: bool,
    sentry: bool,
}

impl From<SessionUserRow> for SessionUser {
    fn from(row: SessionUserRow) -> Self {
        Self {
            id: row.id,
            display_name: row.display_name,
            email: row.email,
            avatar_url: row.avatar_url,
            providers: ConnectedProviders {
                github: row.github_connected,
                sentry: row.sentry_connected,
            },
        }
    }
}

#[derive(Debug, Clone)]
struct ProviderConnectionSeed {
    external_id: String,
    slug: Option<String>,
    display_name: String,
    scopes: Option<String>,
    access_token: String,
}

#[derive(Debug, FromRow)]
struct IdentityLookup {
    user_id: Uuid,
}

#[derive(Debug, FromRow)]
struct ProviderConnectionRow {
    id: Uuid,
    provider: String,
    slug: Option<String>,
    display_name: String,
    scopes: Option<String>,
    access_token_nonce: Vec<u8>,
    access_token_ciphertext: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardPayload {
    sentry_organizations: Vec<SentryOrganizationSummary>,
    projects: Vec<HotfixProjectPayload>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SentryOrganizationSummary {
    connection_id: Uuid,
    slug: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotfixProjectPayload {
    id: Uuid,
    name: String,
    slug: String,
    created_at: i64,
    sentry_organization: Option<SentryOrganizationSummary>,
    sentry_projects: Vec<ImportedSentryProjectPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotfixIncidentPayload {
    id: Uuid,
    incident_key: String,
    title: String,
    status: String,
    first_seen_at: Option<i64>,
    last_seen_at: Option<i64>,
    issue_count: i64,
    sentry_project_count: i64,
    sentry_issues: Vec<IncidentSentryIssuePayload>,
    code_refs: Vec<IncidentCodeRefPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IncidentSentryIssuePayload {
    id: Uuid,
    sentry_issue_id: String,
    short_id: Option<String>,
    title: String,
    status: String,
    level: Option<String>,
    project_slug: String,
    project_name: String,
    permalink: Option<String>,
    event_count: i64,
    user_count: i64,
    first_seen_at: Option<i64>,
    last_seen_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IncidentCodeRefPayload {
    id: Uuid,
    github_repo_id: Option<i64>,
    github_repo_full_name: Option<String>,
    github_repo_url: Option<String>,
    path: String,
    start_line: Option<i32>,
    end_line: Option<i32>,
    symbol: Option<String>,
    confidence: f64,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSentryProjectPayload {
    id: Uuid,
    sentry_project_id: String,
    slug: String,
    name: String,
    platform: Option<String>,
    included: bool,
    errors_24h: i64,
    transactions_24h: i64,
    replays_24h: i64,
    profiles_24h: i64,
    sentry_repo_connected: bool,
    hotfix_repo_connected: bool,
    repo_mapping: Option<GitHubRepoMappingPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectGraphPayload {
    project_id: Uuid,
    project_slug: String,
    nodes: Vec<ProjectGraphNodePayload>,
    edges: Vec<ProjectGraphEdgePayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectGraphNodePayload {
    id: Uuid,
    imported_sentry_project_id: Option<Uuid>,
    node_key: String,
    node_type: String,
    label: String,
    description: Option<String>,
    position_x: f64,
    position_y: f64,
    metadata: JsonValue,
    is_system: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectGraphEdgePayload {
    id: Uuid,
    edge_key: String,
    edge_type: String,
    source_node_id: Uuid,
    target_node_id: Uuid,
    label: Option<String>,
    metadata: JsonValue,
    is_system: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHubRepoMappingPayload {
    repo_id: i64,
    full_name: String,
    url: String,
    default_branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHubRepositoryPayload {
    id: i64,
    full_name: String,
    html_url: String,
    default_branch: Option<String>,
    private: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateHotfixProjectInput {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignSentryOrganizationInput {
    connection_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRepoMappingInput {
    repo_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHotfixProjectInput {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSentryProjectSelectionInput {
    included_project_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProjectGraphLayoutInput {
    nodes: Vec<ProjectGraphNodeLayoutInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectGraphEdgeInput {
    source_node_id: Uuid,
    target_node_id: Uuid,
    label: String,
    interaction_type: Option<String>,
    transport: Option<String>,
    touchpoints: Option<String>,
    data_contract: Option<String>,
    context_not_in_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectGraphItemInput {
    name: String,
    description: Option<String>,
    github_repo_id: i64,
    base_directory: Option<String>,
    linked_imported_sentry_project_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectGraphNodeLayoutInput {
    id: Uuid,
    position_x: f64,
    position_y: f64,
}

#[derive(Debug, FromRow)]
struct HotfixProjectRow {
    id: Uuid,
    name: String,
    slug: String,
    created_at: OffsetDateTime,
    sentry_connection_id: Option<Uuid>,
    sentry_slug: Option<String>,
    sentry_name: Option<String>,
}

#[derive(Debug, FromRow)]
struct ImportedSentryProjectRow {
    id: Uuid,
    hotfix_project_id: Uuid,
    sentry_project_id: String,
    slug: String,
    name: String,
    platform: Option<String>,
    included: bool,
    errors_24h: i64,
    transactions_24h: i64,
    replays_24h: i64,
    profiles_24h: i64,
    sentry_repo_connected: bool,
    github_repo_id: Option<i64>,
    github_repo_full_name: Option<String>,
    github_repo_url: Option<String>,
    github_repo_default_branch: Option<String>,
}

#[derive(Debug, FromRow)]
struct ProjectGraphNodeRow {
    id: Uuid,
    imported_sentry_project_id: Option<Uuid>,
    node_key: String,
    node_type: String,
    label: String,
    description: Option<String>,
    position_x: f64,
    position_y: f64,
    github_repo_id: Option<i64>,
    github_repo_full_name: Option<String>,
    github_repo_url: Option<String>,
    github_repo_default_branch: Option<String>,
    base_directory: Option<String>,
    indexing_status: String,
    indexing_percentage: i32,
    linked_sentry_project_id: Option<String>,
    linked_sentry_project_slug: Option<String>,
    linked_sentry_project_name: Option<String>,
    linked_sentry_project_platform: Option<String>,
    linked_sentry_project_included: Option<bool>,
    linked_sentry_errors_24h: Option<i64>,
    linked_sentry_transactions_24h: Option<i64>,
    linked_sentry_replays_24h: Option<i64>,
    linked_sentry_profiles_24h: Option<i64>,
    linked_sentry_errors_24h_series: Option<SqlJson<Vec<i64>>>,
    linked_sentry_transactions_24h_series: Option<SqlJson<Vec<i64>>>,
    linked_sentry_repo_connected: Option<bool>,
    metadata: SqlJson<JsonValue>,
    is_system: bool,
}

#[derive(Debug, FromRow)]
struct ProjectGraphEdgeRow {
    id: Uuid,
    edge_key: String,
    edge_type: String,
    source_node_id: Uuid,
    target_node_id: Uuid,
    label: Option<String>,
    metadata: SqlJson<JsonValue>,
    is_system: bool,
}

#[derive(Debug, FromRow)]
struct BackfillImportedProjectRow {
    id: Uuid,
    sentry_project_id: String,
    slug: String,
    github_repo_id: Option<i64>,
    github_repo_full_name: Option<String>,
    github_repo_url: Option<String>,
}

#[derive(Debug, FromRow)]
struct HotfixIncidentRow {
    id: Uuid,
    incident_key: String,
    title: String,
    status: String,
    first_seen_at: Option<OffsetDateTime>,
    last_seen_at: Option<OffsetDateTime>,
    issue_count: i32,
    sentry_project_count: i32,
}

#[derive(Debug, FromRow)]
struct IncidentSentryIssueRow {
    incident_id: Uuid,
    snapshot_id: Uuid,
    sentry_issue_id: String,
    short_id: Option<String>,
    title: String,
    status: String,
    level: Option<String>,
    project_slug: String,
    project_name: String,
    permalink: Option<String>,
    event_count: i64,
    user_count: i64,
    first_seen_at: Option<OffsetDateTime>,
    last_seen_at: Option<OffsetDateTime>,
}

#[derive(Debug, FromRow)]
struct IncidentCodeRefRow {
    incident_id: Uuid,
    id: Uuid,
    github_repo_id: Option<i64>,
    github_repo_full_name: Option<String>,
    github_repo_url: Option<String>,
    path: String,
    start_line: Option<i32>,
    end_line: Option<i32>,
    symbol: Option<String>,
    confidence: f64,
    source: String,
}

#[derive(Debug, FromRow)]
struct SentryIssueSnapshotRow {
    id: Uuid,
    imported_sentry_project_id: Uuid,
    title: String,
    culprit: Option<String>,
    level: Option<String>,
    status: String,
    first_seen_at: Option<OffsetDateTime>,
    last_seen_at: Option<OffsetDateTime>,
}

#[derive(Debug, FromRow)]
struct SentryIssueCodeRefRow {
    sentry_issue_snapshot_id: Uuid,
    github_repo_id: Option<i64>,
    github_repo_full_name: Option<String>,
    github_repo_url: Option<String>,
    path: String,
    start_line: Option<i32>,
    end_line: Option<i32>,
    symbol: Option<String>,
    confidence: f64,
    source: String,
    metadata: SqlJson<JsonValue>,
}

#[derive(Debug, Deserialize)]
struct SentryOrganization {
    id: String,
    slug: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct SentryProjectResponse {
    #[serde(deserialize_with = "deserialize_string_from_string_or_number")]
    id: String,
    slug: String,
    name: String,
    platform: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SentryIssueResponse {
    #[serde(deserialize_with = "deserialize_string_from_string_or_number")]
    id: String,
    short_id: Option<String>,
    title: String,
    culprit: Option<String>,
    level: Option<String>,
    status: String,
    #[serde(
        default,
        deserialize_with = "deserialize_option_i64_from_string_or_number"
    )]
    count: Option<i64>,
    #[serde(
        default,
        deserialize_with = "deserialize_option_i64_from_string_or_number"
    )]
    user_count: Option<i64>,
    permalink: Option<String>,
    first_seen: Option<String>,
    last_seen: Option<String>,
    project: Option<SentryIssueProjectResponse>,
    #[serde(default)]
    metadata: JsonValue,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SentryIssueProjectResponse {
    #[serde(deserialize_with = "deserialize_string_from_string_or_number")]
    id: String,
    slug: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SentryIssueEventResponse {
    #[serde(rename = "eventID")]
    event_id: Option<String>,
    #[serde(rename = "dateCreated")]
    date_created: Option<String>,
    #[serde(default)]
    tags: Vec<SentryTagResponse>,
    #[serde(default)]
    entries: Vec<JsonValue>,
}

#[derive(Debug, Clone)]
struct IssueCodeRefCandidate {
    github_repo_id: Option<i64>,
    github_repo_full_name: Option<String>,
    github_repo_url: Option<String>,
    path: String,
    start_line: Option<i32>,
    end_line: Option<i32>,
    symbol: Option<String>,
    confidence: f64,
    source: String,
    metadata: JsonValue,
}

#[derive(Debug)]
struct BackfilledIssue {
    imported_sentry_project_id: Uuid,
    issue: SentryIssueResponse,
    exemplar_event_id: Option<String>,
    release_name: Option<String>,
    environment: Option<String>,
    trace_id: Option<String>,
    code_refs: Vec<IssueCodeRefCandidate>,
}

#[derive(Debug, Deserialize)]
struct SentryRepositoryResponse {
    name: String,
}

#[derive(Debug, Default, Clone)]
struct SentryProjectMetricsSnapshot {
    errors_24h: i64,
    transactions_24h: i64,
    replays_24h: i64,
    profiles_24h: i64,
    errors_24h_series: Vec<i64>,
    transactions_24h_series: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct SentryStatsSummaryResponse {
    projects: Vec<SentryStatsProjectResponse>,
}

#[derive(Debug, Deserialize)]
struct SentryStatsProjectResponse {
    id: String,
    stats: Vec<SentryStatsCategoryResponse>,
}

#[derive(Debug, Deserialize)]
struct SentryStatsCategoryResponse {
    category: String,
    totals: HashMap<String, i64>,
}

#[derive(Debug, Deserialize)]
struct SentryStatsV2Response {
    groups: Vec<SentryStatsV2GroupResponse>,
}

#[derive(Debug, Deserialize)]
struct SentryStatsV2GroupResponse {
    by: HashMap<String, String>,
    series: HashMap<String, Vec<i64>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedProjectActivityPayload {
    imported_project_id: Uuid,
    project_name: String,
    errors: Vec<ImportedProjectErrorLogPayload>,
    transactions: Vec<ImportedProjectTransactionLogPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedProjectErrorLogPayload {
    id: String,
    event_id: Option<String>,
    title: String,
    culprit: Option<String>,
    level: Option<String>,
    event_type: Option<String>,
    timestamp: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedProjectTransactionLogPayload {
    name: String,
    count: i64,
    avg_duration_ms: Option<f64>,
}

#[derive(Debug, FromRow)]
struct ImportedProjectActivityRow {
    name: String,
    slug: String,
    sentry_project_id: String,
    sentry_connection_id: Uuid,
    sentry_organization_slug: String,
}

#[derive(Debug, Deserialize)]
struct SentryErrorEventResponse {
    id: String,
    #[serde(rename = "eventID")]
    event_id: Option<String>,
    #[serde(rename = "dateCreated")]
    date_created: String,
    title: Option<String>,
    culprit: Option<String>,
    #[serde(default)]
    tags: Vec<SentryTagResponse>,
    #[serde(rename = "event.type")]
    event_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SentryTagResponse {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct SentryExploreTableResponse {
    data: Vec<HashMap<String, JsonValue>>,
}

#[derive(Debug, Deserialize)]
struct GitHubRepositoryResponse {
    id: i64,
    full_name: String,
    html_url: String,
    default_branch: Option<String>,
    private: bool,
}

#[derive(Debug, Deserialize)]
struct GitHubTokenResponse {
    access_token: String,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubUserResponse {
    id: u64,
    login: String,
    name: Option<String>,
    email: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubEmail {
    email: String,
    primary: bool,
    verified: bool,
}

#[derive(Debug, Deserialize)]
struct SentryTokenResponse {
    access_token: String,
    user: SentryUser,
}

#[derive(Debug, Deserialize)]
struct SentryUser {
    id: String,
    name: Option<String>,
    email: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), AppError> {
    let _ = dotenv();
    init_tracing();

    let config = Arc::new(AppConfig::from_env()?);
    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await?;

    sqlx::migrate!()
        .run(&db)
        .await
        .map_err(|error| AppError::Config(format!("Database migration failed: {error}")))?;

    let session_store = PgSessionStore::new(db.clone());
    session_store.migrate().await?;

    let session_layer = SessionManagerLayer::new(session_store)
        .with_name(SESSION_COOKIE_NAME)
        .with_secure(config.public_url.scheme() == "https")
        .with_same_site(SameSite::Lax)
        .with_http_only(true)
        .with_private(Key::derive_from(config.session_secret.as_slice()))
        .with_expiry(Expiry::OnInactivity(CookieDuration::hours(12)));

    let http = reqwest::Client::builder()
        .user_agent(USER_AGENT_VALUE)
        .build()?;
    let state = AppState {
        config: Arc::clone(&config),
        db,
        http,
    };

    let api = Router::new()
        .route("/health", get(health))
        .route("/session", get(get_session))
        .route("/dashboard", get(get_dashboard))
        .route("/github/repositories", get(list_github_repositories))
        .route("/hotfix-projects", post(create_hotfix_project))
        .route(
            "/hotfix-projects/{project_id}",
            patch(update_hotfix_project).delete(delete_hotfix_project),
        )
        .route(
            "/hotfix-projects/{project_id}/sentry-connection",
            post(assign_sentry_connection),
        )
        .route(
            "/hotfix-projects/{project_id}/sentry-project-selection",
            post(update_sentry_project_selection),
        )
        .route(
            "/hotfix-projects/{project_id}/refresh-sentry-projects",
            post(refresh_sentry_projects),
        )
        .route(
            "/hotfix-projects/{project_id}/graph",
            get(get_project_graph),
        )
        .route(
            "/hotfix-projects/{project_id}/graph/items",
            post(create_project_graph_item),
        )
        .route(
            "/hotfix-projects/{project_id}/graph/edges",
            post(create_project_graph_edge),
        )
        .route(
            "/hotfix-projects/{project_id}/incidents",
            get(get_hotfix_project_incidents),
        )
        .route(
            "/hotfix-projects/{project_id}/backfill-incidents",
            post(backfill_hotfix_project_incidents),
        )
        .route(
            "/hotfix-projects/{project_id}/graph/layout",
            patch(update_project_graph_layout),
        )
        .route(
            "/imported-sentry-projects/{imported_project_id}/activity",
            get(get_imported_project_activity),
        )
        .route(
            "/imported-sentry-projects/{imported_project_id}/repo-mapping",
            post(update_repo_mapping),
        )
        .route("/auth/logout", post(logout))
        .route("/auth/{provider}/start", get(start_auth))
        .route("/auth/{provider}/callback", get(auth_callback))
        .with_state(state.clone());

    let app = if let Some(frontend_dist) = config.frontend_dist.as_ref() {
        let index_file = frontend_dist.join("index.html");
        Router::new()
            .nest("/api", api)
            .fallback_service(frontend_service(frontend_dist, &index_file))
            .layer(TraceLayer::new_for_http())
            .layer(session_layer)
    } else {
        Router::new()
            .nest("/api", api)
            .route("/", get(root_message))
            .layer(TraceLayer::new_for_http())
            .layer(session_layer)
    };

    let listener = tokio::net::TcpListener::bind(config.listen_addr)
        .await
        .map_err(|error| AppError::Config(format!("Could not bind server socket: {error}")))?;

    tracing::info!("hotfix backend listening on {}", config.listen_addr);
    axum::serve(listener, app)
        .await
        .map_err(|_| AppError::Internal)
}

#[derive(Serialize)]
struct HealthPayload {
    ok: bool,
}

async fn health() -> Json<HealthPayload> {
    Json(HealthPayload { ok: true })
}

async fn root_message() -> &'static str {
    "Hotfix backend is running. Build the frontend or run the Solid dev server for the UI."
}

async fn get_session(
    State(state): State<AppState>,
    session: Session,
) -> Result<Json<SessionPayload>, AppError> {
    let Some(user_id) = current_user_id(&session).await? else {
        return Ok(Json(SessionPayload::anonymous()));
    };

    let user = query_session_user_optional(&state.db, user_id).await?;

    match user {
        Some(user) => Ok(Json(SessionPayload {
            authenticated: true,
            user: Some(user),
        })),
        None => {
            session.flush().await?;
            Ok(Json(SessionPayload::anonymous()))
        }
    }
}

async fn logout(session: Session) -> Result<StatusCode, AppError> {
    session.flush().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_dashboard(
    State(state): State<AppState>,
    session: Session,
) -> Result<Json<DashboardPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    let payload = build_dashboard_payload(&state, user_id).await?;
    Ok(Json(payload))
}

async fn list_github_repositories(
    State(state): State<AppState>,
    session: Session,
) -> Result<Json<Vec<GitHubRepositoryPayload>>, AppError> {
    let user_id = require_user_id(&session).await?;
    let connection = load_provider_connection(&state.db, user_id, Provider::GitHub).await?;
    let access_token = decrypt_provider_token(
        &state.config.session_secret,
        &connection.access_token_nonce,
        &connection.access_token_ciphertext,
    )?;
    let repos = fetch_all_github_repositories(&state, &access_token).await?;
    Ok(Json(repos))
}

async fn create_hotfix_project(
    State(state): State<AppState>,
    session: Session,
    Json(input): Json<CreateHotfixProjectInput>,
) -> Result<Json<HotfixProjectPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    let name = input.name.trim();

    if name.is_empty() {
        return Err(AppError::BadRequest("Project name cannot be empty.".into()));
    }

    let project_id = Uuid::new_v4();
    let slug = generate_unique_project_slug(&state.db, name, None).await?;
    sqlx::query(
        r#"
        insert into hotfix_projects (id, user_id, name, slug)
        values ($1, $2, $3, $4)
        "#,
    )
    .bind(project_id)
    .bind(user_id)
    .bind(name)
    .bind(&slug)
    .execute(&state.db)
    .await?;

    let payload = build_single_hotfix_project_payload(&state, user_id, project_id).await?;
    Ok(Json(payload))
}

async fn assign_sentry_connection(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
    Json(input): Json<AssignSentryOrganizationInput>,
) -> Result<Json<HotfixProjectPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    let mut tx = state.db.begin().await?;
    let connection =
        load_provider_connection_with_executor(&mut tx, user_id, input.connection_id).await?;
    if connection.provider != Provider::Sentry.as_str() {
        return Err(AppError::BadRequest(
            "That connection is not a Sentry organization.".into(),
        ));
    }

    sqlx::query(
        r#"
        update hotfix_projects
        set sentry_connection_id = $1, updated_at = now()
        where id = $2 and user_id = $3
        "#,
    )
    .bind(connection.id)
    .bind(project_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    let access_token = decrypt_provider_token(
        &state.config.session_secret,
        &connection.access_token_nonce,
        &connection.access_token_ciphertext,
    )?;
    let slug = connection.slug.as_deref().ok_or_else(|| {
        AppError::BadRequest("The Sentry connection is missing an organization slug.".into())
    })?;
    let sentry_projects = fetch_all_sentry_projects(&state, &access_token, slug).await?;
    let sentry_metrics =
        fetch_sentry_project_metrics(&state, &access_token, slug, &sentry_projects).await?;
    let sentry_repositories =
        fetch_sentry_organization_repositories(&state, &access_token, slug).await?;

    sync_imported_sentry_projects(
        &mut tx,
        project_id,
        connection.id,
        &sentry_projects,
        &sentry_metrics,
        &sentry_repositories,
    )
    .await?;
    sync_hotfix_project_graph(&mut tx, project_id).await?;
    clear_hotfix_incident_data(&mut tx, project_id).await?;
    tx.commit().await?;

    let payload = build_single_hotfix_project_payload(&state, user_id, project_id).await?;
    Ok(Json(payload))
}

async fn update_hotfix_project(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
    Json(input): Json<UpdateHotfixProjectInput>,
) -> Result<Json<HotfixProjectPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Project name cannot be empty.".into()));
    }
    let slug = generate_unique_project_slug(&state.db, name, Some(project_id)).await?;

    sqlx::query(
        r#"
        update hotfix_projects
        set name = $1, slug = $2, updated_at = now()
        where id = $3 and user_id = $4
        "#,
    )
    .bind(name)
    .bind(&slug)
    .bind(project_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    let payload = build_single_hotfix_project_payload(&state, user_id, project_id).await?;
    Ok(Json(payload))
}

async fn delete_hotfix_project(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
) -> Result<StatusCode, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    sqlx::query(
        r#"
        delete from hotfix_projects
        where id = $1 and user_id = $2
        "#,
    )
    .bind(project_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn update_sentry_project_selection(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
    Json(input): Json<UpdateSentryProjectSelectionInput>,
) -> Result<Json<HotfixProjectPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    let existing_ids = sqlx::query_scalar::<_, Uuid>(
        r#"
        select id
        from imported_sentry_projects
        where hotfix_project_id = $1
        "#,
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;

    let existing_set = existing_ids.iter().copied().collect::<HashSet<_>>();
    for project_id in &input.included_project_ids {
        if !existing_set.contains(project_id) {
            return Err(AppError::BadRequest(
                "One or more selected Sentry projects do not belong to this project.".into(),
            ));
        }
    }

    let mut tx = state.db.begin().await?;
    sqlx::query(
        r#"
        update imported_sentry_projects
        set included = false, updated_at = now()
        where hotfix_project_id = $1
        "#,
    )
    .bind(project_id)
    .execute(&mut *tx)
    .await?;

    if !input.included_project_ids.is_empty() {
        sqlx::query(
            r#"
            update imported_sentry_projects
            set included = true, updated_at = now()
            where hotfix_project_id = $1
              and id = any($2)
            "#,
        )
        .bind(project_id)
        .bind(&input.included_project_ids)
        .execute(&mut *tx)
        .await?;
    }

    sync_hotfix_project_graph(&mut tx, project_id).await?;
    clear_hotfix_incident_data(&mut tx, project_id).await?;
    tx.commit().await?;

    let payload = build_single_hotfix_project_payload(&state, user_id, project_id).await?;
    Ok(Json(payload))
}

async fn refresh_sentry_projects(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
) -> Result<Json<HotfixProjectPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    let sentry_connection_id = sqlx::query_scalar::<_, Option<Uuid>>(
        r#"
        select sentry_connection_id
        from hotfix_projects
        where id = $1 and user_id = $2
        "#,
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .flatten()
    .ok_or_else(|| {
        AppError::BadRequest(
            "Connect a Sentry organization before refreshing imported projects.".into(),
        )
    })?;

    let mut tx = state.db.begin().await?;
    let connection =
        load_provider_connection_with_executor(&mut tx, user_id, sentry_connection_id).await?;
    if connection.provider != Provider::Sentry.as_str() {
        return Err(AppError::BadRequest(
            "That connection is not a Sentry organization.".into(),
        ));
    }

    let access_token = decrypt_provider_token(
        &state.config.session_secret,
        &connection.access_token_nonce,
        &connection.access_token_ciphertext,
    )?;
    let organization_slug = connection.slug.as_deref().ok_or_else(|| {
        AppError::BadRequest("The Sentry connection is missing an organization slug.".into())
    })?;
    let sentry_projects =
        fetch_all_sentry_projects(&state, &access_token, organization_slug).await?;
    let sentry_metrics =
        fetch_sentry_project_metrics(&state, &access_token, organization_slug, &sentry_projects)
            .await?;
    let sentry_repositories =
        fetch_sentry_organization_repositories(&state, &access_token, organization_slug).await?;

    sync_imported_sentry_projects(
        &mut tx,
        project_id,
        connection.id,
        &sentry_projects,
        &sentry_metrics,
        &sentry_repositories,
    )
    .await?;
    sync_hotfix_project_graph(&mut tx, project_id).await?;
    clear_hotfix_incident_data(&mut tx, project_id).await?;
    tx.commit().await?;

    let payload = build_single_hotfix_project_payload(&state, user_id, project_id).await?;
    Ok(Json(payload))
}

async fn get_project_graph(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
) -> Result<Json<ProjectGraphPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;
    let mut tx = state.db.begin().await?;
    sync_hotfix_project_graph(&mut tx, project_id).await?;
    tx.commit().await?;
    let payload = build_project_graph_payload(&state.db, project_id).await?;
    Ok(Json(payload))
}

async fn create_project_graph_item(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
    Json(input): Json<CreateProjectGraphItemInput>,
) -> Result<Json<ProjectGraphPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Item name cannot be empty.".into()));
    }

    let description = input
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let base_directory = input
        .base_directory
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let github_connection = load_provider_connection(&state.db, user_id, Provider::GitHub).await?;
    let github_access_token = decrypt_provider_token(
        &state.config.session_secret,
        &github_connection.access_token_nonce,
        &github_connection.access_token_ciphertext,
    )?;
    let github_repositories = fetch_all_github_repositories(&state, &github_access_token).await?;
    let github_repo = github_repositories
        .into_iter()
        .find(|repo| repo.id == input.github_repo_id)
        .ok_or_else(|| {
            AppError::BadRequest("Select a GitHub repository connected to this account.".into())
        })?;

    if let Some(imported_project_id) = input.linked_imported_sentry_project_id {
        let owner_project_id =
            load_imported_project_owner(&state.db, user_id, imported_project_id).await?;
        if owner_project_id != project_id {
            return Err(AppError::BadRequest(
                "The selected Sentry project does not belong to this Hotfix project.".into(),
            ));
        }
    }

    let existing_count = sqlx::query_scalar::<_, i64>(
        r#"
        select count(*)
        from hotfix_project_graph_nodes
        where hotfix_project_id = $1 and is_system = false
        "#,
    )
    .bind(project_id)
    .fetch_one(&state.db)
    .await? as usize;
    let (position_x, position_y) =
        default_system_project_graph_position(existing_count, existing_count.saturating_add(1));

    let node_id = Uuid::new_v4();
    let node_key = format!("project-item:{node_id}");

    sqlx::query(
        r#"
        insert into hotfix_project_graph_nodes (
            id,
            hotfix_project_id,
            imported_sentry_project_id,
            linked_imported_sentry_project_id,
            node_key,
            node_type,
            label,
            description,
            position_x,
            position_y,
            github_repo_id,
            github_repo_full_name,
            github_repo_url,
            github_repo_default_branch,
            base_directory,
            indexing_status,
            indexing_percentage,
            metadata,
            is_system
        )
        values (
            $1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending', 0, '{}'::jsonb, false
        )
        "#,
    )
    .bind(node_id)
    .bind(project_id)
    .bind(input.linked_imported_sentry_project_id)
    .bind(&node_key)
    .bind("project-item")
    .bind(name)
    .bind(description)
    .bind(position_x)
    .bind(position_y)
    .bind(github_repo.id)
    .bind(&github_repo.full_name)
    .bind(&github_repo.html_url)
    .bind(&github_repo.default_branch)
    .bind(base_directory)
    .execute(&state.db)
    .await?;

    let payload = build_project_graph_payload(&state.db, project_id).await?;
    Ok(Json(payload))
}

async fn get_hotfix_project_incidents(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
) -> Result<Json<Vec<HotfixIncidentPayload>>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;
    let payload = build_hotfix_incident_payloads(&state.db, project_id).await?;
    Ok(Json(payload))
}

async fn backfill_hotfix_project_incidents(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
) -> Result<Json<Vec<HotfixIncidentPayload>>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    let (sentry_connection_id, last_incident_backfill_at) =
        sqlx::query_as::<_, (Option<Uuid>, Option<OffsetDateTime>)>(
            r#"
        select sentry_connection_id, last_incident_backfill_at
        from hotfix_projects
        where id = $1 and user_id = $2
        "#,
        )
        .bind(project_id)
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    let sentry_connection_id = sentry_connection_id.ok_or_else(|| {
        AppError::BadRequest("Connect a Sentry organization before backfilling incidents.".into())
    })?;

    let imported_projects = sqlx::query_as::<_, BackfillImportedProjectRow>(
        r#"
        select
            imported_sentry_projects.id,
            imported_sentry_projects.sentry_project_id,
            imported_sentry_projects.slug,
            sentry_project_repo_mappings.github_repo_id,
            sentry_project_repo_mappings.github_repo_full_name,
            sentry_project_repo_mappings.github_repo_url
        from imported_sentry_projects
        left join sentry_project_repo_mappings
            on sentry_project_repo_mappings.imported_sentry_project_id = imported_sentry_projects.id
        where imported_sentry_projects.hotfix_project_id = $1
          and imported_sentry_projects.included = true
        order by imported_sentry_projects.name asc
        "#,
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;

    if imported_projects.is_empty() {
        let mut tx = state.db.begin().await?;
        clear_hotfix_incident_data(&mut tx, project_id).await?;
        tx.commit().await?;
        return Ok(Json(Vec::new()));
    }

    let mut tx = state.db.begin().await?;
    let connection =
        load_provider_connection_with_executor(&mut tx, user_id, sentry_connection_id).await?;
    tx.commit().await?;

    if !has_scope(connection.scopes.as_deref(), "event:read") {
        return Err(AppError::BadRequest(
            "Reconnect Sentry to grant Hotfix access to issues and events, then run the backfill again."
                .into(),
        ));
    }

    let organization_slug = connection.slug.clone().ok_or_else(|| {
        AppError::BadRequest("The Sentry connection is missing an organization slug.".into())
    })?;
    let access_token = decrypt_provider_token(
        &state.config.session_secret,
        &connection.access_token_nonce,
        &connection.access_token_ciphertext,
    )?;

    let issues = fetch_sentry_organization_issues(
        &state,
        &access_token,
        &organization_slug,
        &imported_projects,
        last_incident_backfill_at,
    )
    .await?;
    let backfilled_issues = backfill_sentry_issue_snapshots(
        &state,
        &access_token,
        &organization_slug,
        &imported_projects,
        issues,
    )
    .await?;

    let mut tx = state.db.begin().await?;
    persist_backfilled_issues(
        &mut tx,
        project_id,
        &backfilled_issues,
        last_incident_backfill_at.is_none(),
    )
    .await?;
    rebuild_hotfix_incidents(&mut tx, project_id).await?;
    sqlx::query(
        r#"
        update hotfix_projects
        set last_incident_backfill_at = now(), updated_at = now()
        where id = $1
        "#,
    )
    .bind(project_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let payload = build_hotfix_incident_payloads(&state.db, project_id).await?;
    Ok(Json(payload))
}

async fn get_imported_project_activity(
    State(state): State<AppState>,
    session: Session,
    AxumPath(imported_project_id): AxumPath<Uuid>,
) -> Result<Json<ImportedProjectActivityPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    load_imported_project_owner(&state.db, user_id, imported_project_id).await?;

    let imported_project = sqlx::query_as::<_, ImportedProjectActivityRow>(
        r#"
        select
            imported_sentry_projects.name,
            imported_sentry_projects.slug,
            imported_sentry_projects.sentry_project_id,
            imported_sentry_projects.sentry_connection_id,
            provider_connections.slug as sentry_organization_slug
        from imported_sentry_projects
        join provider_connections
            on provider_connections.id = imported_sentry_projects.sentry_connection_id
        join hotfix_projects
            on hotfix_projects.id = imported_sentry_projects.hotfix_project_id
        where imported_sentry_projects.id = $1
          and hotfix_projects.user_id = $2
        "#,
    )
    .bind(imported_project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::NotFound("The requested Sentry project import was not found.".into())
    })?;

    let mut tx = state.db.begin().await?;
    let connection = load_provider_connection_with_executor(
        &mut tx,
        user_id,
        imported_project.sentry_connection_id,
    )
    .await?;
    tx.commit().await?;

    let access_token = decrypt_provider_token(
        &state.config.session_secret,
        &connection.access_token_nonce,
        &connection.access_token_ciphertext,
    )?;

    let errors = fetch_sentry_project_error_events(
        &state,
        &access_token,
        &imported_project.sentry_organization_slug,
        &imported_project.slug,
    )
    .await?;

    let transactions = match fetch_sentry_project_transaction_activity(
        &state,
        &access_token,
        &imported_project.sentry_organization_slug,
        &imported_project.sentry_project_id,
    )
    .await
    {
        Ok(items) => items,
        Err(error) => {
            warn!(?error, "sentry transaction activity lookup failed");
            Vec::new()
        }
    };

    Ok(Json(ImportedProjectActivityPayload {
        imported_project_id,
        project_name: imported_project.name,
        errors,
        transactions,
    }))
}

async fn update_project_graph_layout(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
    Json(input): Json<UpdateProjectGraphLayoutInput>,
) -> Result<StatusCode, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    if input.nodes.is_empty() {
        return Ok(StatusCode::NO_CONTENT);
    }

    let existing_ids = sqlx::query_scalar::<_, Uuid>(
        r#"
        select id
        from hotfix_project_graph_nodes
        where hotfix_project_id = $1
        "#,
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;

    let existing_set = existing_ids.into_iter().collect::<HashSet<_>>();
    for node in &input.nodes {
        if !existing_set.contains(&node.id) {
            return Err(AppError::BadRequest(
                "One or more graph nodes do not belong to this Hotfix project.".into(),
            ));
        }
    }

    let mut tx = state.db.begin().await?;
    for node in &input.nodes {
        sqlx::query(
            r#"
            update hotfix_project_graph_nodes
            set position_x = $1, position_y = $2, updated_at = now()
            where hotfix_project_id = $3 and id = $4
            "#,
        )
        .bind(node.position_x)
        .bind(node.position_y)
        .bind(project_id)
        .bind(node.id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_project_graph_edge(
    State(state): State<AppState>,
    session: Session,
    AxumPath(project_id): AxumPath<Uuid>,
    Json(input): Json<CreateProjectGraphEdgeInput>,
) -> Result<Json<ProjectGraphPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    ensure_hotfix_project_owner(&state.db, user_id, project_id).await?;

    if input.source_node_id == input.target_node_id {
        return Err(AppError::BadRequest(
            "Choose two different nodes to create a relationship.".into(),
        ));
    }

    let label = required_text_field(
        &input.label,
        "Describe how these projects interact before saving the edge.",
    )?;
    let interaction_type = optional_text_field(input.interaction_type.as_deref());
    let transport = optional_text_field(input.transport.as_deref());
    let touchpoints = optional_text_field(input.touchpoints.as_deref());
    let data_contract = optional_text_field(input.data_contract.as_deref());
    let context_not_in_code = optional_text_field(input.context_not_in_code.as_deref());

    let node_count = sqlx::query_scalar::<_, i64>(
        r#"
        select count(*)
        from hotfix_project_graph_nodes
        where hotfix_project_id = $1
          and id = any($2)
        "#,
    )
    .bind(project_id)
    .bind(vec![input.source_node_id, input.target_node_id])
    .fetch_one(&state.db)
    .await?;

    if node_count != 2 {
        return Err(AppError::BadRequest(
            "One or both graph nodes are no longer available on this project.".into(),
        ));
    }

    let edge_metadata = json!({
        "summary": label,
        "interactionType": interaction_type,
        "transport": transport,
        "touchpoints": touchpoints,
        "dataContract": data_contract,
        "contextNotInCode": context_not_in_code
    });

    let mut tx = state.db.begin().await?;
    let existing_edge_id = sqlx::query_scalar::<_, Option<Uuid>>(
        r#"
        select id
        from hotfix_project_graph_edges
        where hotfix_project_id = $1
          and source_node_id = $2
          and target_node_id = $3
          and edge_type = 'relationship'
          and is_system = false
        limit 1
        "#,
    )
    .bind(project_id)
    .bind(input.source_node_id)
    .bind(input.target_node_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();

    if let Some(edge_id) = existing_edge_id {
        sqlx::query(
            r#"
            update hotfix_project_graph_edges
            set label = $1, metadata = $2, updated_at = now()
            where id = $3 and hotfix_project_id = $4
            "#,
        )
        .bind(&label)
        .bind(SqlJson(edge_metadata))
        .bind(edge_id)
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            r#"
            insert into hotfix_project_graph_edges (
                id,
                hotfix_project_id,
                edge_key,
                edge_type,
                source_node_id,
                target_node_id,
                label,
                metadata,
                is_system
            )
            values ($1, $2, $3, 'relationship', $4, $5, $6, $7, false)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(project_id)
        .bind(format!("relationship:{}", Uuid::new_v4()))
        .bind(input.source_node_id)
        .bind(input.target_node_id)
        .bind(&label)
        .bind(SqlJson(edge_metadata))
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    let payload = build_project_graph_payload(&state.db, project_id).await?;
    Ok(Json(payload))
}

async fn update_repo_mapping(
    State(state): State<AppState>,
    session: Session,
    AxumPath(imported_project_id): AxumPath<Uuid>,
    Json(input): Json<UpdateRepoMappingInput>,
) -> Result<Json<HotfixProjectPayload>, AppError> {
    let user_id = require_user_id(&session).await?;
    let owner_project_id =
        load_imported_project_owner(&state.db, user_id, imported_project_id).await?;

    let selected_repo = if let Some(repo_id) = input.repo_id {
        let connection = load_provider_connection(&state.db, user_id, Provider::GitHub).await?;
        let access_token = decrypt_provider_token(
            &state.config.session_secret,
            &connection.access_token_nonce,
            &connection.access_token_ciphertext,
        )?;
        let repo = fetch_all_github_repositories(&state, &access_token)
            .await?
            .into_iter()
            .find(|repo| repo.id == repo_id)
            .ok_or_else(|| {
                AppError::BadRequest(
                    "That GitHub repository is not accessible through the connected account."
                        .into(),
                )
            })?;
        Some(repo)
    } else {
        None
    };

    let mut tx = state.db.begin().await?;
    if let Some(repo) = selected_repo {
        let repo_full_name = repo.full_name.clone();
        sqlx::query(
            r#"
            insert into sentry_project_repo_mappings (
                id,
                imported_sentry_project_id,
                github_repo_id,
                github_repo_full_name,
                github_repo_url,
                github_repo_default_branch
            )
            values ($1, $2, $3, $4, $5, $6)
            on conflict (imported_sentry_project_id) do update
            set
                github_repo_id = excluded.github_repo_id,
                github_repo_full_name = excluded.github_repo_full_name,
                github_repo_url = excluded.github_repo_url,
                github_repo_default_branch = excluded.github_repo_default_branch,
                updated_at = now()
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(imported_project_id)
        .bind(repo.id)
        .bind(&repo_full_name)
        .bind(repo.html_url)
        .bind(repo.default_branch.as_deref())
        .execute(&mut *tx)
        .await?;

        let sentry_connection = sqlx::query_as::<_, (Option<Uuid>, Option<String>)>(
            r#"
            select hotfix_projects.sentry_connection_id, provider_connections.slug
            from imported_sentry_projects
            join hotfix_projects on hotfix_projects.id = imported_sentry_projects.hotfix_project_id
            left join provider_connections on provider_connections.id = hotfix_projects.sentry_connection_id
            where imported_sentry_projects.id = $1
            "#,
        )
        .bind(imported_project_id)
        .fetch_one(&mut *tx)
        .await?;

        let sentry_repo_connected = match sentry_connection {
            (Some(connection_id), Some(slug)) => {
                let connection =
                    load_provider_connection_with_executor(&mut tx, user_id, connection_id).await?;
                let access_token = decrypt_provider_token(
                    &state.config.session_secret,
                    &connection.access_token_nonce,
                    &connection.access_token_ciphertext,
                )?;
                let repos =
                    fetch_sentry_organization_repositories(&state, &access_token, &slug).await?;
                repos.contains(&repo_full_name.to_lowercase())
            }
            _ => false,
        };

        sqlx::query(
            r#"
            update imported_sentry_projects
            set sentry_repo_connected = $1, updated_at = now()
            where id = $2
            "#,
        )
        .bind(sentry_repo_connected)
        .bind(imported_project_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            r#"
            delete from sentry_project_repo_mappings
            where imported_sentry_project_id = $1
            "#,
        )
        .bind(imported_project_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            update imported_sentry_projects
            set sentry_repo_connected = false, updated_at = now()
            where id = $1
            "#,
        )
        .bind(imported_project_id)
        .execute(&mut *tx)
        .await?;
    }

    sync_hotfix_project_graph(&mut tx, owner_project_id).await?;
    tx.commit().await?;
    let payload = build_single_hotfix_project_payload(&state, user_id, owner_project_id).await?;
    Ok(Json(payload))
}

async fn start_auth(
    State(state): State<AppState>,
    AxumPath(provider_slug): AxumPath<String>,
    session: Session,
) -> Response {
    match start_auth_inner(&state, Provider::from_slug(&provider_slug), session).await {
        Ok(redirect) => redirect.into_response(),
        Err(error) => {
            auth_error_redirect(&state.config.public_url, error.client_message()).into_response()
        }
    }
}

async fn start_auth_inner(
    state: &AppState,
    provider: Result<Provider, AppError>,
    session: Session,
) -> Result<Redirect, AppError> {
    let provider = provider?;
    let link_user_id = session.get::<Uuid>(SESSION_USER_ID_KEY).await?;
    let flow = OAuthFlow::new(provider, link_user_id);

    session.cycle_id().await?;
    session.insert(OAUTH_FLOW_KEY, flow.clone()).await?;

    let authorization_url = build_authorization_url(&state.config, &flow)?;
    Ok(Redirect::to(authorization_url.as_str()))
}

async fn auth_callback(
    State(state): State<AppState>,
    AxumPath(provider_slug): AxumPath<String>,
    Query(query): Query<OAuthCallbackQuery>,
    session: Session,
) -> Response {
    let provider = Provider::from_slug(&provider_slug);

    let response = async {
        let provider = provider?;
        let Some(code) = query.code.as_deref() else {
            if let Some(error) = query.error.as_deref() {
                let description = query.error_description.as_deref().unwrap_or(error);
                return Err(AppError::Auth(format!(
                    "Login was cancelled or rejected: {description}"
                )));
            }
            return Err(AppError::BadRequest(
                "The provider did not return an authorization code.".into(),
            ));
        };

        let Some(returned_state) = query.state.as_deref() else {
            return Err(AppError::BadRequest(
                "The provider did not return a valid state token.".into(),
            ));
        };

        let flow = session
            .get::<OAuthFlow>(OAUTH_FLOW_KEY)
            .await?
            .ok_or_else(|| AppError::Auth("Your login session expired. Start over.".into()))?;

        session.remove::<OAuthFlow>(OAUTH_FLOW_KEY).await?;

        if flow.provider != provider {
            return Err(AppError::Auth(
                "The login provider did not match the session.".into(),
            ));
        }
        if flow.state != returned_state {
            return Err(AppError::Auth(
                "The login request could not be verified.".into(),
            ));
        }
        if !flow.is_fresh() {
            return Err(AppError::Auth(
                "Your login session expired. Start over.".into(),
            ));
        }

        let profile =
            exchange_code_for_profile(&state, provider, code, &flow.code_verifier).await?;
        let user = upsert_user(&state, profile, flow.link_user_id).await?;

        session.cycle_id().await?;
        session.insert(SESSION_USER_ID_KEY, user.id).await?;

        Ok::<Redirect, AppError>(Redirect::to(state.config.public_url.as_str()))
    }
    .await;

    match response {
        Ok(redirect) => redirect.into_response(),
        Err(error) => {
            auth_error_redirect(&state.config.public_url, error.client_message()).into_response()
        }
    }
}

async fn exchange_code_for_profile(
    state: &AppState,
    provider: Provider,
    code: &str,
    code_verifier: &str,
) -> Result<ExternalProfile, AppError> {
    match provider {
        Provider::GitHub => fetch_github_profile(state, code, code_verifier).await,
        Provider::Sentry => fetch_sentry_profile(state, code, code_verifier).await,
    }
}

async fn fetch_github_profile(
    state: &AppState,
    code: &str,
    code_verifier: &str,
) -> Result<ExternalProfile, AppError> {
    let redirect_uri = callback_url(&state.config, Provider::GitHub)?;
    let token_response = state
        .http
        .post(Provider::GitHub.token_url())
        .header(ACCEPT, "application/json")
        .form(&[
            ("client_id", state.config.github_client_id.as_str()),
            ("client_secret", state.config.github_client_secret.as_str()),
            ("code", code),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await?;

    if !token_response.status().is_success() {
        let body = token_response.text().await.unwrap_or_default();
        warn!(body, "github token exchange failed");
        return Err(AppError::Auth(
            "GitHub login failed. Please try again.".into(),
        ));
    }

    let token = token_response.json::<GitHubTokenResponse>().await?;

    let user_response = state
        .http
        .get("https://api.github.com/user")
        .header(ACCEPT, "application/vnd.github+json")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .bearer_auth(&token.access_token)
        .send()
        .await?;

    if !user_response.status().is_success() {
        let body = user_response.text().await.unwrap_or_default();
        warn!(body, "github user lookup failed");
        return Err(AppError::Auth(
            "Could not verify the GitHub account.".into(),
        ));
    }

    let user = user_response.json::<GitHubUserResponse>().await?;

    let email = match user.email.clone() {
        Some(email) => Some(email),
        None => {
            let emails_response = state
                .http
                .get("https://api.github.com/user/emails")
                .header(ACCEPT, "application/vnd.github+json")
                .header(USER_AGENT, USER_AGENT_VALUE)
                .bearer_auth(&token.access_token)
                .send()
                .await?;

            if emails_response.status().is_success() {
                let emails = emails_response.json::<Vec<GitHubEmail>>().await?;
                select_github_email(&emails)
            } else {
                None
            }
        }
    };

    let display_name = user
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| user.login.clone());

    Ok(ExternalProfile {
        provider: Provider::GitHub,
        provider_user_id: user.id.to_string(),
        username: Some(user.login.clone()),
        display_name,
        email,
        avatar_url: user.avatar_url,
        connection: ProviderConnectionSeed {
            external_id: user.id.to_string(),
            slug: Some(user.login.clone()),
            display_name: user.login,
            scopes: token.scope,
            access_token: token.access_token,
        },
    })
}

async fn fetch_sentry_profile(
    state: &AppState,
    code: &str,
    code_verifier: &str,
) -> Result<ExternalProfile, AppError> {
    let redirect_uri = callback_url(&state.config, Provider::Sentry)?;
    let token_response = state
        .http
        .post(Provider::Sentry.token_url())
        .form(&[
            ("client_id", state.config.sentry_client_id.as_str()),
            ("client_secret", state.config.sentry_client_secret.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await?;

    if !token_response.status().is_success() {
        let body = token_response.text().await.unwrap_or_default();
        warn!(body, "sentry token exchange failed");
        return Err(AppError::Auth(
            "Sentry login failed. Please try again.".into(),
        ));
    }

    let token = token_response.json::<SentryTokenResponse>().await?;
    let organization = fetch_sentry_organization(state, &token.access_token).await?;
    let display_name = token
        .user
        .name
        .clone()
        .or_else(|| token.user.email.clone())
        .unwrap_or_else(|| "Sentry user".to_string());

    Ok(ExternalProfile {
        provider: Provider::Sentry,
        provider_user_id: token.user.id,
        username: None,
        display_name,
        email: token.user.email,
        avatar_url: None,
        connection: ProviderConnectionSeed {
            external_id: organization.id.clone(),
            slug: Some(organization.slug.clone()),
            display_name: organization.name,
            scopes: Some(Provider::Sentry.scope().to_string()),
            access_token: token.access_token,
        },
    })
}

async fn fetch_sentry_organization(
    state: &AppState,
    access_token: &str,
) -> Result<SentryOrganization, AppError> {
    let response = state
        .http
        .get("https://sentry.io/api/0/organizations/")
        .bearer_auth(access_token)
        .send()
        .await?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        warn!(body, "sentry organization lookup failed");
        return Err(AppError::Auth(
            "Could not load the authorized Sentry organization.".into(),
        ));
    }

    let organizations = response.json::<Vec<SentryOrganization>>().await?;
    organizations.into_iter().next().ok_or_else(|| {
        AppError::Auth("The authorized Sentry account did not expose an organization.".into())
    })
}

async fn upsert_user(
    state: &AppState,
    profile: ExternalProfile,
    preferred_user_id: Option<Uuid>,
) -> Result<SessionUser, AppError> {
    let mut tx = state.db.begin().await?;
    let normalized_email = profile.email.as_deref().and_then(normalize_email);

    let existing = sqlx::query_as::<_, IdentityLookup>(
        r#"
        select user_id
        from auth_identities
        where provider = $1 and provider_user_id = $2
        "#,
    )
    .bind(profile.provider.as_str())
    .bind(&profile.provider_user_id)
    .fetch_optional(&mut *tx)
    .await?;

    if let (Some(existing_identity), Some(link_user_id)) = (&existing, preferred_user_id)
        && existing_identity.user_id != link_user_id
    {
        return Err(AppError::Auth(
            "That provider account is already linked to another Hotfix user.".into(),
        ));
    }

    let linked_user = if existing.is_none() && preferred_user_id.is_none() {
        match normalized_email.as_deref() {
            Some(email) => {
                sqlx::query_as::<_, IdentityLookup>(
                    r#"
                    select id as user_id
                    from users
                    where lower(email) = $1
                    "#,
                )
                .bind(email)
                .fetch_optional(&mut *tx)
                .await?
            }
            None => None,
        }
    } else {
        None
    };

    let user_id = if let Some(link_user_id) = preferred_user_id {
        let exists = sqlx::query_scalar::<_, bool>(
            r#"
            select exists(select 1 from users where id = $1)
            "#,
        )
        .bind(link_user_id)
        .fetch_one(&mut *tx)
        .await?;

        if !exists {
            return Err(AppError::Auth(
                "The current Hotfix session could not be verified.".into(),
            ));
        }

        link_user_id
    } else if let Some(existing_user) = existing.or(linked_user) {
        existing_user.user_id
    } else {
        let user_id = Uuid::new_v4();
        sqlx::query(
            r#"
            insert into users (id, display_name, email)
            values ($1, $2, $3)
            "#,
        )
        .bind(user_id)
        .bind(&profile.display_name)
        .bind(&normalized_email)
        .execute(&mut *tx)
        .await?;

        user_id
    };

    sqlx::query(
        r#"
        update users
        set
            display_name = $1,
            email = coalesce($2, email),
            updated_at = now()
        where id = $3
        "#,
    )
    .bind(&profile.display_name)
    .bind(&normalized_email)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    let identity_update = sqlx::query(
        r#"
        update auth_identities
        set
            user_id = $1,
            username = $2,
            display_name = $3,
            email = coalesce($4, email),
            avatar_url = $5,
            updated_at = now(),
            last_login_at = now()
        where provider = $6 and provider_user_id = $7
        "#,
    )
    .bind(user_id)
    .bind(&profile.username)
    .bind(&profile.display_name)
    .bind(&normalized_email)
    .bind(&profile.avatar_url)
    .bind(profile.provider.as_str())
    .bind(&profile.provider_user_id)
    .execute(&mut *tx)
    .await?;

    if identity_update.rows_affected() == 0 {
        sqlx::query(
            r#"
            insert into auth_identities (
                id,
                user_id,
                provider,
                provider_user_id,
                username,
                display_name,
                email,
                avatar_url
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(profile.provider.as_str())
        .bind(&profile.provider_user_id)
        .bind(&profile.username)
        .bind(&profile.display_name)
        .bind(&normalized_email)
        .bind(&profile.avatar_url)
        .execute(&mut *tx)
        .await?;
    }

    upsert_provider_connection(
        &mut tx,
        user_id,
        profile.provider,
        &profile.connection,
        &state.config.session_secret,
    )
    .await?;

    let user = query_session_user(&mut tx, user_id).await?;
    tx.commit().await?;
    Ok(user)
}

fn build_authorization_url(config: &AppConfig, flow: &OAuthFlow) -> Result<Url, AppError> {
    let mut url = Url::parse(flow.provider.authorize_url())
        .map_err(|_| AppError::Config("Could not build the provider authorize URL.".into()))?;
    let redirect_uri = callback_url(config, flow.provider)?;
    let challenge = pkce_challenge(&flow.code_verifier);

    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", flow.provider.client_id(config));
        query.append_pair("response_type", "code");
        query.append_pair("redirect_uri", redirect_uri.as_str());
        query.append_pair("state", &flow.state);
        query.append_pair("code_challenge", &challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("scope", flow.provider.scope());

        if matches!(flow.provider, Provider::GitHub) {
            query.append_pair("prompt", "select_account");
        }
    }

    Ok(url)
}

fn callback_url(config: &AppConfig, provider: Provider) -> Result<Url, AppError> {
    config
        .public_url
        .join(provider.callback_path())
        .map_err(|_| AppError::Config("Could not build the OAuth callback URL.".into()))
}

fn auth_error_redirect(public_url: &Url, message: &str) -> Redirect {
    let mut destination = public_url.clone();
    destination
        .query_pairs_mut()
        .append_pair("auth_error", message);
    Redirect::to(destination.as_str())
}

fn frontend_service(frontend_dist: &Path, index_file: &Path) -> axum::routing::MethodRouter {
    axum::routing::get_service(
        ServeDir::new(frontend_dist).not_found_service(ServeFile::new(index_file)),
    )
}

async fn current_user_id(session: &Session) -> Result<Option<Uuid>, AppError> {
    session
        .get::<Uuid>(SESSION_USER_ID_KEY)
        .await
        .map_err(AppError::from)
}

async fn require_user_id(session: &Session) -> Result<Uuid, AppError> {
    current_user_id(session)
        .await?
        .ok_or_else(|| AppError::Auth("You need to sign in first.".into()))
}

async fn query_session_user_optional(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<SessionUser>, AppError> {
    let row = sqlx::query_as::<_, SessionUserRow>(
        r#"
        select
            users.id,
            users.display_name,
            users.email,
            (
                select auth_identities.avatar_url
                from auth_identities
                where auth_identities.user_id = users.id
                  and auth_identities.avatar_url is not null
                order by auth_identities.last_login_at desc, auth_identities.updated_at desc
                limit 1
            ) as avatar_url,
            exists(
                select 1
                from provider_connections
                where provider_connections.user_id = users.id
                  and provider_connections.provider = 'github'
            ) as github_connected,
            exists(
                select 1
                from provider_connections
                where provider_connections.user_id = users.id
                  and provider_connections.provider = 'sentry'
            ) as sentry_connected
        from users
        where users.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    Ok(row.map(Into::into))
}

async fn query_session_user(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> Result<SessionUser, AppError> {
    let row = sqlx::query_as::<_, SessionUserRow>(
        r#"
        select
            users.id,
            users.display_name,
            users.email,
            (
                select auth_identities.avatar_url
                from auth_identities
                where auth_identities.user_id = users.id
                  and auth_identities.avatar_url is not null
                order by auth_identities.last_login_at desc, auth_identities.updated_at desc
                limit 1
            ) as avatar_url,
            exists(
                select 1
                from provider_connections
                where provider_connections.user_id = users.id
                  and provider_connections.provider = 'github'
            ) as github_connected,
            exists(
                select 1
                from provider_connections
                where provider_connections.user_id = users.id
                  and provider_connections.provider = 'sentry'
            ) as sentry_connected
        from users
        where users.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut **executor)
    .await?;

    Ok(row.into())
}

async fn upsert_provider_connection(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    provider: Provider,
    seed: &ProviderConnectionSeed,
    secret: &[u8],
) -> Result<(), AppError> {
    let (nonce, ciphertext) = encrypt_provider_token(secret, &seed.access_token)?;

    sqlx::query(
        r#"
        insert into provider_connections (
            id,
            user_id,
            provider,
            external_id,
            slug,
            display_name,
            scopes,
            access_token_nonce,
            access_token_ciphertext
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (user_id, provider, external_id) do update
        set
            slug = excluded.slug,
            display_name = excluded.display_name,
            scopes = excluded.scopes,
            access_token_nonce = excluded.access_token_nonce,
            access_token_ciphertext = excluded.access_token_ciphertext,
            updated_at = now()
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(provider.as_str())
    .bind(&seed.external_id)
    .bind(&seed.slug)
    .bind(&seed.display_name)
    .bind(&seed.scopes)
    .bind(nonce)
    .bind(ciphertext)
    .execute(&mut **executor)
    .await?;

    Ok(())
}

async fn load_provider_connection(
    db: &PgPool,
    user_id: Uuid,
    provider: Provider,
) -> Result<ProviderConnectionRow, AppError> {
    sqlx::query_as::<_, ProviderConnectionRow>(
        r#"
        select
            id,
            user_id,
            provider,
            external_id,
            slug,
            display_name,
            scopes,
            access_token_nonce,
            access_token_ciphertext
        from provider_connections
        where user_id = $1 and provider = $2
        order by updated_at desc
        limit 1
        "#,
    )
    .bind(user_id)
    .bind(provider.as_str())
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::BadRequest(format!("{} is not connected.", provider.as_str())))
}

async fn load_provider_connection_with_executor(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<ProviderConnectionRow, AppError> {
    sqlx::query_as::<_, ProviderConnectionRow>(
        r#"
        select
            id,
            user_id,
            provider,
            external_id,
            slug,
            display_name,
            scopes,
            access_token_nonce,
            access_token_ciphertext
        from provider_connections
        where id = $1 and user_id = $2
        "#,
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_optional(&mut **executor)
    .await?
    .ok_or_else(|| AppError::NotFound("The requested provider connection was not found.".into()))
}

async fn build_dashboard_payload(
    state: &AppState,
    user_id: Uuid,
) -> Result<DashboardPayload, AppError> {
    let sentry_organizations = sqlx::query_as::<_, ProviderConnectionRow>(
        r#"
        select
            id,
            user_id,
            provider,
            external_id,
            slug,
            display_name,
            scopes,
            access_token_nonce,
            access_token_ciphertext
        from provider_connections
        where user_id = $1 and provider = 'sentry'
        order by display_name asc
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .filter_map(|connection| {
        connection.slug.map(|slug| SentryOrganizationSummary {
            connection_id: connection.id,
            slug,
            name: connection.display_name,
        })
    })
    .collect::<Vec<_>>();

    let project_rows = sqlx::query_as::<_, HotfixProjectRow>(
        r#"
        select
            hotfix_projects.id,
            hotfix_projects.name,
            hotfix_projects.slug,
            hotfix_projects.created_at,
            hotfix_projects.sentry_connection_id,
            provider_connections.slug as sentry_slug,
            provider_connections.display_name as sentry_name
        from hotfix_projects
        left join provider_connections
            on provider_connections.id = hotfix_projects.sentry_connection_id
        where hotfix_projects.user_id = $1
        order by hotfix_projects.created_at asc
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let project_ids = project_rows
        .iter()
        .map(|project| project.id)
        .collect::<Vec<_>>();
    let imported_rows = if project_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, ImportedSentryProjectRow>(
            r#"
            select
                imported_sentry_projects.id,
                imported_sentry_projects.hotfix_project_id,
                imported_sentry_projects.sentry_project_id,
                imported_sentry_projects.slug,
                imported_sentry_projects.name,
                imported_sentry_projects.platform,
                imported_sentry_projects.included,
                imported_sentry_projects.errors_24h,
                imported_sentry_projects.transactions_24h,
                imported_sentry_projects.replays_24h,
                imported_sentry_projects.profiles_24h,
                imported_sentry_projects.sentry_repo_connected,
                sentry_project_repo_mappings.github_repo_id,
                sentry_project_repo_mappings.github_repo_full_name,
                sentry_project_repo_mappings.github_repo_url,
                sentry_project_repo_mappings.github_repo_default_branch
            from imported_sentry_projects
            left join sentry_project_repo_mappings
                on sentry_project_repo_mappings.imported_sentry_project_id = imported_sentry_projects.id
            where imported_sentry_projects.hotfix_project_id = any($1)
            order by imported_sentry_projects.name asc
            "#,
        )
        .bind(&project_ids)
        .fetch_all(&state.db)
        .await?
    };

    let projects = project_rows
        .into_iter()
        .map(|project| {
            let sentry_organization = match (
                project.sentry_connection_id,
                project.sentry_slug,
                project.sentry_name,
            ) {
                (Some(connection_id), Some(slug), Some(name)) => Some(SentryOrganizationSummary {
                    connection_id,
                    slug,
                    name,
                }),
                _ => None,
            };

            let sentry_projects = imported_rows
                .iter()
                .filter(|row| row.hotfix_project_id == project.id)
                .map(|row| ImportedSentryProjectPayload {
                    id: row.id,
                    sentry_project_id: row.sentry_project_id.clone(),
                    slug: row.slug.clone(),
                    name: row.name.clone(),
                    platform: row.platform.clone(),
                    included: row.included,
                    errors_24h: row.errors_24h,
                    transactions_24h: row.transactions_24h,
                    replays_24h: row.replays_24h,
                    profiles_24h: row.profiles_24h,
                    sentry_repo_connected: row.sentry_repo_connected,
                    hotfix_repo_connected: row.github_repo_id.is_some(),
                    repo_mapping: row.github_repo_id.map(|repo_id| GitHubRepoMappingPayload {
                        repo_id,
                        full_name: row.github_repo_full_name.clone().unwrap_or_default(),
                        url: row.github_repo_url.clone().unwrap_or_default(),
                        default_branch: row.github_repo_default_branch.clone(),
                    }),
                })
                .collect::<Vec<_>>();

            HotfixProjectPayload {
                id: project.id,
                name: project.name,
                slug: project.slug,
                created_at: (project.created_at.unix_timestamp_nanos() / 1_000_000) as i64,
                sentry_organization,
                sentry_projects,
            }
        })
        .collect();

    Ok(DashboardPayload {
        sentry_organizations,
        projects,
    })
}

async fn build_single_hotfix_project_payload(
    state: &AppState,
    user_id: Uuid,
    project_id: Uuid,
) -> Result<HotfixProjectPayload, AppError> {
    let dashboard = build_dashboard_payload(state, user_id).await?;
    dashboard
        .projects
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| AppError::NotFound("The requested Hotfix project was not found.".into()))
}

async fn build_project_graph_payload(
    db: &PgPool,
    project_id: Uuid,
) -> Result<ProjectGraphPayload, AppError> {
    let (_, project_slug) = sqlx::query_as::<_, (Uuid, String)>(
        r#"
        select id, slug
        from hotfix_projects
        where id = $1
        "#,
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("The requested Hotfix project was not found.".into()))?;

    let node_rows = sqlx::query_as::<_, ProjectGraphNodeRow>(
        r#"
        select
            hotfix_project_graph_nodes.id,
            coalesce(
                hotfix_project_graph_nodes.linked_imported_sentry_project_id,
                hotfix_project_graph_nodes.imported_sentry_project_id
            ) as imported_sentry_project_id,
            hotfix_project_graph_nodes.node_key,
            hotfix_project_graph_nodes.node_type,
            hotfix_project_graph_nodes.label,
            hotfix_project_graph_nodes.description,
            hotfix_project_graph_nodes.position_x,
            hotfix_project_graph_nodes.position_y,
            hotfix_project_graph_nodes.github_repo_id,
            hotfix_project_graph_nodes.github_repo_full_name,
            hotfix_project_graph_nodes.github_repo_url,
            hotfix_project_graph_nodes.github_repo_default_branch,
            hotfix_project_graph_nodes.base_directory,
            hotfix_project_graph_nodes.indexing_status,
            hotfix_project_graph_nodes.indexing_percentage,
            imported_sentry_projects.sentry_project_id as linked_sentry_project_id,
            imported_sentry_projects.slug as linked_sentry_project_slug,
            imported_sentry_projects.name as linked_sentry_project_name,
            imported_sentry_projects.platform as linked_sentry_project_platform,
            imported_sentry_projects.included as linked_sentry_project_included,
            imported_sentry_projects.errors_24h as linked_sentry_errors_24h,
            imported_sentry_projects.transactions_24h as linked_sentry_transactions_24h,
            imported_sentry_projects.replays_24h as linked_sentry_replays_24h,
            imported_sentry_projects.profiles_24h as linked_sentry_profiles_24h,
            imported_sentry_projects.errors_24h_series as linked_sentry_errors_24h_series,
            imported_sentry_projects.transactions_24h_series as linked_sentry_transactions_24h_series,
            imported_sentry_projects.sentry_repo_connected as linked_sentry_repo_connected,
            hotfix_project_graph_nodes.metadata,
            hotfix_project_graph_nodes.is_system
        from hotfix_project_graph_nodes
        left join imported_sentry_projects
            on imported_sentry_projects.id = coalesce(
                hotfix_project_graph_nodes.linked_imported_sentry_project_id,
                hotfix_project_graph_nodes.imported_sentry_project_id
            )
        where hotfix_project_graph_nodes.hotfix_project_id = $1
        order by hotfix_project_graph_nodes.created_at asc, hotfix_project_graph_nodes.label asc
        "#,
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let edge_rows = sqlx::query_as::<_, ProjectGraphEdgeRow>(
        r#"
        select
            id,
            edge_key,
            edge_type,
            source_node_id,
            target_node_id,
            label,
            metadata,
            is_system
        from hotfix_project_graph_edges
        where hotfix_project_id = $1
        order by edge_key asc
        "#,
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;

    Ok(ProjectGraphPayload {
        project_id,
        project_slug,
        nodes: node_rows
            .into_iter()
            .map(|row| {
                let mut metadata = row.metadata.0;
                if let Some(repo_id) = row.github_repo_id {
                    metadata["githubRepoId"] = json!(repo_id);
                }
                if let Some(repo_full_name) = row.github_repo_full_name.clone() {
                    metadata["githubRepoFullName"] = json!(repo_full_name);
                    metadata["hotfixRepoConnected"] = json!(true);
                } else {
                    metadata["hotfixRepoConnected"] = json!(false);
                }
                if let Some(repo_url) = row.github_repo_url.clone() {
                    metadata["githubRepoUrl"] = json!(repo_url);
                }
                if let Some(default_branch) = row.github_repo_default_branch.clone() {
                    metadata["githubRepoDefaultBranch"] = json!(default_branch);
                }
                if let Some(base_directory) = row.base_directory.clone() {
                    metadata["baseDirectory"] = json!(base_directory);
                }
                metadata["indexingStatus"] = json!(row.indexing_status);
                metadata["indexingPercentage"] = json!(row.indexing_percentage);

                if let Some(sentry_project_id) = row.linked_sentry_project_id.clone() {
                    metadata["sentryProjectId"] = json!(sentry_project_id);
                }
                if let Some(sentry_slug) = row.linked_sentry_project_slug.clone() {
                    metadata["slug"] = json!(sentry_slug);
                    metadata["linkedSentryProjectSlug"] = json!(sentry_slug);
                }
                if let Some(sentry_name) = row.linked_sentry_project_name.clone() {
                    metadata["linkedSentryProjectName"] = json!(sentry_name);
                }
                if let Some(platform) = row.linked_sentry_project_platform.clone() {
                    metadata["platform"] = json!(platform.clone());
                    metadata["linkedSentryProjectPlatform"] = json!(platform);
                }
                if let Some(included) = row.linked_sentry_project_included {
                    metadata["included"] = json!(included);
                }
                metadata["errors24h"] = json!(row.linked_sentry_errors_24h.unwrap_or(0));
                metadata["transactions24h"] =
                    json!(row.linked_sentry_transactions_24h.unwrap_or(0));
                metadata["replays24h"] = json!(row.linked_sentry_replays_24h.unwrap_or(0));
                metadata["profiles24h"] = json!(row.linked_sentry_profiles_24h.unwrap_or(0));
                metadata["errors24hSeries"] = json!(
                    row.linked_sentry_errors_24h_series
                        .map(|value| value.0)
                        .unwrap_or_default()
                );
                metadata["transactions24hSeries"] = json!(
                    row.linked_sentry_transactions_24h_series
                        .map(|value| value.0)
                        .unwrap_or_default()
                );
                metadata["sentryRepoConnected"] =
                    json!(row.linked_sentry_repo_connected.unwrap_or(false));

                ProjectGraphNodePayload {
                    id: row.id,
                    imported_sentry_project_id: row.imported_sentry_project_id,
                    node_key: row.node_key,
                    node_type: row.node_type,
                    label: row.label,
                    description: row.description,
                    position_x: row.position_x,
                    position_y: row.position_y,
                    metadata,
                    is_system: row.is_system,
                }
            })
            .collect(),
        edges: edge_rows
            .into_iter()
            .map(|row| ProjectGraphEdgePayload {
                id: row.id,
                edge_key: row.edge_key,
                edge_type: row.edge_type,
                source_node_id: row.source_node_id,
                target_node_id: row.target_node_id,
                label: row.label,
                metadata: row.metadata.0,
                is_system: row.is_system,
            })
            .collect(),
    })
}

async fn build_hotfix_incident_payloads(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<HotfixIncidentPayload>, AppError> {
    let incident_rows = sqlx::query_as::<_, HotfixIncidentRow>(
        r#"
        select
            id,
            incident_key,
            title,
            status,
            first_seen_at,
            last_seen_at,
            issue_count,
            sentry_project_count
        from hotfix_incidents
        where hotfix_project_id = $1
        order by last_seen_at desc nulls last, created_at desc
        "#,
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;

    if incident_rows.is_empty() {
        return Ok(Vec::new());
    }

    let incident_ids = incident_rows
        .iter()
        .map(|incident| incident.id)
        .collect::<Vec<_>>();

    let sentry_issue_rows = sqlx::query_as::<_, IncidentSentryIssueRow>(
        r#"
        select
            incident_sentry_issues.incident_id,
            sentry_issue_snapshots.id as snapshot_id,
            sentry_issue_snapshots.sentry_issue_id,
            sentry_issue_snapshots.short_id,
            sentry_issue_snapshots.title,
            sentry_issue_snapshots.status,
            sentry_issue_snapshots.level,
            imported_sentry_projects.slug as project_slug,
            imported_sentry_projects.name as project_name,
            sentry_issue_snapshots.permalink,
            sentry_issue_snapshots.event_count,
            sentry_issue_snapshots.user_count,
            sentry_issue_snapshots.first_seen_at,
            sentry_issue_snapshots.last_seen_at
        from incident_sentry_issues
        join sentry_issue_snapshots
            on sentry_issue_snapshots.id = incident_sentry_issues.sentry_issue_snapshot_id
        join imported_sentry_projects
            on imported_sentry_projects.id = sentry_issue_snapshots.imported_sentry_project_id
        where incident_sentry_issues.incident_id = any($1)
        order by sentry_issue_snapshots.last_seen_at desc nulls last, sentry_issue_snapshots.title asc
        "#,
    )
    .bind(&incident_ids)
    .fetch_all(db)
    .await?;

    let code_ref_rows = sqlx::query_as::<_, IncidentCodeRefRow>(
        r#"
        select
            incident_id,
            id,
            github_repo_id,
            github_repo_full_name,
            github_repo_url,
            path,
            start_line,
            end_line,
            symbol,
            confidence,
            source
        from incident_code_refs
        where incident_id = any($1)
        order by confidence desc, path asc, start_line asc nulls last
        "#,
    )
    .bind(&incident_ids)
    .fetch_all(db)
    .await?;

    let mut issues_by_incident = HashMap::<Uuid, Vec<IncidentSentryIssuePayload>>::new();
    for row in sentry_issue_rows {
        issues_by_incident
            .entry(row.incident_id)
            .or_default()
            .push(IncidentSentryIssuePayload {
                id: row.snapshot_id,
                sentry_issue_id: row.sentry_issue_id,
                short_id: row.short_id,
                title: row.title,
                status: row.status,
                level: row.level,
                project_slug: row.project_slug,
                project_name: row.project_name,
                permalink: row.permalink,
                event_count: row.event_count,
                user_count: row.user_count,
                first_seen_at: timestamp_millis(row.first_seen_at),
                last_seen_at: timestamp_millis(row.last_seen_at),
            });
    }

    let mut code_refs_by_incident = HashMap::<Uuid, Vec<IncidentCodeRefPayload>>::new();
    for row in code_ref_rows {
        code_refs_by_incident
            .entry(row.incident_id)
            .or_default()
            .push(IncidentCodeRefPayload {
                id: row.id,
                github_repo_id: row.github_repo_id,
                github_repo_full_name: row.github_repo_full_name,
                github_repo_url: row.github_repo_url,
                path: row.path,
                start_line: row.start_line,
                end_line: row.end_line,
                symbol: row.symbol,
                confidence: row.confidence,
                source: row.source,
            });
    }

    Ok(incident_rows
        .into_iter()
        .map(|row| HotfixIncidentPayload {
            id: row.id,
            incident_key: row.incident_key,
            title: row.title,
            status: row.status,
            first_seen_at: timestamp_millis(row.first_seen_at),
            last_seen_at: timestamp_millis(row.last_seen_at),
            issue_count: row.issue_count as i64,
            sentry_project_count: row.sentry_project_count as i64,
            sentry_issues: issues_by_incident.remove(&row.id).unwrap_or_default(),
            code_refs: code_refs_by_incident.remove(&row.id).unwrap_or_default(),
        })
        .collect())
}

async fn ensure_hotfix_project_owner(
    db: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
) -> Result<(), AppError> {
    let owns_project = sqlx::query_scalar::<_, bool>(
        r#"
        select exists(
            select 1
            from hotfix_projects
            where id = $1 and user_id = $2
        )
        "#,
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_one(db)
    .await?;

    if owns_project {
        Ok(())
    } else {
        Err(AppError::NotFound(
            "The requested Hotfix project was not found.".into(),
        ))
    }
}

async fn load_imported_project_owner(
    db: &PgPool,
    user_id: Uuid,
    imported_project_id: Uuid,
) -> Result<Uuid, AppError> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        select hotfix_projects.id
        from imported_sentry_projects
        join hotfix_projects on hotfix_projects.id = imported_sentry_projects.hotfix_project_id
        where imported_sentry_projects.id = $1 and hotfix_projects.user_id = $2
        "#,
    )
    .bind(imported_project_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("The requested Sentry project import was not found.".into()))
}

async fn fetch_all_github_repositories(
    state: &AppState,
    access_token: &str,
) -> Result<Vec<GitHubRepositoryPayload>, AppError> {
    let mut page = 1;
    let mut all_repos = Vec::new();

    loop {
        let mut url =
            Url::parse("https://api.github.com/user/repos").map_err(|_| AppError::Internal)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("per_page", "100");
            query.append_pair("page", &page.to_string());
            query.append_pair("sort", "updated");
            query.append_pair("affiliation", "owner,collaborator,organization_member");
        }

        let response = state
            .http
            .get(url)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            warn!(body, "github repository lookup failed");
            return Err(AppError::BadRequest(
                "GitHub repository access is unavailable. Reconnect GitHub.".into(),
            ));
        }

        let page_repos = response.json::<Vec<GitHubRepositoryResponse>>().await?;
        if page_repos.is_empty() {
            break;
        }

        all_repos.extend(page_repos.into_iter().map(|repo| GitHubRepositoryPayload {
            id: repo.id,
            full_name: repo.full_name,
            html_url: repo.html_url,
            default_branch: repo.default_branch,
            private: repo.private,
        }));

        page += 1;
    }

    Ok(all_repos)
}

async fn fetch_all_sentry_projects(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
) -> Result<Vec<SentryProjectResponse>, AppError> {
    let mut cursor: Option<String> = None;
    let mut projects = Vec::new();

    loop {
        let mut url = Url::parse(&format!(
            "https://sentry.io/api/0/organizations/{organization_slug}/projects/"
        ))
        .map_err(|_| AppError::Internal)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("per_page", "100");
            if let Some(next_cursor) = cursor.as_deref() {
                query.append_pair("cursor", next_cursor);
            }
        }

        let response = state.http.get(url).bearer_auth(access_token).send().await?;
        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            warn!(body, "sentry project import failed");
            return Err(AppError::BadRequest(
                "Could not import Sentry projects for the selected organization.".into(),
            ));
        }

        let next_cursor = parse_sentry_next_cursor(
            response
                .headers()
                .get("link")
                .and_then(|value| value.to_str().ok()),
        );
        let page_projects = response.json::<Vec<SentryProjectResponse>>().await?;
        projects.extend(page_projects);

        match next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    Ok(projects)
}

async fn fetch_sentry_organization_repositories(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
) -> Result<HashSet<String>, AppError> {
    let mut cursor: Option<String> = None;
    let mut repositories = HashSet::new();

    loop {
        let mut url = Url::parse(&format!(
            "https://sentry.io/api/0/organizations/{organization_slug}/repos/"
        ))
        .map_err(|_| AppError::Internal)?;
        if let Some(next_cursor) = cursor.as_deref() {
            url.query_pairs_mut().append_pair("cursor", next_cursor);
        }

        let response = state.http.get(url).bearer_auth(access_token).send().await?;
        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            warn!(body, "sentry repository lookup failed");
            return Err(AppError::BadRequest(
                "Could not load the organization repositories from Sentry.".into(),
            ));
        }

        let next_cursor = parse_sentry_next_cursor(
            response
                .headers()
                .get("link")
                .and_then(|value| value.to_str().ok()),
        );
        let page = response.json::<Vec<SentryRepositoryResponse>>().await?;
        repositories.extend(page.into_iter().map(|repo| repo.name.to_lowercase()));

        match next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    Ok(repositories)
}

async fn fetch_sentry_project_metrics(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
    projects: &[SentryProjectResponse],
) -> Result<HashMap<String, SentryProjectMetricsSnapshot>, AppError> {
    if projects.is_empty() {
        return Ok(HashMap::new());
    }

    let mut url = Url::parse(&format!(
        "https://sentry.io/api/0/organizations/{organization_slug}/stats-summary/"
    ))
    .map_err(|_| AppError::Internal)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("field", "sum(quantity)");
        query.append_pair("statsPeriod", "24h");
        query.append_pair("category", "error");
        query.append_pair("category", "transaction");

        for project in projects {
            query.append_pair("project", &project.id);
        }
    }

    let response = state.http.get(url).bearer_auth(access_token).send().await?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        warn!(body, "sentry project metrics lookup failed");
        return Err(AppError::BadRequest(
            "Could not load the 24h Sentry project metrics.".into(),
        ));
    }

    let summary = response.json::<SentryStatsSummaryResponse>().await?;
    let mut metrics = summary
        .projects
        .into_iter()
        .map(|project| {
            let mut snapshot = SentryProjectMetricsSnapshot::default();

            for stat in project.stats {
                let count = stat.totals.get("sum(quantity)").copied().unwrap_or(0);
                match stat.category.as_str() {
                    "error" => snapshot.errors_24h = count,
                    "transaction" => snapshot.transactions_24h = count,
                    "replay" | "replays" => snapshot.replays_24h = count,
                    "profile" | "profiles" => snapshot.profiles_24h = count,
                    _ => {}
                }
            }

            (project.id, snapshot)
        })
        .collect::<HashMap<_, _>>();

    for project in projects {
        let (errors_24h_series, transactions_24h_series) =
            fetch_sentry_project_metric_series(state, access_token, organization_slug, &project.id)
                .await?;
        let snapshot = metrics.entry(project.id.clone()).or_default();
        snapshot.errors_24h_series = errors_24h_series;
        snapshot.transactions_24h_series = transactions_24h_series;
    }

    Ok(metrics)
}

async fn fetch_sentry_project_metric_series(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
    sentry_project_id: &str,
) -> Result<(Vec<i64>, Vec<i64>), AppError> {
    let mut url = Url::parse(&format!(
        "https://sentry.io/api/0/organizations/{organization_slug}/stats_v2/"
    ))
    .map_err(|_| AppError::Internal)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("field", "sum(quantity)");
        query.append_pair("statsPeriod", "24h");
        query.append_pair("interval", "2h");
        query.append_pair("groupBy", "category");
        query.append_pair("category", "error");
        query.append_pair("category", "transaction");
        query.append_pair("project", sentry_project_id);
    }

    let response = state.http.get(url).bearer_auth(access_token).send().await?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        warn!(body, "sentry project metric series lookup failed");
        return Err(AppError::BadRequest(
            "Could not load the 24h Sentry project chart data.".into(),
        ));
    }

    let payload = response.json::<SentryStatsV2Response>().await?;
    let mut errors_24h_series = Vec::new();
    let mut transactions_24h_series = Vec::new();

    for group in payload.groups {
        let category = group.by.get("category").map(|value| value.as_str());
        let series = group
            .series
            .get("sum(quantity)")
            .cloned()
            .unwrap_or_default();

        match category {
            Some("error") => errors_24h_series = series,
            Some("transaction") => transactions_24h_series = series,
            _ => {}
        }
    }

    Ok((errors_24h_series, transactions_24h_series))
}

async fn fetch_sentry_project_error_events(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
    project_slug: &str,
) -> Result<Vec<ImportedProjectErrorLogPayload>, AppError> {
    let mut url = Url::parse(&format!(
        "https://sentry.io/api/0/projects/{organization_slug}/{project_slug}/events/"
    ))
    .map_err(|_| AppError::Internal)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("statsPeriod", "24h");
        query.append_pair("per_page", "40");
    }

    let response = state.http.get(url).bearer_auth(access_token).send().await?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        warn!(body, "sentry project event lookup failed");
        return Err(AppError::BadRequest(
            "Could not load recent Sentry events for this project.".into(),
        ));
    }

    let events = response.json::<Vec<SentryErrorEventResponse>>().await?;
    Ok(events
        .into_iter()
        .map(|event| ImportedProjectErrorLogPayload {
            id: event.id,
            event_id: event.event_id,
            title: event.title.unwrap_or_else(|| "Untitled event".to_string()),
            culprit: event.culprit,
            level: event
                .tags
                .iter()
                .find(|tag| tag.key == "level")
                .map(|tag| tag.value.clone()),
            event_type: event.event_type,
            timestamp: event.date_created,
        })
        .collect())
}

async fn fetch_sentry_project_transaction_activity(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
    sentry_project_id: &str,
) -> Result<Vec<ImportedProjectTransactionLogPayload>, AppError> {
    let mut url = Url::parse(&format!(
        "https://sentry.io/api/0/organizations/{organization_slug}/events/"
    ))
    .map_err(|_| AppError::Internal)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("dataset", "spans");
        query.append_pair("statsPeriod", "24h");
        query.append_pair("project", sentry_project_id);
        query.append_pair("per_page", "30");
        query.append_pair("sort", "-count()");
        query.append_pair("field", "transaction");
        query.append_pair("field", "count()");
        query.append_pair("field", "avg(span.duration)");
        query.append_pair("query", "transaction:*");
    }

    let response = state.http.get(url).bearer_auth(access_token).send().await?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        warn!(body, "sentry transaction activity lookup failed");
        return Err(AppError::BadRequest(
            "Could not load recent Sentry transaction activity for this project.".into(),
        ));
    }

    let payload = response.json::<SentryExploreTableResponse>().await?;
    Ok(payload
        .data
        .into_iter()
        .filter_map(|row| {
            let name = json_string(&row, "transaction")?;
            let count = json_i64(&row, "count()").unwrap_or(0);
            let avg_duration_ms = json_f64(&row, "avg(span.duration)");

            Some(ImportedProjectTransactionLogPayload {
                name,
                count,
                avg_duration_ms,
            })
        })
        .collect())
}

async fn fetch_sentry_organization_issues(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
    imported_projects: &[BackfillImportedProjectRow],
    since: Option<OffsetDateTime>,
) -> Result<Vec<SentryIssueResponse>, AppError> {
    let mut cursor: Option<String> = None;
    let mut issues = Vec::new();
    let start = since.map(incremental_issue_sync_start);

    loop {
        let mut url = Url::parse(&format!(
            "https://sentry.io/api/0/organizations/{organization_slug}/issues/"
        ))
        .map_err(|_| AppError::Internal)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("per_page", "100");
            query.append_pair("query", "is:unresolved");
            if let Some(start_at) = start.as_deref() {
                query.append_pair("start", start_at);
            } else {
                query.append_pair("statsPeriod", "14d");
            }
            if let Some(next_cursor) = cursor.as_deref() {
                query.append_pair("cursor", next_cursor);
            }
            for project in imported_projects {
                query.append_pair("project", &project.sentry_project_id);
            }
        }

        let response = state.http.get(url).bearer_auth(access_token).send().await?;
        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            warn!(body, "sentry issue list lookup failed");
            return Err(AppError::BadRequest(
                "Could not load Sentry issues. Reconnect Sentry with issue/event access.".into(),
            ));
        }

        let next_cursor = parse_sentry_next_cursor(
            response
                .headers()
                .get("link")
                .and_then(|value| value.to_str().ok()),
        );
        let page_issues = response.json::<Vec<SentryIssueResponse>>().await?;
        issues.extend(page_issues);

        match next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    Ok(issues)
}

async fn fetch_sentry_issue_exemplar_event(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
    sentry_issue_id: &str,
) -> Result<Option<SentryIssueEventResponse>, AppError> {
    let mut url = Url::parse(&format!(
        "https://sentry.io/api/0/organizations/{organization_slug}/issues/{sentry_issue_id}/events/"
    ))
    .map_err(|_| AppError::Internal)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("statsPeriod", "14d");
        query.append_pair("full", "true");
        query.append_pair("sample", "true");
        query.append_pair("per_page", "1");
    }

    let response = state.http.get(url).bearer_auth(access_token).send().await?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        warn!(body, "sentry issue exemplar lookup failed");
        return Err(AppError::BadRequest(
            "Could not load the issue exemplar event from Sentry.".into(),
        ));
    }

    let mut events = response.json::<Vec<SentryIssueEventResponse>>().await?;
    Ok(events.pop())
}

async fn backfill_sentry_issue_snapshots(
    state: &AppState,
    access_token: &str,
    organization_slug: &str,
    imported_projects: &[BackfillImportedProjectRow],
    issues: Vec<SentryIssueResponse>,
) -> Result<Vec<BackfilledIssue>, AppError> {
    let projects_by_id = imported_projects
        .iter()
        .map(|project| (project.sentry_project_id.as_str(), project))
        .collect::<HashMap<_, _>>();
    let projects_by_slug = imported_projects
        .iter()
        .map(|project| (project.slug.as_str(), project))
        .collect::<HashMap<_, _>>();

    let mut backfilled = Vec::new();

    for issue in issues {
        let Some(project_ref) = issue.project.as_ref() else {
            continue;
        };

        let Some(imported_project) = projects_by_id
            .get(project_ref.id.as_str())
            .or_else(|| projects_by_slug.get(project_ref.slug.as_str()))
            .copied()
        else {
            continue;
        };

        let exemplar_event =
            fetch_sentry_issue_exemplar_event(state, access_token, organization_slug, &issue.id)
                .await?;
        let code_refs = exemplar_event
            .as_ref()
            .map(|event| extract_code_refs_from_event(event, imported_project))
            .unwrap_or_default();

        backfilled.push(BackfilledIssue {
            imported_sentry_project_id: imported_project.id,
            exemplar_event_id: exemplar_event
                .as_ref()
                .and_then(|event| event.event_id.clone()),
            release_name: exemplar_event
                .as_ref()
                .and_then(|event| tag_value(&event.tags, "release")),
            environment: exemplar_event
                .as_ref()
                .and_then(|event| tag_value(&event.tags, "environment")),
            trace_id: exemplar_event
                .as_ref()
                .and_then(|event| tag_value(&event.tags, "trace")),
            issue,
            code_refs,
        });
    }

    Ok(backfilled)
}

async fn persist_backfilled_issues(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hotfix_project_id: Uuid,
    issues: &[BackfilledIssue],
    prune_missing: bool,
) -> Result<(), AppError> {
    if prune_missing {
        let seen_issue_keys = issues
            .iter()
            .map(|issue| (issue.imported_sentry_project_id, issue.issue.id.clone()))
            .collect::<HashSet<_>>();

        let existing_issue_rows = sqlx::query_as::<_, (Uuid, Uuid, String)>(
            r#"
            select id, imported_sentry_project_id, sentry_issue_id
            from sentry_issue_snapshots
            where hotfix_project_id = $1
            "#,
        )
        .bind(hotfix_project_id)
        .fetch_all(&mut **executor)
        .await?;

        for (snapshot_id, imported_project_id, sentry_issue_id) in existing_issue_rows {
            if seen_issue_keys.contains(&(imported_project_id, sentry_issue_id.clone())) {
                continue;
            }

            sqlx::query(
                r#"
                delete from sentry_issue_snapshots
                where id = $1
                "#,
            )
            .bind(snapshot_id)
            .execute(&mut **executor)
            .await?;
        }
    }

    for issue in issues {
        let snapshot_id = sqlx::query_scalar::<_, Uuid>(
            r#"
            insert into sentry_issue_snapshots (
                id,
                hotfix_project_id,
                imported_sentry_project_id,
                sentry_issue_id,
                short_id,
                title,
                culprit,
                level,
                status,
                event_count,
                user_count,
                permalink,
                exemplar_event_id,
                release_name,
                environment,
                trace_id,
                first_seen_at,
                last_seen_at,
                metadata,
                last_backfilled_at
            )
            values (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now()
            )
            on conflict (imported_sentry_project_id, sentry_issue_id) do update
            set
                short_id = excluded.short_id,
                title = excluded.title,
                culprit = excluded.culprit,
                level = excluded.level,
                status = excluded.status,
                event_count = excluded.event_count,
                user_count = excluded.user_count,
                permalink = excluded.permalink,
                exemplar_event_id = excluded.exemplar_event_id,
                release_name = excluded.release_name,
                environment = excluded.environment,
                trace_id = excluded.trace_id,
                first_seen_at = excluded.first_seen_at,
                last_seen_at = excluded.last_seen_at,
                metadata = excluded.metadata,
                last_backfilled_at = excluded.last_backfilled_at,
                updated_at = now()
            returning id
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(hotfix_project_id)
        .bind(issue.imported_sentry_project_id)
        .bind(&issue.issue.id)
        .bind(&issue.issue.short_id)
        .bind(&issue.issue.title)
        .bind(&issue.issue.culprit)
        .bind(&issue.issue.level)
        .bind(&issue.issue.status)
        .bind(issue.issue.count.unwrap_or(0))
        .bind(issue.issue.user_count.unwrap_or(0))
        .bind(&issue.issue.permalink)
        .bind(&issue.exemplar_event_id)
        .bind(&issue.release_name)
        .bind(&issue.environment)
        .bind(&issue.trace_id)
        .bind(parse_sentry_datetime(issue.issue.first_seen.as_deref()))
        .bind(parse_sentry_datetime(issue.issue.last_seen.as_deref()))
        .bind(SqlJson(issue.issue.metadata.clone()))
        .fetch_one(&mut **executor)
        .await?;

        sqlx::query(
            r#"
            delete from sentry_issue_code_refs
            where sentry_issue_snapshot_id = $1
            "#,
        )
        .bind(snapshot_id)
        .execute(&mut **executor)
        .await?;

        for code_ref in &issue.code_refs {
            sqlx::query(
                r#"
                insert into sentry_issue_code_refs (
                    id,
                    sentry_issue_snapshot_id,
                    github_repo_id,
                    github_repo_full_name,
                    github_repo_url,
                    path,
                    start_line,
                    end_line,
                    symbol,
                    confidence,
                    source,
                    metadata
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(snapshot_id)
            .bind(code_ref.github_repo_id)
            .bind(&code_ref.github_repo_full_name)
            .bind(&code_ref.github_repo_url)
            .bind(&code_ref.path)
            .bind(code_ref.start_line)
            .bind(code_ref.end_line)
            .bind(&code_ref.symbol)
            .bind(code_ref.confidence)
            .bind(&code_ref.source)
            .bind(SqlJson(code_ref.metadata.clone()))
            .execute(&mut **executor)
            .await?;
        }
    }

    Ok(())
}

async fn clear_hotfix_incident_data(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hotfix_project_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        update hotfix_projects
        set last_incident_backfill_at = null, updated_at = now()
        where id = $1
        "#,
    )
    .bind(hotfix_project_id)
    .execute(&mut **executor)
    .await?;

    sqlx::query(
        r#"
        delete from hotfix_incidents
        where hotfix_project_id = $1
        "#,
    )
    .bind(hotfix_project_id)
    .execute(&mut **executor)
    .await?;

    sqlx::query(
        r#"
        delete from sentry_issue_snapshots
        where hotfix_project_id = $1
        "#,
    )
    .bind(hotfix_project_id)
    .execute(&mut **executor)
    .await?;

    Ok(())
}

async fn rebuild_hotfix_incidents(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hotfix_project_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        delete from hotfix_incidents
        where hotfix_project_id = $1
        "#,
    )
    .bind(hotfix_project_id)
    .execute(&mut **executor)
    .await?;

    let snapshots = sqlx::query_as::<_, SentryIssueSnapshotRow>(
        r#"
        select
            id,
            imported_sentry_project_id,
            title,
            culprit,
            level,
            status,
            first_seen_at,
            last_seen_at
        from sentry_issue_snapshots
        where hotfix_project_id = $1
        order by last_seen_at desc nulls last, title asc
        "#,
    )
    .bind(hotfix_project_id)
    .fetch_all(&mut **executor)
    .await?;

    if snapshots.is_empty() {
        return Ok(());
    }

    let snapshot_ids = snapshots
        .iter()
        .map(|snapshot| snapshot.id)
        .collect::<Vec<_>>();
    let code_ref_rows = sqlx::query_as::<_, SentryIssueCodeRefRow>(
        r#"
        select
            sentry_issue_snapshot_id,
            github_repo_id,
            github_repo_full_name,
            github_repo_url,
            path,
            start_line,
            end_line,
            symbol,
            confidence,
            source,
            metadata
        from sentry_issue_code_refs
        where sentry_issue_snapshot_id = any($1)
        order by confidence desc, path asc, start_line asc nulls last
        "#,
    )
    .bind(&snapshot_ids)
    .fetch_all(&mut **executor)
    .await?;

    let mut refs_by_snapshot = HashMap::<Uuid, Vec<SentryIssueCodeRefRow>>::new();
    for row in code_ref_rows {
        refs_by_snapshot
            .entry(row.sentry_issue_snapshot_id)
            .or_default()
            .push(row);
    }

    let mut groups = HashMap::<String, Vec<SentryIssueSnapshotRow>>::new();
    for snapshot in snapshots {
        let key = incident_key_for_snapshot(&snapshot, refs_by_snapshot.get(&snapshot.id));
        groups.entry(key).or_default().push(snapshot);
    }

    for (incident_key, group) in groups {
        let incident_id = Uuid::new_v4();
        let title = incident_title_for_group(&group);
        let status = incident_status_for_group(&group);
        let first_seen_at = group
            .iter()
            .filter_map(|snapshot| snapshot.first_seen_at)
            .min();
        let last_seen_at = group
            .iter()
            .filter_map(|snapshot| snapshot.last_seen_at)
            .max();
        let sentry_project_count = group
            .iter()
            .map(|snapshot| snapshot.imported_sentry_project_id)
            .collect::<HashSet<_>>()
            .len() as i32;

        sqlx::query(
            r#"
            insert into hotfix_incidents (
                id,
                hotfix_project_id,
                incident_key,
                title,
                status,
                first_seen_at,
                last_seen_at,
                issue_count,
                sentry_project_count
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(incident_id)
        .bind(hotfix_project_id)
        .bind(&incident_key)
        .bind(&title)
        .bind(&status)
        .bind(first_seen_at)
        .bind(last_seen_at)
        .bind(group.len() as i32)
        .bind(sentry_project_count)
        .execute(&mut **executor)
        .await?;

        for snapshot in &group {
            sqlx::query(
                r#"
                insert into incident_sentry_issues (
                    id,
                    incident_id,
                    sentry_issue_snapshot_id
                )
                values ($1, $2, $3)
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(incident_id)
            .bind(snapshot.id)
            .execute(&mut **executor)
            .await?;
        }

        let mut deduped_refs = HashMap::<String, SentryIssueCodeRefRow>::new();
        for snapshot in &group {
            if let Some(code_refs) = refs_by_snapshot.get(&snapshot.id) {
                for code_ref in code_refs {
                    let key = format!(
                        "{}|{}|{}|{}|{}",
                        code_ref.github_repo_full_name.as_deref().unwrap_or(""),
                        code_ref.path,
                        code_ref.start_line.unwrap_or_default(),
                        code_ref.end_line.unwrap_or_default(),
                        code_ref.source,
                    );

                    let replace = deduped_refs
                        .get(&key)
                        .map(|existing| code_ref.confidence > existing.confidence)
                        .unwrap_or(true);

                    if replace {
                        deduped_refs.insert(
                            key,
                            SentryIssueCodeRefRow {
                                sentry_issue_snapshot_id: code_ref.sentry_issue_snapshot_id,
                                github_repo_id: code_ref.github_repo_id,
                                github_repo_full_name: code_ref.github_repo_full_name.clone(),
                                github_repo_url: code_ref.github_repo_url.clone(),
                                path: code_ref.path.clone(),
                                start_line: code_ref.start_line,
                                end_line: code_ref.end_line,
                                symbol: code_ref.symbol.clone(),
                                confidence: code_ref.confidence,
                                source: code_ref.source.clone(),
                                metadata: SqlJson(code_ref.metadata.0.clone()),
                            },
                        );
                    }
                }
            }
        }

        for code_ref in deduped_refs.into_values() {
            sqlx::query(
                r#"
                insert into incident_code_refs (
                    id,
                    incident_id,
                    github_repo_id,
                    github_repo_full_name,
                    github_repo_url,
                    path,
                    start_line,
                    end_line,
                    symbol,
                    confidence,
                    source,
                    metadata
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(incident_id)
            .bind(code_ref.github_repo_id)
            .bind(&code_ref.github_repo_full_name)
            .bind(&code_ref.github_repo_url)
            .bind(&code_ref.path)
            .bind(code_ref.start_line)
            .bind(code_ref.end_line)
            .bind(&code_ref.symbol)
            .bind(code_ref.confidence)
            .bind(&code_ref.source)
            .bind(code_ref.metadata)
            .execute(&mut **executor)
            .await?;
        }
    }

    Ok(())
}

async fn sync_imported_sentry_projects(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hotfix_project_id: Uuid,
    sentry_connection_id: Uuid,
    projects: &[SentryProjectResponse],
    metrics_by_project_id: &HashMap<String, SentryProjectMetricsSnapshot>,
    sentry_repositories: &HashSet<String>,
) -> Result<(), AppError> {
    let mut seen_project_ids = HashSet::new();

    for project in projects {
        seen_project_ids.insert(project.id.clone());
        let metrics = metrics_by_project_id
            .get(&project.id)
            .cloned()
            .unwrap_or_default();
        sqlx::query(
            r#"
            insert into imported_sentry_projects (
                id,
                hotfix_project_id,
                sentry_connection_id,
                sentry_project_id,
                slug,
                name,
                platform,
                errors_24h,
                transactions_24h,
                replays_24h,
                profiles_24h,
                errors_24h_series,
                transactions_24h_series,
                synced_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
            on conflict (hotfix_project_id, sentry_project_id) do update
            set
                sentry_connection_id = excluded.sentry_connection_id,
                slug = excluded.slug,
                name = excluded.name,
                platform = excluded.platform,
                errors_24h = excluded.errors_24h,
                transactions_24h = excluded.transactions_24h,
                replays_24h = excluded.replays_24h,
                profiles_24h = excluded.profiles_24h,
                errors_24h_series = excluded.errors_24h_series,
                transactions_24h_series = excluded.transactions_24h_series,
                synced_at = excluded.synced_at,
                updated_at = now()
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(hotfix_project_id)
        .bind(sentry_connection_id)
        .bind(&project.id)
        .bind(&project.slug)
        .bind(&project.name)
        .bind(&project.platform)
        .bind(metrics.errors_24h)
        .bind(metrics.transactions_24h)
        .bind(metrics.replays_24h)
        .bind(metrics.profiles_24h)
        .bind(SqlJson(metrics.errors_24h_series.clone()))
        .bind(SqlJson(metrics.transactions_24h_series.clone()))
        .execute(&mut **executor)
        .await?;
    }

    let existing_ids = sqlx::query_scalar::<_, String>(
        r#"
        select sentry_project_id
        from imported_sentry_projects
        where hotfix_project_id = $1
        "#,
    )
    .bind(hotfix_project_id)
    .fetch_all(&mut **executor)
    .await?;

    for sentry_project_id in existing_ids {
        if !seen_project_ids.contains(&sentry_project_id) {
            sqlx::query(
                r#"
                delete from imported_sentry_projects
                where hotfix_project_id = $1 and sentry_project_id = $2
                "#,
            )
            .bind(hotfix_project_id)
            .bind(&sentry_project_id)
            .execute(&mut **executor)
            .await?;
        }
    }

    let project_repo_rows = sqlx::query_as::<_, (Uuid, Option<String>)>(
        r#"
        select
            imported_sentry_projects.id,
            sentry_project_repo_mappings.github_repo_full_name
        from imported_sentry_projects
        left join sentry_project_repo_mappings
            on sentry_project_repo_mappings.imported_sentry_project_id = imported_sentry_projects.id
        where imported_sentry_projects.hotfix_project_id = $1
        "#,
    )
    .bind(hotfix_project_id)
    .fetch_all(&mut **executor)
    .await?;

    for (imported_project_id, github_repo_full_name) in project_repo_rows {
        let sentry_repo_connected = github_repo_full_name
            .as_deref()
            .map(|name| sentry_repositories.contains(&name.to_lowercase()))
            .unwrap_or(false);

        sqlx::query(
            r#"
            update imported_sentry_projects
            set sentry_repo_connected = $1, updated_at = now()
            where id = $2
            "#,
        )
        .bind(sentry_repo_connected)
        .bind(imported_project_id)
        .execute(&mut **executor)
        .await?;
    }

    Ok(())
}

async fn sync_hotfix_project_graph(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hotfix_project_id: Uuid,
) -> Result<(), AppError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        select exists(
            select 1
            from hotfix_projects
            where id = $1
        )
        "#,
    )
    .bind(hotfix_project_id)
    .fetch_one(&mut **executor)
    .await?;

    if !exists {
        return Err(AppError::NotFound(
            "The requested Hotfix project was not found.".into(),
        ));
    }

    sqlx::query(
        r#"
        delete from hotfix_project_graph_edges
        where hotfix_project_id = $1 and is_system = true
        "#,
    )
    .bind(hotfix_project_id)
    .execute(&mut **executor)
    .await?;

    sqlx::query(
        r#"
        delete from hotfix_project_graph_nodes
        where hotfix_project_id = $1 and is_system = true
        "#,
    )
    .bind(hotfix_project_id)
    .execute(&mut **executor)
    .await?;

    Ok(())
}

fn default_system_project_graph_position(index: usize, total: usize) -> (f64, f64) {
    const GRAPH_CARD_WIDTH: f64 = 248.0;
    const GRAPH_CARD_HEIGHT: f64 = 154.0;
    const GRAPH_CARD_COLUMN_GAP: f64 = 88.0;
    const GRAPH_CARD_ROW_GAP: f64 = 72.0;
    const GRAPH_GRID_MAX_COLUMNS: usize = 4;
    const GRAPH_LAYOUT_START_Y: f64 = 120.0;

    let mut columns = (total as f64).sqrt().ceil() as usize;
    columns = columns.clamp(1, GRAPH_GRID_MAX_COLUMNS);

    let mut total_width = columns as f64 * GRAPH_CARD_WIDTH;
    if columns > 1 {
        total_width += (columns - 1) as f64 * GRAPH_CARD_COLUMN_GAP;
    }

    let column = index % columns;
    let row = index / columns;
    let start_x = total_width * -0.5;

    (
        start_x + column as f64 * (GRAPH_CARD_WIDTH + GRAPH_CARD_COLUMN_GAP),
        GRAPH_LAYOUT_START_Y + row as f64 * (GRAPH_CARD_HEIGHT + GRAPH_CARD_ROW_GAP),
    )
}

fn encrypt_provider_token(secret: &[u8], token: &str) -> Result<(Vec<u8>, Vec<u8>), AppError> {
    let key = token_cipher_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AppError::Config("Could not initialize token encryption.".into()))?;
    let nonce_bytes = random::<[u8; 12]>();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, token.as_bytes())
        .map_err(|_| AppError::Internal)?;
    Ok((nonce_bytes.to_vec(), ciphertext))
}

fn decrypt_provider_token(
    secret: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<String, AppError> {
    let key = token_cipher_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AppError::Config("Could not initialize token encryption.".into()))?;
    let nonce = Nonce::from_slice(nonce);
    let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|_| {
        AppError::Auth(
            "The stored provider connection could not be decrypted. Reconnect it.".into(),
        )
    })?;
    String::from_utf8(plaintext).map_err(|_| AppError::Internal)
}

fn token_cipher_key(secret: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest([secret, b":hotfix-provider-connections"].concat());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    key
}

fn parse_sentry_next_cursor(link_header: Option<&str>) -> Option<String> {
    let header = link_header?;
    for part in header.split(',') {
        if !part.contains("rel=\"next\"") || !part.contains("results=\"true\"") {
            continue;
        }

        if let Some(cursor) = extract_cursor_value(part) {
            return Some(cursor);
        }
    }

    None
}

fn incremental_issue_sync_start(since: OffsetDateTime) -> String {
    let conservative_start = since - time::Duration::minutes(1);
    conservative_start
        .format(&Rfc3339)
        .unwrap_or_else(|_| since.unix_timestamp().to_string())
}

fn required_text_field(value: &str, message: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(message.to_string()));
    }

    Ok(trimmed.to_string())
}

fn optional_text_field(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn deserialize_string_from_string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match JsonValue::deserialize(deserializer)? {
        JsonValue::String(value) => Ok(value),
        JsonValue::Number(value) => Ok(value.to_string()),
        other => Err(serde::de::Error::custom(format!(
            "expected string or number, got {other}"
        ))),
    }
}

fn deserialize_option_i64_from_string_or_number<'de, D>(
    deserializer: D,
) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Option::<JsonValue>::deserialize(deserializer)? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(value)) => value
            .parse::<i64>()
            .map(Some)
            .map_err(serde::de::Error::custom),
        Some(JsonValue::Number(value)) => value
            .as_i64()
            .ok_or_else(|| serde::de::Error::custom("expected an integer number"))
            .map(Some),
        Some(other) => Err(serde::de::Error::custom(format!(
            "expected string, number, or null, got {other}"
        ))),
    }
}

fn has_scope(scopes: Option<&str>, required_scope: &str) -> bool {
    scopes
        .unwrap_or_default()
        .split(|character: char| character.is_ascii_whitespace() || character == ',')
        .any(|scope| scope == required_scope)
}

fn parse_sentry_datetime(value: Option<&str>) -> Option<OffsetDateTime> {
    value.and_then(|raw| OffsetDateTime::parse(raw, &Rfc3339).ok())
}

fn timestamp_millis(value: Option<OffsetDateTime>) -> Option<i64> {
    value.map(|timestamp| (timestamp.unix_timestamp_nanos() / 1_000_000) as i64)
}

fn tag_value(tags: &[SentryTagResponse], key: &str) -> Option<String> {
    tags.iter()
        .find(|tag| tag.key == key)
        .map(|tag| tag.value.clone())
}

fn extract_code_refs_from_event(
    event: &SentryIssueEventResponse,
    imported_project: &BackfillImportedProjectRow,
) -> Vec<IssueCodeRefCandidate> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();

    for entry in &event.entries {
        let Some(entry_type) = entry.get("type").and_then(|value| value.as_str()) else {
            continue;
        };

        if entry_type != "exception" && entry_type != "threads" {
            continue;
        }

        let Some(values) = entry
            .get("data")
            .and_then(|data| data.get("values"))
            .and_then(|values| values.as_array())
        else {
            continue;
        };

        for value in values.iter().rev() {
            let Some(frames) = value
                .get("stacktrace")
                .and_then(|stacktrace| stacktrace.get("frames"))
                .and_then(|frames| frames.as_array())
            else {
                continue;
            };

            for (frame_index, frame) in frames.iter().rev().enumerate() {
                let in_app = frame
                    .get("inApp")
                    .or_else(|| frame.get("in_app"))
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                if !in_app {
                    continue;
                }

                let path = frame
                    .get("filename")
                    .or_else(|| frame.get("absPath"))
                    .or_else(|| frame.get("abs_path"))
                    .or_else(|| frame.get("module"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.trim().trim_start_matches("./").to_string())
                    .filter(|value| !value.is_empty());
                let Some(path) = path else {
                    continue;
                };

                let start_line = frame
                    .get("lineno")
                    .and_then(|value| value.as_i64())
                    .and_then(|value| i32::try_from(value).ok());
                let end_line = start_line;
                let symbol = frame
                    .get("function")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .filter(|value| !value.trim().is_empty());
                let key = format!(
                    "{}|{}|{}|{}",
                    imported_project
                        .github_repo_full_name
                        .as_deref()
                        .unwrap_or(""),
                    path,
                    start_line.unwrap_or_default(),
                    symbol.as_deref().unwrap_or(""),
                );
                if !seen.insert(key) {
                    continue;
                }

                let confidence = (0.96_f64 - frame_index as f64 * 0.12).max(0.42);
                refs.push(IssueCodeRefCandidate {
                    github_repo_id: imported_project.github_repo_id,
                    github_repo_full_name: imported_project.github_repo_full_name.clone(),
                    github_repo_url: imported_project.github_repo_url.clone(),
                    path,
                    start_line,
                    end_line,
                    symbol,
                    confidence,
                    source: "stack_frame".to_string(),
                    metadata: json!({
                        "module": frame.get("module").and_then(|value| value.as_str()),
                        "absPath": frame
                            .get("absPath")
                            .or_else(|| frame.get("abs_path"))
                            .and_then(|value| value.as_str()),
                        "projectSlug": imported_project.slug,
                        "eventId": event.event_id,
                        "eventDateCreated": event.date_created,
                    }),
                });

                if refs.len() >= 5 {
                    return refs;
                }
            }
        }
    }

    refs
}

fn incident_key_for_snapshot(
    snapshot: &SentryIssueSnapshotRow,
    code_refs: Option<&Vec<SentryIssueCodeRefRow>>,
) -> String {
    let reference = code_refs
        .and_then(|rows| rows.first())
        .map(|row| {
            format!(
                "{}|{}|{}",
                row.github_repo_full_name.as_deref().unwrap_or(""),
                row.path,
                row.symbol.as_deref().unwrap_or("")
            )
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "{}|{}|{}",
                normalize_incident_component(&snapshot.title),
                snapshot
                    .culprit
                    .as_deref()
                    .map(normalize_incident_component)
                    .unwrap_or_default(),
                snapshot
                    .level
                    .as_deref()
                    .map(normalize_incident_component)
                    .unwrap_or_default()
            )
        });

    format!(
        "{}-{}",
        normalize_incident_component(&snapshot.title),
        short_sha(&reference)
    )
}

fn incident_title_for_group(group: &[SentryIssueSnapshotRow]) -> String {
    group
        .iter()
        .max_by_key(|snapshot| snapshot.last_seen_at)
        .map(|snapshot| snapshot.title.clone())
        .unwrap_or_else(|| "Incident".to_string())
}

fn incident_status_for_group(group: &[SentryIssueSnapshotRow]) -> String {
    if group
        .iter()
        .any(|snapshot| snapshot.status != "resolved" && snapshot.status != "ignored")
    {
        "unresolved".to_string()
    } else {
        "resolved".to_string()
    }
}

fn normalize_incident_component(value: &str) -> String {
    let mut normalized = String::new();
    let mut last_dash = false;

    for character in value.trim().chars() {
        let lower = character.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            normalized.push(lower);
            last_dash = false;
        } else if !last_dash {
            normalized.push('-');
            last_dash = true;
        }
    }

    let normalized = normalized.trim_matches('-').to_string();
    if normalized.is_empty() {
        "incident".to_string()
    } else {
        normalized
    }
}

fn short_sha(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn extract_cursor_value(part: &str) -> Option<String> {
    let (_, cursor_part) = part.split_once("cursor=\"")?;
    let (cursor, _) = cursor_part.split_once('"')?;
    Some(cursor.to_string())
}

fn json_string(row: &HashMap<String, JsonValue>, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|value| value.as_str().map(str::to_string))
}

fn json_i64(row: &HashMap<String, JsonValue>, key: &str) -> Option<i64> {
    row.get(key).and_then(|value| match value {
        JsonValue::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|n| n.round() as i64)),
        _ => None,
    })
}

fn json_f64(row: &HashMap<String, JsonValue>, key: &str) -> Option<f64> {
    row.get(key).and_then(|value| match value {
        JsonValue::Number(number) => number.as_f64(),
        _ => None,
    })
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info,tower_http=info,axum::rejection=trace".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}

fn required_env(name: &str) -> Result<String, AppError> {
    env::var(name).map_err(|_| AppError::Config(format!("{name} is required.")))
}

fn backend_error(error: impl Display) -> session_store::Error {
    session_store::Error::Backend(error.to_string())
}

fn parse_url(name: &str) -> Result<Url, AppError> {
    let raw = required_env(name)?;
    Url::parse(&raw).map_err(|_| AppError::Config(format!("{name} must be a valid URL.")))
}

fn decode_session_secret(value: &str) -> Result<Vec<u8>, AppError> {
    let secret = STANDARD
        .decode(value)
        .map_err(|_| AppError::Config("HOTFIX_SESSION_SECRET must be base64.".into()))?;
    if secret.len() < 32 {
        return Err(AppError::Config(
            "HOTFIX_SESSION_SECRET must decode to at least 32 bytes.".into(),
        ));
    }
    Ok(secret)
}

fn random_urlsafe(len: usize) -> String {
    let bytes: Vec<u8> = (0..len).map(|_| random::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn select_github_email(emails: &[GitHubEmail]) -> Option<String> {
    emails
        .iter()
        .find(|email| email.primary && email.verified)
        .or_else(|| emails.iter().find(|email| email.verified))
        .or_else(|| emails.first())
        .map(|email| email.email.clone())
}

fn normalize_email(email: &str) -> Option<String> {
    let normalized = email.trim().to_ascii_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

fn slugify_project_name(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut previous_was_dash = false;

    for character in name.chars() {
        let normalized = character.to_ascii_lowercase();
        if normalized.is_ascii_alphanumeric() {
            slug.push(normalized);
            previous_was_dash = false;
        } else if !previous_was_dash && !slug.is_empty() {
            slug.push('-');
            previous_was_dash = true;
        }
    }

    while slug.ends_with('-') {
        slug.pop();
    }

    if slug.is_empty() {
        return "project".to_string();
    }

    if matches!(slug.as_str(), "api" | "privacy" | "terms") {
        slug.push_str("-project");
    }

    slug
}

async fn generate_unique_project_slug(
    db: &PgPool,
    name: &str,
    exclude_project_id: Option<Uuid>,
) -> Result<String, AppError> {
    let base_slug = slugify_project_name(name);
    let mut candidate = base_slug.clone();
    let mut suffix = 2;

    loop {
        let exists = sqlx::query_scalar::<_, bool>(
            r#"
            select exists(
                select 1
                from hotfix_projects
                where slug = $1
                  and ($2::uuid is null or id <> $2)
            )
            "#,
        )
        .bind(&candidate)
        .bind(exclude_project_id)
        .fetch_one(db)
        .await?;

        if !exists {
            return Ok(candidate);
        }

        candidate = format!("{base_slug}-{suffix}");
        suffix += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        GitHubEmail, Provider, SentryIssueResponse, SentryProjectResponse, normalize_email,
        pkce_challenge, select_github_email, slugify_project_name,
    };
    use serde_json::json;

    #[test]
    fn provider_slug_parser_is_strict() {
        assert!(matches!(
            Provider::from_slug("github"),
            Ok(Provider::GitHub)
        ));
        assert!(matches!(
            Provider::from_slug("sentry"),
            Ok(Provider::Sentry)
        ));
        assert!(Provider::from_slug("GitHub").is_err());
    }

    #[test]
    fn pkce_challenge_is_url_safe() {
        let challenge = pkce_challenge("verifier-for-test");
        assert!(!challenge.contains('='));
        assert!(
            challenge
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        );
    }

    #[test]
    fn github_email_selection_prefers_primary_verified() {
        let emails = vec![
            GitHubEmail {
                email: "secondary@example.com".into(),
                primary: false,
                verified: true,
            },
            GitHubEmail {
                email: "primary@example.com".into(),
                primary: true,
                verified: true,
            },
        ];

        assert_eq!(
            select_github_email(&emails).as_deref(),
            Some("primary@example.com")
        );
    }

    #[test]
    fn email_normalization_trims_and_lowercases() {
        assert_eq!(
            normalize_email("  USER@Example.COM ").as_deref(),
            Some("user@example.com")
        );
        assert_eq!(normalize_email("   "), None);
    }

    #[test]
    fn project_slugify_normalizes_human_names() {
        assert_eq!(slugify_project_name("Zeus server"), "zeus-server");
        assert_eq!(slugify_project_name("  API / Gateway  "), "api-gateway");
        assert_eq!(slugify_project_name("!!!"), "project");
    }

    #[test]
    fn sentry_issue_response_accepts_numeric_user_count() {
        let issue = serde_json::from_value::<SentryIssueResponse>(json!({
            "id": "123",
            "shortId": "ORG-123",
            "title": "Example issue",
            "culprit": "app/main.py in handler",
            "level": "error",
            "status": "unresolved",
            "count": "42",
            "userCount": 0,
            "firstSeen": "2026-04-02T00:00:00Z",
            "lastSeen": "2026-04-02T01:00:00Z",
            "project": {
                "id": 7,
                "slug": "backend"
            }
        }))
        .expect("issue response should deserialize");

        assert_eq!(issue.count, Some(42));
        assert_eq!(issue.user_count, Some(0));
        assert_eq!(
            issue.project.as_ref().map(|project| project.id.as_str()),
            Some("7")
        );
    }

    #[test]
    fn sentry_project_response_accepts_numeric_id() {
        let project = serde_json::from_value::<SentryProjectResponse>(json!({
            "id": 99,
            "slug": "backend",
            "name": "Backend"
        }))
        .expect("project response should deserialize");

        assert_eq!(project.id, "99");
    }
}
