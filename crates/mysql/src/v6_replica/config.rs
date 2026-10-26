//! Queue and timeout limits for V6 replay.
use std::{
    sync::LazyLock,
    time::Duration,
};

use anyhow::Context as _;
use cmd_util::env::env_config;
use url::Url;

pub(super) fn parse_url(url: &str) -> anyhow::Result<(Url, String)> {
    let parsed: Url = url.parse().context("invalid V6 replica URL")?;
    let db_name = parsed.path().trim_start_matches('/').to_owned();
    anyhow::ensure!(
        !db_name.is_empty(),
        "the V6 replica URL must name a database"
    );
    Ok((parsed, db_name))
}

#[derive(Clone)]
pub(super) struct Settings {
    /// Shared by backfill waits, shutdown, and startup's wait for the previous
    /// writer to set clean_shutdown.
    pub(super) apply_wait: Duration,
    /// Queue overflow retires the replica to bound memory use.
    pub(super) max_queued_jobs: usize,
    /// Retry budget per operation; exhaustion retires the replica.
    pub(super) job_retry: Duration,
    /// Deployment loading waits for replica initialization.
    pub(super) init_timeout: Duration,
}

pub(super) static SETTINGS: LazyLock<Settings> = LazyLock::new(|| Settings {
    apply_wait: Duration::from_millis(env_config("MYSQL_V6_REPLICA_APPLY_WAIT_MS", 2000)),
    max_queued_jobs: env_config::<usize>("MYSQL_V6_REPLICA_MAX_QUEUED_JOBS", 1024).max(1),
    job_retry: Duration::from_millis(env_config("MYSQL_V6_REPLICA_JOB_RETRY_MS", 30_000)),
    init_timeout: Duration::from_millis(env_config("MYSQL_V6_REPLICA_INIT_TIMEOUT_MS", 10_000)),
});
