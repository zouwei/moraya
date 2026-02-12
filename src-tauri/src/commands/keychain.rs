use super::ai_proxy::AIProxyState;

/// Store a secret. Updates in-memory cache and persists entire secrets map
/// to the single keychain entry.
#[tauri::command]
pub fn keychain_set(
    state: tauri::State<'_, AIProxyState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state.ensure_secrets_loaded();

    if let Ok(mut cache) = state.key_cache.lock() {
        cache.insert(key, value);
    }

    state.persist_secrets()
}

/// Retrieve a secret from the in-memory cache (loaded from keychain on first access).
#[tauri::command]
pub fn keychain_get(
    state: tauri::State<'_, AIProxyState>,
    key: String,
) -> Result<Option<String>, String> {
    state.ensure_secrets_loaded();

    if let Ok(cache) = state.key_cache.lock() {
        return Ok(cache.get(&key).cloned());
    }

    Ok(None)
}

/// Delete a secret. Removes from in-memory cache and persists.
#[tauri::command]
pub fn keychain_delete(
    state: tauri::State<'_, AIProxyState>,
    key: String,
) -> Result<(), String> {
    state.ensure_secrets_loaded();

    if let Ok(mut cache) = state.key_cache.lock() {
        cache.remove(&key);
    }

    state.persist_secrets()
}
