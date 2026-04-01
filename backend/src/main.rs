use std::{
    collections::HashSet,
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
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection, PgPool, postgres::PgPoolOptions};
use time::OffsetDateTime;
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
            Self::Sentry => "org:read project:read",
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
    providers: ConnectedProviders,
}

#[derive(Debug, FromRow)]
struct SessionUserRow {
    id: Uuid,
    display_name: String,
    email: Option<String>,
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
struct ImportedSentryProjectPayload {
    id: Uuid,
    sentry_project_id: String,
    slug: String,
    name: String,
    platform: Option<String>,
    repo_mapping: Option<GitHubRepoMappingPayload>,
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
    github_repo_id: Option<i64>,
    github_repo_full_name: Option<String>,
    github_repo_url: Option<String>,
    github_repo_default_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SentryOrganization {
    id: String,
    slug: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct SentryProjectResponse {
    id: String,
    slug: String,
    name: String,
    platform: Option<String>,
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
            patch(update_hotfix_project),
        )
        .route(
            "/hotfix-projects/{project_id}/sentry-connection",
            post(assign_sentry_connection),
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

    sync_imported_sentry_projects(&mut tx, project_id, connection.id, &sentry_projects).await?;
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
        .bind(repo.full_name)
        .bind(repo.html_url)
        .bind(repo.default_branch.as_deref())
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
    }

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

async fn sync_imported_sentry_projects(
    executor: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hotfix_project_id: Uuid,
    sentry_connection_id: Uuid,
    projects: &[SentryProjectResponse],
) -> Result<(), AppError> {
    let mut seen_project_ids = HashSet::new();

    for project in projects {
        seen_project_ids.insert(project.id.clone());
        sqlx::query(
            r#"
            insert into imported_sentry_projects (
                id,
                hotfix_project_id,
                sentry_connection_id,
                sentry_project_id,
                slug,
                name,
                platform
            )
            values ($1, $2, $3, $4, $5, $6, $7)
            on conflict (hotfix_project_id, sentry_project_id) do update
            set
                sentry_connection_id = excluded.sentry_connection_id,
                slug = excluded.slug,
                name = excluded.name,
                platform = excluded.platform,
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

    Ok(())
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

fn extract_cursor_value(part: &str) -> Option<String> {
    let (_, cursor_part) = part.split_once("cursor=\"")?;
    let (cursor, _) = cursor_part.split_once('"')?;
    Some(cursor.to_string())
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
        GitHubEmail, Provider, normalize_email, pkce_challenge, select_github_email,
        slugify_project_name,
    };

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
}
