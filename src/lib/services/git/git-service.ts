import { invoke } from '@tauri-apps/api/core';
import type {
	GitFileStatus,
	GitLogEntry,
	GitSyncStatus,
	GitUserInfo,
	GitBlameEntry,
} from './types';

let _gitInstalled: boolean | null = null;
let _gitCheckPromise: Promise<boolean> | null = null;

/**
 * Check if git is installed on the system.
 * Result is cached and checked only once per session.
 */
export async function checkGitInstalled(): Promise<boolean> {
	if (_gitInstalled !== null) return _gitInstalled;
	if (_gitCheckPromise) return _gitCheckPromise;
	_gitCheckPromise = invoke<boolean>('git_check_installed').then(
		(result) => { _gitInstalled = result; return result; },
		() => { _gitInstalled = false; return false; }
	);
	return _gitCheckPromise;
}

/**
 * Clone a remote repository to a local path.
 */
export async function gitClone(
	url: string,
	path: string,
	configId: string,
): Promise<void> {
	await invoke('git_clone', { url, path, configId });
}

/**
 * Initialize a local directory as a git repo and push to remote.
 */
export async function gitInitAndPush(
	path: string,
	url: string,
	configId: string,
	branch = 'main',
): Promise<void> {
	await invoke('git_init_and_push', { path, url, configId, branch });
}

/**
 * Pull remote changes with rebase + autostash.
 */
export async function gitPull(
	path: string,
	configId: string,
): Promise<string> {
	return invoke<string>('git_pull', { path, configId });
}

/**
 * Push local commits to remote.
 */
export async function gitPush(
	path: string,
	configId: string,
): Promise<string> {
	return invoke<string>('git_push', { path, configId });
}

/**
 * Get working directory status (modified, added, deleted, untracked files).
 */
export async function gitStatus(path: string): Promise<GitFileStatus> {
	return invoke<GitFileStatus>('git_status', { path });
}

/**
 * Get commit log entries.
 */
export async function gitLog(
	path: string,
	file?: string,
	limit?: number,
): Promise<GitLogEntry[]> {
	return invoke<GitLogEntry[]>('git_log', { path, file, limit });
}

/**
 * Get diff output.
 */
export async function gitDiff(
	path: string,
	hash1?: string,
	hash2?: string,
	file?: string,
): Promise<string> {
	return invoke<string>('git_diff', { path, hash1, hash2, file });
}

/**
 * Stage files and create a commit.
 */
export async function gitAddCommit(
	path: string,
	files: string[],
	message: string,
): Promise<string> {
	return invoke<string>('git_add_commit', { path, files, message });
}

/**
 * Get git user info (name, email) from local config.
 */
export async function gitGetUserInfo(path: string): Promise<GitUserInfo> {
	return invoke<GitUserInfo>('git_get_user_info', { path });
}

/**
 * Get sync status (ahead/behind counts) relative to remote.
 * Performs a fetch first to get up-to-date tracking info.
 */
export async function gitSyncStatus(
	path: string,
	configId: string,
): Promise<GitSyncStatus> {
	return invoke<GitSyncStatus>('git_sync_status', { path, configId });
}

/**
 * Get the current HEAD commit hash (full 40-char hex).
 */
export async function gitHeadCommit(path: string): Promise<string> {
	return invoke<string>('git_head_commit', { path });
}

/**
 * Show the contents of a file at a specific commit (v0.32.0).
 * Returns the full file content as a string. Empty string indicates the
 * file does not exist at that commit, or is binary (caller should fall
 * back to a binary-not-displayable message).
 */
export async function gitShowFile(
	path: string,
	hash: string,
	file: string,
): Promise<string> {
	return invoke<string>('git_show_file', { path, hash, file });
}

/**
 * Run `git blame --porcelain` and return parsed entries (v0.32.0).
 * Each entry corresponds to one line in the current working file.
 */
export async function gitBlame(
	path: string,
	file: string,
): Promise<GitBlameEntry[]> {
	return invoke<GitBlameEntry[]>('git_blame', { path, file });
}

/**
 * Detect if the repository is currently in the middle of a merge / rebase /
 * cherry-pick / revert operation (v0.32.1). Returns false on any error so
 * callers can use this as a safe gate without blocking valid actions.
 */
export async function gitInMerge(path: string): Promise<boolean> {
	try {
		return await invoke<boolean>('git_in_merge', { path });
	} catch {
		return false;
	}
}

/**
 * Store a git token in the OS keychain.
 */
export async function setGitToken(
	configId: string,
	token: string,
): Promise<void> {
	await invoke('keychain_set', {
		key: `git-token:${configId}`,
		value: token,
	});
}

/**
 * Store username + password credentials in the OS keychain.
 */
export async function setGitCredential(
	configId: string,
	username: string,
	password: string,
): Promise<void> {
	await invoke('keychain_set', { key: `git-username:${configId}`, value: username });
	await invoke('keychain_set', { key: `git-password:${configId}`, value: password });
}

/**
 * Remove username + password credentials from the OS keychain.
 */
export async function deleteGitCredential(configId: string): Promise<void> {
	await invoke('keychain_delete', { key: `git-username:${configId}` }).catch(() => {});
	await invoke('keychain_delete', { key: `git-password:${configId}` }).catch(() => {});
}

/**
 * Store SSH key path (and optional passphrase) in the OS keychain.
 * Storing the key path in keychain lets Rust look it up via config_id alone.
 */
export async function setGitSshAuth(
	configId: string,
	keyPath: string,
	passphrase: string,
): Promise<void> {
	await invoke('keychain_set', { key: `git-sshkey:${configId}`, value: keyPath });
	if (passphrase) {
		await invoke('keychain_set', { key: `git-sshpassphrase:${configId}`, value: passphrase });
	}
}

/**
 * Remove SSH auth credentials from the OS keychain.
 */
export async function deleteGitSshAuth(configId: string): Promise<void> {
	await invoke('keychain_delete', { key: `git-sshkey:${configId}` }).catch(() => {});
	await invoke('keychain_delete', { key: `git-sshpassphrase:${configId}` }).catch(() => {});
}

/**
 * Retrieve a git token from the OS keychain.
 */
export async function getGitToken(
	configId: string,
): Promise<string | null> {
	return invoke<string | null>('keychain_get', {
		key: `git-token:${configId}`,
	});
}

/**
 * Delete a git token from the OS keychain.
 */
export async function deleteGitToken(configId: string): Promise<void> {
	await invoke('keychain_delete', {
		key: `git-token:${configId}`,
	});
}

/**
 * Perform a full sync cycle: pull (rebase) then push.
 * Returns a summary string.
 */
export async function gitSync(
	path: string,
	configId: string,
): Promise<{ pullResult: string; pushResult: string }> {
	const pullResult = await gitPull(path, configId);
	const pushResult = await gitPush(path, configId);
	return { pullResult, pushResult };
}
