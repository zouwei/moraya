#!/usr/bin/env bash
# One-shot verification of v0.29.0 anti-clone watermark implementation.
# Runs independently of CI and is safe to execute repeatedly.
#
# Exit 0 on all pass, non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

FAIL=0
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    green "✓ $desc"
  else
    red   "✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

blue "== Phase 1: Infrastructure =="
check "Cargo diagnostics feature declared"           grep -qE '^diagnostics *= *\[\]' src-tauri/Cargo.toml
check ".gitignore blocks watermarks.local.json"      grep -q '^watermarks.local.json$' .gitignore
check ".gitignore blocks *.ots"                      grep -q '^\*\.ots$' .gitignore
check "audit script present + executable"            test -x scripts/audit-command-order.sh
check "watermark-update script present + executable" test -x scripts/watermark-update.sh
check "AGENTS.md anti-clone section present"         grep -q '^## Anti-Clone Protection (Local Only)$' AGENTS.md

blue ""
blue "== Phase 2: Diagnostics modules =="
check "keychain_diagnostics.rs present"              test -f src-tauri/src/commands/keychain_diagnostics.rs
check "mcp_diagnostics.rs present"                   test -f src-tauri/src/commands/mcp_diagnostics.rs
check "object_storage_diagnostics.rs present"        test -f src-tauri/src/commands/object_storage_diagnostics.rs
check "mod.rs registers diagnostics modules"         grep -q 'pub mod keychain_diagnostics' src-tauri/src/commands/mod.rs

blue ""
blue "== Phase 3: Source watermarks =="
check "MORAYA_ALIGN_MARK defined"                    grep -q 'pub static MORAYA_ALIGN_MARK: u32 = 0x4D52_5941;' src-tauri/src/commands/object_storage.rs
check "MORAYA_BUFFER_MARK defined"                   grep -q 'pub static MORAYA_BUFFER_MARK: u32 = 0x4D52_5941;' src-tauri/src/commands/keychain.rs
check "ALIGN_MARK kept in binary via #[used]"        bash -c "grep -B1 'pub static MORAYA_ALIGN_MARK' src-tauri/src/commands/object_storage.rs | grep -q '#\[used\]'"
check "BUFFER_MARK kept in binary via #[used]"       bash -c "grep -B1 'pub static MORAYA_BUFFER_MARK' src-tauri/src/commands/keychain.rs | grep -q '#\[used\]'"
check "Naming watermark locals present in ai-service.ts" \
  bash -c "grep -q 'moduleRoot' src/lib/services/ai/ai-service.ts && grep -q 'outputBuffer' src/lib/services/ai/ai-service.ts && grep -q 'retryMax' src/lib/services/ai/ai-service.ts && grep -q 'assembledData' src/lib/services/ai/ai-service.ts && grep -q 'yieldBoundary' src/lib/services/ai/ai-service.ts && grep -q 'aggregatorKey' src/lib/services/ai/ai-service.ts"
check "watermarks.local.json present + valid JSON"   bash -c 'test -f watermarks.local.json && python3 -c "import json; json.load(open(\"watermarks.local.json\"))"'

blue ""
blue "== Phase 4: CI integration =="
check "ci.yml runs cargo check --features diagnostics" grep -q 'cargo check --features diagnostics' .github/workflows/ci.yml
check "ci.yml runs cargo test --features diagnostics"  grep -q 'cargo test --features diagnostics'  .github/workflows/ci.yml

blue ""
blue "== Phase 5: Behavior tests =="
blue "Running cargo test (default features)…"
( cd src-tauri && cargo test --lib 2>&1 ) | tail -2 | grep -q 'test result: ok\.' && green "✓ default cargo test passes" || { red "✗ default cargo test failed"; FAIL=$((FAIL+1)); }

blue "Running cargo test (diagnostics feature)…"
( cd src-tauri && cargo test --features diagnostics --lib 2>&1 ) | tail -2 | grep -q 'test result: ok\.' && green "✓ diagnostics cargo test passes" || { red "✗ diagnostics cargo test failed"; FAIL=$((FAIL+1)); }

blue "Running Tauri command parameter-order audit…"
if bash scripts/audit-command-order.sh > /tmp/moraya-audit.$$.txt 2>&1; then
  cov=$(grep -E '^Coverage' /tmp/moraya-audit.$$.txt | awk '{print $3}')
  green "✓ audit completed — baseline coverage = $cov"
else
  red "✗ audit script failed"
  FAIL=$((FAIL+1))
fi
rm -f /tmp/moraya-audit.$$.txt

blue ""
if [ $FAIL -eq 0 ]; then
  green "========================================"
  green "All checks passed. v0.29.0 verification OK."
  green "========================================"
  exit 0
else
  red "========================================"
  red "$FAIL check(s) failed."
  red "========================================"
  exit 1
fi
