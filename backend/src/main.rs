use std::{
    env,
    fmt::Display,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
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
            Self::Config(message) | Self::BadRequest(message) | Self::Auth(message) => message,
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
            Self::GitHub => "read:user user:email",
            Self::Sentry => "org:read",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OAuthFlow {
    provider: Provider,
    state: String,
    code_verifier: String,
    started_at: i64,
}

impl OAuthFlow {
    fn new(provider: Provider) -> Self {
        Self {
            provider,
            state: random_urlsafe(32),
            code_verifier: random_urlsafe(64),
            started_at: OffsetDateTime::now_utc().unix_timestamp(),
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

#[derive(Debug, FromRow)]
struct IdentityLookup {
    user_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct GitHubTokenResponse {
    access_token: String,
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
    let Some(user_id) = session.get::<Uuid>(SESSION_USER_ID_KEY).await? else {
        return Ok(Json(SessionPayload::anonymous()));
    };

    let user = sqlx::query_as::<_, SessionUserRow>(
        r#"
        select
            users.id,
            users.display_name,
            users.email,
            exists(
                select 1
                from auth_identities
                where auth_identities.user_id = users.id
                  and auth_identities.provider = 'github'
            ) as github_connected,
            exists(
                select 1
                from auth_identities
                where auth_identities.user_id = users.id
                  and auth_identities.provider = 'sentry'
            ) as sentry_connected
        from users
        where users.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    match user {
        Some(user) => Ok(Json(SessionPayload {
            authenticated: true,
            user: Some(user.into()),
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
    let flow = OAuthFlow::new(provider);

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
        let user = upsert_user(&state.db, profile).await?;

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
        username: Some(user.login),
        display_name,
        email,
        avatar_url: user.avatar_url,
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
    })
}

async fn upsert_user(db: &PgPool, profile: ExternalProfile) -> Result<SessionUser, AppError> {
    let mut tx = db.begin().await?;
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

    let linked_user = if existing.is_none() {
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

    let user_id = if let Some(existing) = existing.or(linked_user) {
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
        .bind(existing.user_id)
        .execute(&mut *tx)
        .await?;

        let result = sqlx::query(
            r#"
            update auth_identities
            set
                username = $1,
                display_name = $2,
                email = coalesce($3, email),
                avatar_url = $4,
                updated_at = now(),
                last_login_at = now()
            where provider = $5 and provider_user_id = $6
            "#,
        )
        .bind(&profile.username)
        .bind(&profile.display_name)
        .bind(&normalized_email)
        .bind(&profile.avatar_url)
        .bind(profile.provider.as_str())
        .bind(&profile.provider_user_id)
        .execute(&mut *tx)
        .await?;

        if result.rows_affected() == 0 {
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
            .bind(existing.user_id)
            .bind(profile.provider.as_str())
            .bind(&profile.provider_user_id)
            .bind(&profile.username)
            .bind(&profile.display_name)
            .bind(&normalized_email)
            .bind(&profile.avatar_url)
            .execute(&mut *tx)
            .await?;
        }

        existing.user_id
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

        user_id
    };

    let user = sqlx::query_as::<_, SessionUserRow>(
        r#"
        select
            users.id,
            users.display_name,
            users.email,
            exists(
                select 1
                from auth_identities
                where auth_identities.user_id = users.id
                  and auth_identities.provider = 'github'
            ) as github_connected,
            exists(
                select 1
                from auth_identities
                where auth_identities.user_id = users.id
                  and auth_identities.provider = 'sentry'
            ) as sentry_connected
        from users
        where users.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(user.into())
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

#[cfg(test)]
mod tests {
    use super::{GitHubEmail, Provider, normalize_email, pkce_challenge, select_github_email};

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
}
