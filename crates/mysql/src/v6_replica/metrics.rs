//! Replay outcomes and writer lifecycle metrics, labeled by source cluster.
use metrics::{
    register_convex_counter,
    register_convex_gauge,
};

register_convex_counter!(
    MYSQL_V6_REPLICA_JOBS_TOTAL,
    "V6 replica jobs by outcome: applied, failed when the replica rejected or could not apply \
     one, skipped when the replica had already retired",
    &["cluster_name", "outcome"]
);
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr, strum::EnumIter)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum JobOutcome {
    Applied,
    Failed,
    Skipped,
}
pub(crate) fn log_job(cluster_name: &str, outcome: JobOutcome) {
    MYSQL_V6_REPLICA_JOBS_TOTAL
        .with_label_values(&[cluster_name, outcome.into()])
        .inc();
}

register_convex_counter!(
    MYSQL_V6_REPLICA_RETIREMENTS_TOTAL,
    "V6 replicas retired, by reason",
    &["cluster_name", "reason"]
);
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr, strum::EnumIter)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum RetireReason {
    /// A replay failure leaves replica completeness uncertain.
    JobFailed,
    QueueFull,
    /// Restore, import, or migration wrote outside the mirrored path.
    BulkWrite,
    /// The replica may be missing source writes at a writer handoff.
    UncleanHandoff,
}
pub(crate) fn log_retirement(cluster_name: &str, reason: RetireReason) {
    MYSQL_V6_REPLICA_RETIREMENTS_TOTAL
        .with_label_values(&[cluster_name, reason.into()])
        .inc();
}

register_convex_gauge!(
    MYSQL_V6_REPLICA_WRITERS_TOTAL,
    "V5 writers by replica state",
    &["cluster_name", "state"]
);
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr, strum::EnumIter)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum WriterState {
    Ready,
    Displaced,
    Closed,
    /// The deployment has history the replica never received.
    Ineligible,
    Retired,
    InitializationFailed,
}

register_convex_gauge!(
    MYSQL_V6_REPLICA_QUEUED_JOBS_TOTAL,
    "V6 replica jobs queued in this process and not yet finished",
    &["cluster_name"]
);
pub(crate) fn add_queued(cluster_name: &str, delta: f64) {
    MYSQL_V6_REPLICA_QUEUED_JOBS_TOTAL
        .with_label_values(&[cluster_name])
        .add(delta);
}

/// Each live instance contributes one writer, even when shared through `Arc`.
pub(crate) struct WriterStateGauge {
    cluster_name: String,
    state: parking_lot::Mutex<WriterState>,
}
impl WriterStateGauge {
    pub(crate) fn new(cluster_name: &str, state: WriterState) -> Self {
        let gauge = Self {
            cluster_name: cluster_name.to_owned(),
            state: parking_lot::Mutex::new(state),
        };
        gauge.add(state, 1.0);
        gauge
    }

    fn add(&self, state: WriterState, delta: f64) {
        MYSQL_V6_REPLICA_WRITERS_TOTAL
            .with_label_values(&[self.cluster_name.as_str(), state.into()])
            .add(delta);
    }

    pub(crate) fn set(&self, next: WriterState) {
        let mut state = self.state.lock();
        if *state != next {
            self.add(*state, -1.0);
            self.add(next, 1.0);
            *state = next;
        }
    }
}
impl Drop for WriterStateGauge {
    fn drop(&mut self) {
        let state = *self.state.get_mut();
        self.add(state, -1.0);
    }
}

/// Publishes zeroes so the first event of each series has a baseline.
pub(crate) fn initialize(cluster_name: &str) {
    use strum::IntoEnumIterator as _;
    for outcome in JobOutcome::iter() {
        MYSQL_V6_REPLICA_JOBS_TOTAL
            .with_label_values(&[cluster_name, outcome.into()])
            .inc_by(0);
    }
    for reason in RetireReason::iter() {
        MYSQL_V6_REPLICA_RETIREMENTS_TOTAL
            .with_label_values(&[cluster_name, reason.into()])
            .inc_by(0);
    }
}
