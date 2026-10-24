//! Claude Code CLI integration — finding and installing the CLI, building its
//! invocation, and turning its stream-json output into UI events.
//!
//! One file per concern; each is re-exported here, so callers keep writing
//! `claude::foo`. Helpers one file lends another are `pub(super)`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::artifacts;
use crate::session::{self, Decision, Session};
use crate::models::{
    self, is_safe_model_arg, model_name, ModelInfo, ORCH_BALANCED_MODEL, ORCH_DEEP_MODEL,
    ORCH_FAST_MODEL, SUB_MODEL_AUTO, TITLE_MODEL,
};

mod binary;
mod auth;
mod install;
mod args;
mod prompt;
mod permissions;
mod orchestration;
mod tools;
mod ask;
mod turn;
mod agents;
mod events;
mod oneshot;

pub use binary::*;
pub use auth::*;
pub use install::*;
pub use args::*;
pub use prompt::*;
pub use permissions::*;
pub use orchestration::*;
pub use tools::*;
use ask::*;
pub use turn::*;
pub use agents::*;
use events::*;
pub use oneshot::*;
