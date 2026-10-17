use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{error::AppResult, local_server::LocalServerConfig, ssh_tunnel::SshConfig};

const KEYCHAIN_SERVICE: &str = "dev.jguerra.tableminus";
const CONNECTIONS_FILE: &str = "connections.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Sqlite,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub driver: Driver,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub file_path: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub safe_mode: String,
    #[serde(default)]
    pub local_server: Option<LocalServerConfig>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
}

impl ConnectionConfig {
    pub fn active_ssh(&self) -> Option<&SshConfig> {
        self.ssh.as_ref().filter(|ssh| ssh.is_enabled && self.driver != Driver::Sqlite)
    }
}

fn connections_file_path(app: &AppHandle) -> AppResult<PathBuf> {
    let directory = app.path().app_data_dir()?;
    fs::create_dir_all(&directory)?;
    Ok(directory.join(CONNECTIONS_FILE))
}

pub fn load_connections(app: &AppHandle) -> AppResult<Vec<ConnectionConfig>> {
    let path = connections_file_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

pub fn store_connections(app: &AppHandle, connections: &[ConnectionConfig]) -> AppResult<()> {
    let path = connections_file_path(app)?;
    fs::write(path, serde_json::to_string_pretty(connections)?)?;
    Ok(())
}

pub fn find_connection(app: &AppHandle, id: &str) -> AppResult<ConnectionConfig> {
    load_connections(app)?
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| crate::error::AppError::Message(format!("Connection {id} not found")))
}

pub fn read_password(connection_id: &str) -> AppResult<Option<String>> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, connection_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn write_password(connection_id: &str, password: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, connection_id)?;
    if password.is_empty() {
        return delete_password(connection_id);
    }
    entry.set_password(password)?;
    Ok(())
}

pub fn delete_password(connection_id: &str) -> AppResult<()> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, connection_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ssh_secret_account(connection_id: &str) -> String {
    format!("{connection_id}:ssh")
}

pub fn read_ssh_secret(connection_id: &str) -> AppResult<Option<String>> {
    read_password(&ssh_secret_account(connection_id))
}

pub fn write_ssh_secret(connection_id: &str, secret: &str) -> AppResult<()> {
    write_password(&ssh_secret_account(connection_id), secret)
}

pub fn delete_ssh_secret(connection_id: &str) -> AppResult<()> {
    delete_password(&ssh_secret_account(connection_id))
}
