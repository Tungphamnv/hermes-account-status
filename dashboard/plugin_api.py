"""Account Status backend — mounted at /api/plugins/account-status/.

Lists every credential-pool entry (all providers) with its pool status and, for
openai-codex OAuth entries, the live ChatGPT quota windows + account email.
Tokens never leave this process.
"""

import base64
import json
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal
import threading
import subprocess
import sys
import os

_MANAGEMENT_LOCK = threading.Lock()
_LOGIN_PROCESSES = {}
_PROVIDERS = {'openai-codex', 'anthropic'}


def _load_management_pool(provider):
    from agent.credential_pool import load_pool
    return load_pool(provider)


def _move_priority(provider, credential_id, direction):
    if provider not in _PROVIDERS or direction not in {'up', 'down'}:
        raise HTTPException(400, 'Nhà cung cấp hoặc hướng không hợp lệ')
    with _MANAGEMENT_LOCK:
        pool = _load_management_pool(provider)
        entries = pool.entries()
        position = next((i for i, e in enumerate(entries) if e.id == credential_id), None)
        if position is None:
            raise HTTPException(404, 'Tài khoản không thuộc credential pool')
        target = max(0, min(len(entries) - 1, position + (-1 if direction == 'up' else 1)))
        moved = pool.move_entry(credential_id, target)
        if moved is None:
            raise HTTPException(409, 'Tài khoản đã thay đổi; hãy làm mới')
        persisted = _load_management_pool(provider).entries()
        effective = next((e for e in persisted if e.id == credential_id), None)
        if effective is None:
            raise HTTPException(409, 'Không xác nhận được thứ tự đã lưu')
        _CACHE.update(at=0.0, data=None)
        return {'order': [e.id for e in persisted], 'priority': effective.priority}


class MoveRequest(BaseModel):
    provider: Literal['openai-codex', 'anthropic']
    credential_id: str = Field(min_length=1, max_length=128)
    direction: Literal['up', 'down']


class AddRequest(BaseModel):
    provider: Literal['openai-codex', 'anthropic']


def _start_login(provider):
    # Separate native console: Claude requires a code entered DIRECTLY by the
    # user. No stdin/stdout pipes, captured codes, tokens, or URLs in the API.
    if provider not in _PROVIDERS:
        raise HTTPException(400, 'Nhà cung cấp không hợp lệ')
    if os.name != 'nt':
        raise HTTPException(501, 'Luồng đăng nhập cửa sổ riêng hiện hỗ trợ Windows')
    with _MANAGEMENT_LOCK:
        if any(p.poll() is None for p in _LOGIN_PROCESSES.values()):
            raise HTTPException(409, 'Đang đăng nhập; hoàn tất hoặc đóng cửa sổ trước')
        command = [sys.executable, '-m', 'hermes_cli.main', 'auth', 'add', provider, '--type', 'oauth']
        if provider == 'openai-codex':
            command.append('--browser')
        try:
            process = subprocess.Popen(command, creationflags=subprocess.CREATE_NEW_CONSOLE,
                                       env=os.environ.copy())
        except OSError:
            raise HTTPException(503, 'Không mở được cửa sổ đăng nhập') from None
        _LOGIN_PROCESSES[provider] = process
        return {'state': 'started', 'provider': provider}

from starlette.concurrency import run_in_threadpool

router = APIRouter()

_CACHE: Dict[str, Any] = {"at": 0.0, "data": None}
_TTL = 50.0


def _jwt_claims(token: str) -> dict:
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part))
    except Exception:
        return {}


def _email_plan(token: str) -> tuple[Optional[str], Optional[str]]:
    c = _jwt_claims(token)
    prof = c.get("https://api.openai.com/profile") or {}
    auth = c.get("https://api.openai.com/auth") or {}
    return (prof.get("email") or c.get("email"), auth.get("chatgpt_plan_type"))


def _codex_usage(entry) -> Dict[str, Any]:
    from agent.account_usage import (_codex_backend_urls, _codex_headers, _get_json,
                                     _usage_windows, _codex_window_labels)
    token = getattr(entry, "access_token", None) or entry.runtime_api_key
    base = str(getattr(entry, "base_url", None) or "https://chatgpt.com/backend-api/codex")
    payload = _get_json(_codex_backend_urls(base)[0], _codex_headers(token, None), timeout=15.0)
    rl = payload.get("rate_limit") or {}
    wins = _usage_windows(rl, _codex_window_labels(rl), "used_percent", "reset_at")
    return {
        "plan": payload.get("plan_type"),
        "windows": [{"label": w.label, "used_percent": w.used_percent,
                     "reset_at": w.reset_at.isoformat() if w.reset_at else None} for w in wins],
    }


def _entry_row(provider: str, idx: int, e, current_id: Optional[str]) -> Dict[str, Any]:
    g = lambda k: getattr(e, k, None)
    row: Dict[str, Any] = {
        "provider": provider, "index": idx + 1, "id": g("id"), "label": g("label"),
        "auth_type": g("auth_type"), "priority": g("priority"),
        "status": g("last_status") or "unknown", "error_code": g("last_error_code"),
        "error_reason": g("last_error_reason") or g("failure_reason") if g("last_status") == "exhausted" else None,
        "reset_at": g("last_error_reset_at"), "requests": g("request_count"),
        "current": g("id") == current_id, "email": None, "plan": None, "windows": [], "usage_error": None,
    }
    if provider == "openai-codex" and g("auth_type") == "oauth":
        tok = g("access_token") or ""
        row["email"], row["plan"] = _email_plan(tok)
        try:
            u = _codex_usage(e)
            row["plan"] = u["plan"] or row["plan"]
            row["windows"] = u["windows"]
        except Exception as exc:  # show, don't crash
            row["usage_error"] = str(exc)[:160]
    return row


def _collect() -> Dict[str, Any]:
    from agent.credential_pool import load_pool
    from hermes_cli.auth import read_credential_pool
    providers = list((read_credential_pool(None) or {}).keys())
    jobs = []
    for p in providers:
        try:
            pool = load_pool(p)
        except Exception:
            continue
        entries = pool.entries()
        cur = pool.current() or pool.peek()
        cur_id = getattr(cur, "id", None)
        for i, e in enumerate(entries):
            jobs.append((p, i, e, cur_id))
    import contextvars
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(contextvars.copy_context().run, _entry_row, *a) for a in jobs]
        rows = [f.result() for f in futs]
    if "anthropic" not in providers:
        rows.append(_claude_row())
    return {"fetched_at": time.time(), "accounts": rows}


def _claude_row() -> Dict[str, Any]:
    """Claude Pro via OAuth (Hermes store or Claude Code's ~/.claude creds)."""
    row: Dict[str, Any] = {"provider": "anthropic", "index": 1, "id": "claude-oauth", "label": "Claude Pro",
                           "auth_type": "oauth", "priority": 0, "status": "unknown", "error_code": None,
                           "error_reason": None, "reset_at": None, "requests": None, "current": False,
                           "email": None, "plan": None, "windows": [], "usage_error": None}
    try:
        from pathlib import Path
        from agent.account_usage import _get_json, _usage_windows
        oauth = json.load(open(Path.home() / ".claude" / ".credentials.json", encoding="utf-8")).get("claudeAiOauth") or {}
        row["plan"] = oauth.get("subscriptionType")
        token = oauth.get("accessToken")
        if not token:
            row["usage_error"] = "Chưa đăng nhập Claude Code"
            return row
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json",
                   "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0"}
        payload = _get_json("https://api.anthropic.com/api/oauth/usage", headers, timeout=15.0)
        wins = _usage_windows(payload, (("five_hour", "Session"), ("seven_day", "Weekly")),
                              "utilization", "resets_at", fraction=True)
        row["windows"] = [{"label": w.label, "used_percent": w.used_percent,
                           "reset_at": w.reset_at.isoformat() if w.reset_at else None} for w in wins]
        row["status"] = "ok"
    except Exception as exc:
        row["usage_error"] = ("Token Claude Code hết hạn — mở Claude Code một lần để làm mới"
                              if "401" in str(exc) else str(exc)[:160])
    return row


@router.post('/priority')
async def priority(request: MoveRequest):
    return await run_in_threadpool(_move_priority, request.provider, request.credential_id, request.direction)


@router.post('/accounts/add')
async def add_account(request: AddRequest):
    return await run_in_threadpool(_start_login, request.provider)


@router.get("/status")
async def status(force: bool = False):
    now = time.time()
    if force or not _CACHE["data"] or now - _CACHE["at"] > _TTL:
        _CACHE["data"] = await run_in_threadpool(_collect)
        _CACHE["at"] = now
    return _CACHE["data"]
