const SERVICE_NAME: &str = "com.moraya.app";

/// Store a secret in the OS keychain.
/// Key naming convention: `ai-key:{configId}` or `image-key:{configId}`
#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    let entry =
        keyring::Entry::new(SERVICE_NAME, &key).map_err(|_| "Failed to access keychain")?;
    entry
        .set_password(&value)
        .map_err(|_| "Failed to store secret in keychain")?;
    Ok(())
}

/// Retrieve a secret from the OS keychain.
/// Returns None if the key doesn't exist.
#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    let entry =
        keyring::Entry::new(SERVICE_NAME, &key).map_err(|_| "Failed to access keychain")?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Failed to retrieve secret from keychain".to_string()),
    }
}

/// Delete a secret from the OS keychain.
#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    let entry =
        keyring::Entry::new(SERVICE_NAME, &key).map_err(|_| "Failed to access keychain")?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already deleted
        Err(_) => Err("Failed to delete secret from keychain".to_string()),
    }
}
