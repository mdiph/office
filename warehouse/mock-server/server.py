#!/usr/bin/env python3
"""
Local mock backend for the Warehouse Management app.

Implements the exact same {action, token, payload} JSON protocol as the Google
Apps Script backend, backed by a local JSON file (mock-db.json). It is deliberately
thin: passwords are compared in plain text, there is no real locking or crypto.
Its only job is to let you develop and click through the whole frontend offline.

Usage:
    python3 server.py                # serves on http://localhost:3000
    python3 server.py --port 4000
    python3 server.py --reset        # rewrite mock-db.json from mock-db.seed.json if present, else keep

Point the frontend at it by setting API_BASE in warehouse/config.js to
"http://localhost:3000".
"""

import argparse
import copy
import json
import os
import secrets
import sys
import threading
import uuid
from datetime import datetime, timezone, date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "mock-db.json")          # working copy (gitignored)
SEED_PATH = os.path.join(HERE, "mock-db.seed.json")   # pristine committed seed

STATUSES = ["Available", "Borrowed", "Issued-out", "Under inspection", "Maintenance", "Retired", "Lost"]
CONDITIONS = ["New", "Good", "Fair", "Damaged", "Needs repair", "Incomplete"]
ROLES = ["Admin", "Warehouse Staff", "Engineer", "Viewer"]
# Units in these statuses no longer count as live stock (they stay in the sheet for records).
TERMINAL_STATUSES = ("Retired", "Lost")

SESSION_IDLE_MS = 8 * 60 * 60 * 1000
SESSION_ABS_MS = 24 * 60 * 60 * 1000
MAX_FAILED = 5
LOCK_MINUTES = 15
EXPORT_CAP = 50000

_lock = threading.RLock()


# --------------------------------------------------------------------------- db
def ensure_db(reset=False):
    if reset or not os.path.exists(DB_PATH):
        with open(SEED_PATH, "r", encoding="utf-8") as fh:
            seed = fh.read()
        with open(DB_PATH, "w", encoding="utf-8") as fh:
            fh.write(seed)


def load_db():
    with open(DB_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_db(db):
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(db, fh, indent=2)
    os.replace(tmp, DB_PATH)


# ---------------------------------------------------------------------- helpers
def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def today_str():
    return date.today().isoformat()


def new_uuid():
    return str(uuid.uuid4())


def parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


class ApiError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------------- rbac
# Capability -> set of roles allowed. Checked on every mutating / sensitive action.
CAPS = {
    "view": {"Admin", "Warehouse Staff", "Engineer", "Viewer"},
    "export": {"Admin", "Warehouse Staff", "Engineer"},
    "export_audit": {"Admin"},
    "inventory_write": {"Admin", "Warehouse Staff"},
    "receive": {"Admin", "Warehouse Staff"},
    "issue": {"Admin", "Warehouse Staff"},
    "return": {"Admin", "Warehouse Staff"},
    "borrow_self": {"Admin", "Warehouse Staff", "Engineer"},
    "borrow_behalf": {"Admin", "Warehouse Staff"},
    "users": {"Admin"},
    "audit": {"Admin"},
    "config_write": {"Admin"},
}


def require(role, cap):
    if role not in CAPS.get(cap, set()):
        raise ApiError("FORBIDDEN", "Your role does not permit this action.")


# ------------------------------------------------------------------- auth layer
def find_user(db, email):
    for u in db["users"]:
        if u["email"].lower() == (email or "").lower():
            return u
    return None


def do_login(db, payload, ctx):
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    user = find_user(db, email)
    if not user or not user.get("active"):
        _audit(db, None, None, "LOGIN", "user", email, "Unknown or inactive user", "denied", ctx)
        raise ApiError("AUTH_FAILED", "Invalid credentials.")
    locked_until = parse_iso(user.get("lockedUntil"))
    if locked_until and locked_until > datetime.now(timezone.utc):
        raise ApiError("LOCKED", "Account locked. Try again later.")
    if password != user.get("password"):
        user["failedCount"] = user.get("failedCount", 0) + 1
        if user["failedCount"] >= MAX_FAILED:
            user["lockedUntil"] = (datetime.now(timezone.utc) + timedelta(minutes=LOCK_MINUTES)).isoformat()
            user["failedCount"] = 0
        _audit(db, email, user["role"], "LOGIN", "user", email, "Bad password", "denied", ctx)
        raise ApiError("AUTH_FAILED", "Invalid credentials.")
    user["failedCount"] = 0
    user["lockedUntil"] = None
    token = secrets.token_hex(32)
    ts = now_iso()
    db["sessions"].append({
        "token": token, "userEmail": user["email"], "createdAt": ts,
        "lastSeenAt": ts, "userAgent": ctx.get("userAgent", ""),
    })
    _audit(db, user["email"], user["role"], "LOGIN", "user", user["email"], "Login", "success", ctx)
    return {
        "token": token,
        "user": {"email": user["email"], "name": user["name"], "role": user["role"]},
    }


def auth(db, token, ctx):
    if not token:
        raise ApiError("AUTH_EXPIRED", "Not signed in.")
    sess = next((s for s in db["sessions"] if s["token"] == token), None)
    if not sess:
        raise ApiError("AUTH_EXPIRED", "Session not found. Please sign in again.")
    now = datetime.now(timezone.utc)
    created = parse_iso(sess["createdAt"])
    seen = parse_iso(sess["lastSeenAt"])
    if (now - created).total_seconds() * 1000 > SESSION_ABS_MS or \
       (now - seen).total_seconds() * 1000 > SESSION_IDLE_MS:
        db["sessions"] = [s for s in db["sessions"] if s["token"] != token]
        raise ApiError("AUTH_EXPIRED", "Session expired. Please sign in again.")
    sess["lastSeenAt"] = now_iso()
    user = find_user(db, sess["userEmail"])
    if not user or not user.get("active"):
        raise ApiError("AUTH_EXPIRED", "User no longer active.")
    return user


def do_logout(db, user, payload, ctx):
    token = ctx.get("token")
    db["sessions"] = [s for s in db["sessions"] if s["token"] != token]
    _audit(db, user["email"], user["role"], "LOGOUT", "user", user["email"], "Logout", "success", ctx)
    return {"ok": True}


def do_session(db, user, payload, ctx):
    return {"user": {"email": user["email"], "name": user["name"], "role": user["role"]}}


def do_change_password(db, user, payload, ctx):
    if (payload.get("currentPassword") or "") != user.get("password"):
        raise ApiError("AUTH_FAILED", "Current password is incorrect.")
    npw = payload.get("newPassword") or ""
    if len(npw) < 8:
        raise ApiError("VALIDATION", "New password must be at least 8 characters.")
    user["password"] = npw
    _audit(db, user["email"], user["role"], "USER_CHANGE", "user", user["email"], "Changed own password", "success", ctx)
    return {"ok": True}


# ------------------------------------------------------------------------ users
def _user_public(u):
    return {k: u[k] for k in ("email", "name", "role", "active", "createdAt")}


def do_list_users(db, user, payload, ctx):
    require(user["role"], "users")
    return {"users": [_user_public(u) for u in db["users"]]}


def do_create_user(db, user, payload, ctx):
    require(user["role"], "users")
    email = (payload.get("email") or "").strip().lower()
    name = (payload.get("name") or "").strip()
    role = payload.get("role") or ""
    password = payload.get("password") or ""
    if not email or not name or role not in ROLES:
        raise ApiError("VALIDATION", "Name, email and a valid role are required.")
    if len(password) < 8:
        raise ApiError("VALIDATION", "Password must be at least 8 characters.")
    if find_user(db, email):
        raise ApiError("CONFLICT", "A user with that email already exists.")
    u = {
        "email": email, "name": name, "role": role, "active": True,
        "hash": "mock", "password": password, "failedCount": 0,
        "lockedUntil": None, "createdAt": now_iso(),
    }
    db["users"].append(u)
    _audit(db, user["email"], user["role"], "USER_CHANGE", "user", email, f"Created user ({role})", "success", ctx)
    return {"user": _user_public(u)}


def do_update_user(db, user, payload, ctx):
    require(user["role"], "users")
    target = find_user(db, payload.get("email"))
    if not target:
        raise ApiError("NOT_FOUND", "User not found.")
    changes = []
    if "name" in payload and payload["name"]:
        target["name"] = payload["name"].strip(); changes.append("name")
    if "role" in payload and payload["role"]:
        if payload["role"] not in ROLES:
            raise ApiError("VALIDATION", "Invalid role.")
        target["role"] = payload["role"]; changes.append("role")
    if "active" in payload:
        target["active"] = bool(payload["active"]); changes.append("active")
        if not target["active"]:
            db["sessions"] = [s for s in db["sessions"] if s["userEmail"] != target["email"]]
    _audit(db, user["email"], user["role"], "USER_CHANGE", "user", target["email"],
           "Updated " + ", ".join(changes), "success", ctx)
    return {"user": _user_public(target)}


def do_reset_password(db, user, payload, ctx):
    require(user["role"], "users")
    target = find_user(db, payload.get("email"))
    if not target:
        raise ApiError("NOT_FOUND", "User not found.")
    npw = payload.get("newPassword") or ""
    if len(npw) < 8:
        raise ApiError("VALIDATION", "Password must be at least 8 characters.")
    target["password"] = npw
    target["failedCount"] = 0
    target["lockedUntil"] = None
    _audit(db, user["email"], user["role"], "USER_CHANGE", "user", target["email"], "Reset password", "success", ctx)
    return {"ok": True}


def do_force_logout(db, user, payload, ctx):
    require(user["role"], "users")
    target = find_user(db, payload.get("email"))
    if not target:
        raise ApiError("NOT_FOUND", "User not found.")
    db["sessions"] = [s for s in db["sessions"] if s["userEmail"] != target["email"]]
    _audit(db, user["email"], user["role"], "USER_CHANGE", "user", target["email"], "Forced logout", "success", ctx)
    return {"ok": True}


# ----------------------------------------------------------------------- config
def do_get_config(db, user, payload, ctx):
    c = db["config"]
    return {
        "categories": sorted(db["categories"]),
        "locations": sorted(db["locations"]),
        "lowStockThreshold": c["lowStockThreshold"],
        "overdueGraceDays": c["overdueGraceDays"],
        "statuses": STATUSES,
        "conditions": CONDITIONS,
        "roles": ROLES,
    }


def do_update_config(db, user, payload, ctx):
    require(user["role"], "config_write")
    c = db["config"]
    if "lowStockThreshold" in payload:
        c["lowStockThreshold"] = max(0, int(payload["lowStockThreshold"]))
    if "overdueGraceDays" in payload:
        c["overdueGraceDays"] = max(0, int(payload["overdueGraceDays"]))
    _audit(db, user["email"], user["role"], "CONFIG", "config", "-", "Updated config", "success", ctx)
    return do_get_config(db, user, payload, ctx)


def do_add_category(db, user, payload, ctx):
    require(user["role"], "config_write")
    name = (payload.get("name") or "").strip()
    if not name:
        raise ApiError("VALIDATION", "Category name required.")
    if name not in db["categories"]:
        db["categories"].append(name)
    _audit(db, user["email"], user["role"], "CONFIG", "category", name, "Added category", "success", ctx)
    return {"categories": sorted(db["categories"])}


def do_rename_category(db, user, payload, ctx):
    require(user["role"], "config_write")
    old = payload.get("old")
    new = (payload.get("new") or "").strip()
    if not new:
        raise ApiError("VALIDATION", "New category name required.")
    if old not in db["categories"]:
        raise ApiError("NOT_FOUND", "Category not found.")
    if new != old and new in db["categories"]:
        raise ApiError("CONFLICT", "A category with that name already exists.")
    db["categories"] = [new if c == old else c for c in db["categories"]]
    for s in db["inventory"]:
        if s["category"] == old:
            s["category"] = new
    _audit(db, user["email"], user["role"], "CONFIG", "category", new, "Renamed category %s -> %s" % (old, new), "success", ctx)
    return {"categories": sorted(db["categories"])}


def do_delete_category(db, user, payload, ctx):
    require(user["role"], "config_write")
    name = payload.get("name")
    if name not in db["categories"]:
        raise ApiError("NOT_FOUND", "Category not found.")
    in_use = sum(1 for s in db["inventory"] if s["category"] == name)
    if in_use:
        raise ApiError("BLOCKED", "Category is used by %d item(s). Reassign them first." % in_use)
    db["categories"] = [c for c in db["categories"] if c != name]
    _audit(db, user["email"], user["role"], "CONFIG", "category", name, "Deleted category", "success", ctx)
    return {"categories": sorted(db["categories"])}


def do_add_location(db, user, payload, ctx):
    require(user["role"], "config_write")
    code = (payload.get("code") or "").strip().upper()
    if not code:
        raise ApiError("VALIDATION", "Location code required.")
    if code not in db["locations"]:
        db["locations"].append(code)
    _audit(db, user["email"], user["role"], "CONFIG", "location", code, "Added location", "success", ctx)
    return {"locations": sorted(db["locations"])}


def do_rename_location(db, user, payload, ctx):
    require(user["role"], "config_write")
    old = payload.get("old")
    new = (payload.get("new") or "").strip().upper()
    if not new:
        raise ApiError("VALIDATION", "New location code required.")
    if old not in db["locations"]:
        raise ApiError("NOT_FOUND", "Location not found.")
    if new != old and new in db["locations"]:
        raise ApiError("CONFLICT", "A location with that code already exists.")
    db["locations"] = [new if c == old else c for c in db["locations"]]
    for u in db["units"]:
        if u.get("location") == old:
            u["location"] = new
    _audit(db, user["email"], user["role"], "CONFIG", "location", new, "Renamed location %s -> %s" % (old, new), "success", ctx)
    return {"locations": sorted(db["locations"])}


def do_delete_location(db, user, payload, ctx):
    require(user["role"], "config_write")
    code = payload.get("code")
    if code not in db["locations"]:
        raise ApiError("NOT_FOUND", "Location not found.")
    in_use = sum(1 for u in db["units"] if u.get("location") == code)
    if in_use:
        raise ApiError("BLOCKED", "Location holds %d unit(s). Move them first." % in_use)
    db["locations"] = [c for c in db["locations"] if c != code]
    _audit(db, user["email"], user["role"], "CONFIG", "location", code, "Deleted location", "success", ctx)
    return {"locations": sorted(db["locations"])}


# -------------------------------------------------------------------- inventory
def next_counter(db, key):
    db["counters"][key] = db["counters"].get(key, 0) + 1
    return db["counters"][key]


def gen_sku_code(db, category):
    seq = next_counter(db, "SKU")
    prefix = "".join(ch for ch in (category or "GEN").upper() if ch.isalpha())[:3].ljust(3, "X")
    return f"WH-{prefix}{seq:04d}"


def sku_by_code(db, code):
    return next((s for s in db["inventory"] if s["itemCode"] == code), None)


def units_of(db, code):
    return [u for u in db["units"] if u["itemCode"] == code]


def do_list_inventory(db, user, payload, ctx):
    return {
        "skus": [s for s in db["inventory"]],
        "units": [u for u in db["units"]],
    }


def do_get_item(db, user, payload, ctx):
    code = payload.get("itemCode")
    sku = sku_by_code(db, code)
    if not sku:
        raise ApiError("NOT_FOUND", "Item not found.")
    return {
        "sku": sku,
        "units": units_of(db, code),
        "history": _history_rows(db, item_code=code),
    }


def do_create_sku(db, user, payload, ctx):
    require(user["role"], "inventory_write")
    name = (payload.get("name") or "").strip()
    category = (payload.get("category") or "").strip()
    tracking = payload.get("trackingType")
    if not name or category not in db["categories"] or tracking not in ("serialized", "quantity"):
        raise ApiError("VALIDATION", "Name, known category and tracking type are required.")
    code = (payload.get("itemCode") or "").strip() or gen_sku_code(db, category)
    if sku_by_code(db, code):
        raise ApiError("CONFLICT", "Item code already exists.")
    loc = payload.get("location")
    if loc and loc not in db["locations"]:
        raise ApiError("VALIDATION", "Unknown location.")
    sku = {
        "itemCode": code, "name": name, "category": category,
        "brand": (payload.get("brand") or "").strip(),
        "model": (payload.get("model") or "").strip(),
        "specification": (payload.get("specification") or "").strip(),
        "description": (payload.get("description") or "").strip(),
        "trackingType": tracking,
        "quantityOnHand": 0,
        "photoFileId": payload.get("photoFileId"),
        "active": True,
        "createdAt": now_iso(),
        "createdBy": user["email"],
    }
    db["inventory"].append(sku)
    _audit(db, user["email"], user["role"], "ITEM_ADD", "sku", code, f"Created SKU {name}", "success", ctx)
    return {"sku": sku}


def do_update_sku(db, user, payload, ctx):
    require(user["role"], "inventory_write")
    sku = sku_by_code(db, payload.get("itemCode"))
    if not sku:
        raise ApiError("NOT_FOUND", "Item not found.")
    patch = payload.get("patch") or {}
    if "trackingType" in patch and patch["trackingType"] != sku["trackingType"]:
        if any(t["itemCode"] == sku["itemCode"] for t in db["transactions"]):
            raise ApiError("BLOCKED", "Cannot change tracking type once transactions exist.")
        sku["trackingType"] = patch["trackingType"]
    for f in ("name", "brand", "model", "specification", "description", "photoFileId"):
        if f in patch:
            sku[f] = patch[f]
    if "category" in patch:
        if patch["category"] not in db["categories"]:
            raise ApiError("VALIDATION", "Unknown category.")
        sku["category"] = patch["category"]
    _audit(db, user["email"], user["role"], "ITEM_EDIT", "sku", sku["itemCode"], "Edited SKU", "success", ctx)
    return {"sku": sku}


def do_delete_sku(db, user, payload, ctx):
    require(user["role"], "inventory_write")
    sku = sku_by_code(db, payload.get("itemCode"))
    if not sku:
        raise ApiError("NOT_FOUND", "Item not found.")
    if sku["trackingType"] == "quantity" and sku["quantityOnHand"] > 0:
        raise ApiError("BLOCKED", "Cannot delete: stock on hand.")
    open_units = [u for u in units_of(db, sku["itemCode"]) if u["status"] not in TERMINAL_STATUSES]
    if sku["trackingType"] == "serialized" and open_units:
        raise ApiError("BLOCKED", "Cannot delete: active units exist.")
    sku["active"] = False
    _audit(db, user["email"], user["role"], "ITEM_DELETE", "sku", sku["itemCode"], "Soft-deleted SKU", "success", ctx)
    return {"ok": True}


def do_add_units(db, user, payload, ctx):
    require(user["role"], "inventory_write")
    sku = sku_by_code(db, payload.get("itemCode"))
    if not sku:
        raise ApiError("NOT_FOUND", "Item not found.")
    if sku["trackingType"] != "serialized":
        raise ApiError("VALIDATION", "This item is quantity-tracked; use restock.")
    created = []
    existing = len(units_of(db, sku["itemCode"]))
    for i, spec in enumerate(payload.get("units") or [], start=1):
        cond = spec.get("condition") or "Good"
        loc = spec.get("location")
        if cond not in CONDITIONS:
            raise ApiError("VALIDATION", "Unknown condition.")
        if not loc or loc not in db["locations"]:
            raise ApiError("VALIDATION", "Each unit needs a known location.")
        uid = f"{sku['itemCode']}-U{existing + i:02d}"
        u = {
            "unitId": uid, "itemCode": sku["itemCode"],
            "serialNumber": (spec.get("serialNumber") or "").strip() or None,
            "condition": cond, "status": "Available", "location": loc,
            "currentHolder": None, "photoFileId": spec.get("photoFileId"),
            "createdAt": now_iso(),
        }
        db["units"].append(u)
        created.append(u)
    _audit(db, user["email"], user["role"], "ITEM_EDIT", "sku", sku["itemCode"],
           f"Added {len(created)} unit(s)", "success", ctx)
    return {"units": created}


def do_update_unit(db, user, payload, ctx):
    require(user["role"], "inventory_write")
    u = next((x for x in db["units"] if x["unitId"] == payload.get("unitId")), None)
    if not u:
        raise ApiError("NOT_FOUND", "Unit not found.")
    patch = payload.get("patch") or {}
    if "condition" in patch:
        if patch["condition"] not in CONDITIONS:
            raise ApiError("VALIDATION", "Unknown condition.")
        u["condition"] = patch["condition"]
    if "location" in patch:
        if patch["location"] not in db["locations"]:
            raise ApiError("VALIDATION", "Unknown location.")
        u["location"] = patch["location"]
    if "serialNumber" in patch:
        u["serialNumber"] = (patch["serialNumber"] or "").strip() or None
    if "photoFileId" in patch:
        u["photoFileId"] = patch["photoFileId"]
    _audit(db, user["email"], user["role"], "ITEM_EDIT", "unit", u["unitId"], "Edited unit", "success", ctx)
    return {"unit": u}


# ------------------------------------------------------------------ transactions
def _mk_txn(**kw):
    base = {
        "txnId": new_uuid(), "slipNo": None, "timestamp": now_iso(),
        "txnDate": today_str(), "type": None, "itemCode": None, "unitId": None,
        "qty": 0, "qtyDamaged": 0, "fromLocation": None, "toLocation": None,
        "party": None, "employeeId": None, "department": None, "project": None,
        "purpose": None, "destination": None, "expectedReturnDate": None,
        "actualReturnDate": None, "condition": None, "requiresInspection": False,
        "notes": None, "processedBy": None, "linkedTxnId": None,
    }
    base.update(kw)
    return base


def do_receive(db, user, payload, ctx):
    require(user["role"], "receive")
    mode = payload.get("mode")
    txn_date = payload.get("txnDate") or today_str()
    if mode == "new":
        res = do_create_sku(db, user, payload, ctx)
        sku = res["sku"]
    elif mode == "restock":
        sku = sku_by_code(db, payload.get("itemCode"))
        if not sku or not sku["active"]:
            raise ApiError("NOT_FOUND", "Item not found.")
    else:
        raise ApiError("VALIDATION", "mode must be 'new' or 'restock'.")

    to_loc = payload.get("location")
    if sku["trackingType"] == "serialized":
        unit_specs = payload.get("units") or []
        if not unit_specs:
            raise ApiError("VALIDATION", "Provide at least one unit.")
        added = do_add_units(db, user, {"itemCode": sku["itemCode"], "units": unit_specs}, ctx)["units"]
        qty = len(added)
        to_loc = added[0]["location"]
    else:
        qty = int(payload.get("qty") or 0)
        if qty <= 0:
            raise ApiError("VALIDATION", "Quantity must be positive.")
        if to_loc and to_loc not in db["locations"]:
            raise ApiError("VALIDATION", "Unknown location.")
        sku["quantityOnHand"] += qty

    txn = _mk_txn(type="RECEIVE", itemCode=sku["itemCode"], qty=qty, txnDate=txn_date,
                  toLocation=to_loc, purpose=payload.get("purpose") or "Received",
                  notes=payload.get("notes"), processedBy=user["email"])
    db["transactions"].append(txn)
    _audit(db, user["email"], user["role"], "RECEIVE", "sku", sku["itemCode"],
           f"Received {qty} ({mode})", "success", ctx)
    return {"txn": txn, "sku": sku}


def _resolve_target(db, payload):
    """Returns (sku, unit_or_None). Validates quantity availability handled by caller."""
    sku = sku_by_code(db, payload.get("itemCode"))
    if not sku or not sku["active"]:
        raise ApiError("NOT_FOUND", "Item not found.")
    unit = None
    if sku["trackingType"] == "serialized":
        unit = next((u for u in db["units"] if u["unitId"] == payload.get("unitId")), None)
        if not unit:
            raise ApiError("VALIDATION", "Select a specific unit.")
    return sku, unit


def do_issue(db, user, payload, ctx):
    require(user["role"], "issue")
    sku, unit = _resolve_target(db, payload)
    recipient = (payload.get("recipient") or "").strip()
    department = (payload.get("department") or "").strip()
    purpose = (payload.get("purpose") or "").strip()
    if not recipient or not department or not purpose:
        raise ApiError("VALIDATION", "Recipient, department and purpose are required.")
    exp = payload.get("expectedReturnDate") or None
    slip = f"ISS-{next_counter(db, 'ISS'):06d}"
    notes = (payload.get("notes") or "").strip()
    permanent_unit = False
    if unit:
        if unit["status"] != "Available":
            raise ApiError("BLOCKED", f"Unit is {unit['status']}, not Available.")
        qty = 1
        if exp:
            # Loan: unit stays, tracked as Issued-out until returned.
            unit["status"] = "Issued-out"
            unit["currentHolder"] = recipient
        else:
            # Permanent issue (sold / consumed): the unit leaves the database.
            # The ISSUE transaction is the only record from here on.
            permanent_unit = True
            sn = unit.get("serialNumber")
            trace = f"S/N {sn}" if sn else "no serial"
            notes = f"{trace}; condition {unit['condition']} at issue" + (f". {notes}" if notes else "")
            db["units"] = [u for u in db["units"] if u["unitId"] != unit["unitId"]]
    else:
        qty = int(payload.get("qty") or 0)
        if qty <= 0:
            raise ApiError("VALIDATION", "Quantity must be positive.")
        if qty > sku["quantityOnHand"]:
            raise ApiError("BLOCKED", "Not enough stock on hand.")
        sku["quantityOnHand"] -= qty
    txn = _mk_txn(type="ISSUE", itemCode=sku["itemCode"], unitId=unit["unitId"] if unit else None,
                  qty=qty, slipNo=slip, txnDate=payload.get("txnDate") or today_str(),
                  party=recipient, department=department, destination=payload.get("destination"),
                  purpose=purpose, expectedReturnDate=exp, notes=notes or None,
                  condition=unit["condition"] if unit else None, processedBy=user["email"])
    db["transactions"].append(txn)
    verb = "Issued (permanent, removed)" if permanent_unit else "Issued"
    _audit(db, user["email"], user["role"], "ISSUE", "sku", sku["itemCode"],
           f"{verb} {qty} to {recipient} ({slip})", "success", ctx)
    return {"txn": txn}


def do_borrow(db, user, payload, ctx):
    on_behalf = bool(payload.get("onBehalf"))
    require(user["role"], "borrow_behalf" if on_behalf else "borrow_self")
    sku, unit = _resolve_target(db, payload)
    borrower = (payload.get("borrowerName") or "").strip()
    emp = (payload.get("employeeId") or "").strip()
    department = (payload.get("department") or "").strip()
    purpose = (payload.get("purpose") or "").strip()
    exp = payload.get("expectedReturnDate") or None
    if not borrower or not emp or not department or not purpose or not exp:
        raise ApiError("VALIDATION", "Borrower, employee ID, department, purpose and expected return date are required.")
    slip = f"BRW-{next_counter(db, 'BRW'):06d}"
    if unit:
        if unit["status"] != "Available":
            raise ApiError("BLOCKED", f"Unit is {unit['status']}, not Available.")
        unit["status"] = "Borrowed"
        unit["currentHolder"] = borrower
        qty = 1
    else:
        qty = int(payload.get("qty") or 0)
        if qty <= 0:
            raise ApiError("VALIDATION", "Quantity must be positive.")
        if qty > sku["quantityOnHand"]:
            raise ApiError("BLOCKED", "Not enough stock on hand.")
        sku["quantityOnHand"] -= qty
    txn = _mk_txn(type="BORROW", itemCode=sku["itemCode"], unitId=unit["unitId"] if unit else None,
                  qty=qty, slipNo=slip, txnDate=payload.get("borrowDate") or today_str(),
                  party=borrower, employeeId=emp, department=department,
                  project=payload.get("project"), purpose=purpose,
                  expectedReturnDate=exp, processedBy=user["email"])
    db["transactions"].append(txn)
    _audit(db, user["email"], user["role"], "BORROW", "sku", sku["itemCode"],
           f"Borrowed {qty} to {borrower} ({slip}), due {exp}", "success", ctx)
    return {"txn": txn}


def _outstanding_qty(db, borrow_txn):
    returned = sum((t.get("qty", 0) + t.get("qtyDamaged", 0))
                   for t in db["transactions"]
                   if t["type"] == "RETURN" and t.get("linkedTxnId") == borrow_txn["txnId"])
    return borrow_txn["qty"] - returned


def do_return(db, user, payload, ctx):
    require(user["role"], "return")
    btxn = next((t for t in db["transactions"]
                 if t["txnId"] == payload.get("borrowTxnId") and t["type"] == "BORROW"), None)
    if not btxn:
        raise ApiError("NOT_FOUND", "Borrow transaction not found.")
    outstanding = _outstanding_qty(db, btxn)
    if outstanding <= 0:
        raise ApiError("BLOCKED", "This borrow is already fully returned.")
    condition = payload.get("condition") or "Good"
    if condition not in CONDITIONS:
        raise ApiError("VALIDATION", "Unknown condition.")
    requires_inspection = bool(payload.get("requiresInspection")) or condition != "Good"
    returned_by = (payload.get("returnedBy") or "").strip() or btxn["party"]
    sku = sku_by_code(db, btxn["itemCode"])

    if btxn.get("unitId"):
        unit = next((u for u in db["units"] if u["unitId"] == btxn["unitId"]), None)
        qty_good, qty_damaged = (0, 1) if condition != "Good" else (1, 0)
        if unit:
            unit["currentHolder"] = None
            unit["condition"] = condition
            unit["status"] = "Under inspection" if requires_inspection else "Available"
    else:
        qty_good = int(payload.get("qtyGood") or 0)
        qty_damaged = int(payload.get("qtyDamaged") or 0)
        if qty_good + qty_damaged <= 0:
            raise ApiError("VALIDATION", "Enter a returned quantity.")
        if qty_good + qty_damaged > outstanding:
            raise ApiError("BLOCKED", f"Cannot return more than outstanding ({outstanding}).")
        sku["quantityOnHand"] += qty_good  # damaged units are written off

    txn = _mk_txn(type="RETURN", itemCode=btxn["itemCode"], unitId=btxn.get("unitId"),
                  qty=qty_good, qtyDamaged=qty_damaged,
                  txnDate=payload.get("returnDate") or today_str(),
                  actualReturnDate=payload.get("returnDate") or today_str(),
                  party=returned_by, condition=condition, requiresInspection=requires_inspection,
                  notes=payload.get("notes"), processedBy=user["email"], linkedTxnId=btxn["txnId"])
    db["transactions"].append(txn)
    _audit(db, user["email"], user["role"], "RETURN", "sku", btxn["itemCode"],
           f"Returned against {btxn.get('slipNo')} ({condition})", "success", ctx)
    return {"txn": txn}


def do_clear_inspection(db, user, payload, ctx):
    require(user["role"], "return")
    unit = next((u for u in db["units"] if u["unitId"] == payload.get("unitId")), None)
    if not unit:
        raise ApiError("NOT_FOUND", "Unit not found.")
    if unit["status"] != "Under inspection":
        raise ApiError("BLOCKED", "Unit is not under inspection.")
    outcome = payload.get("outcome")
    if outcome not in ("Available", "Maintenance", "Retired"):
        raise ApiError("VALIDATION", "outcome must be Available, Maintenance or Retired.")
    unit["status"] = outcome
    txn = _mk_txn(type="ADJUST", itemCode=unit["itemCode"], unitId=unit["unitId"], qty=0,
                  purpose="Inspection cleared", notes=payload.get("notes"),
                  condition=unit["condition"], processedBy=user["email"], toLocation=unit["location"])
    db["transactions"].append(txn)
    _audit(db, user["email"], user["role"], "ITEM_EDIT", "unit", unit["unitId"],
           f"Inspection cleared -> {outcome}", "success", ctx)
    return {"unit": unit, "txn": txn}


# --------------------------------------------------------------- history / lists
def _history_rows(db, item_code=None, unit_id=None):
    rows = []
    for t in db["transactions"]:
        if item_code and t["itemCode"] != item_code:
            continue
        if unit_id and t.get("unitId") != unit_id:
            continue
        rows.append(t)
    return sorted(rows, key=lambda r: r["timestamp"])


def do_item_history(db, user, payload, ctx):
    return {"rows": _history_rows(db, payload.get("itemCode"), payload.get("unitId"))}


def _is_overdue(db, exp_date):
    if not exp_date:
        return False
    grace = db["config"]["overdueGraceDays"]
    try:
        d = date.fromisoformat(exp_date)
    except ValueError:
        return False
    return d + timedelta(days=grace) < date.today()


def _open_borrows(db):
    out = []
    for t in db["transactions"]:
        if t["type"] != "BORROW":
            continue
        outstanding = _outstanding_qty(db, t)
        if outstanding <= 0:
            continue
        out.append({
            "txnId": t["txnId"], "slipNo": t["slipNo"], "itemCode": t["itemCode"],
            "unitId": t.get("unitId"), "borrower": t["party"], "employeeId": t.get("employeeId"),
            "department": t.get("department"), "project": t.get("project"),
            "purpose": t["purpose"], "borrowDate": t["txnDate"],
            "expectedReturnDate": t["expectedReturnDate"], "outstanding": outstanding,
            "processedBy": t["processedBy"],
            "overdue": _is_overdue(db, t["expectedReturnDate"]),
        })
    return out


def do_list_borrowed(db, user, payload, ctx):
    rows = _open_borrows(db)
    name = {s["itemCode"]: s["name"] for s in db["inventory"]}
    for r in rows:
        r["itemName"] = name.get(r["itemCode"], r["itemCode"])
    return {"rows": rows}


def _returnable_issues(db):
    out = []
    for t in db["transactions"]:
        if t["type"] != "ISSUE" or not t.get("expectedReturnDate"):
            continue
        returned = any(x["type"] == "RETURN" and x.get("linkedTxnId") == t["txnId"]
                       for x in db["transactions"])
        if not returned:
            out.append(t)
    return out


def do_list_issued(db, user, payload, ctx):
    """Everything currently issued out: serialized units with status Issued-out,
    plus quantity ISSUE transactions that carry an expected return and aren't back."""
    names = {s["itemCode"]: s["name"] for s in db["inventory"]}
    rows = []

    for u in db["units"]:
        if u.get("status") != "Issued-out":
            continue
        issues = [t for t in db["transactions"]
                  if t["type"] == "ISSUE" and t.get("unitId") == u["unitId"]]
        issue = sorted(issues, key=lambda t: t["timestamp"])[-1] if issues else {}
        rows.append({
            "kind": "unit",
            "itemCode": u["itemCode"], "itemName": names.get(u["itemCode"], u["itemCode"]),
            "unitId": u["unitId"], "qty": 1,
            "recipient": u.get("currentHolder") or issue.get("party"),
            "department": issue.get("department"), "destination": issue.get("destination"),
            "purpose": issue.get("purpose"), "issueDate": issue.get("txnDate"),
            "slipNo": issue.get("slipNo"), "expectedReturnDate": issue.get("expectedReturnDate"),
            "overdue": _is_overdue(db, issue.get("expectedReturnDate")),
        })

    for t in db["transactions"]:
        if t["type"] != "ISSUE" or t.get("unitId"):
            continue
        if not t.get("expectedReturnDate"):
            continue
        if any(x["type"] == "RETURN" and x.get("linkedTxnId") == t["txnId"] for x in db["transactions"]):
            continue
        rows.append({
            "kind": "qty",
            "itemCode": t["itemCode"], "itemName": names.get(t["itemCode"], t["itemCode"]),
            "unitId": None, "qty": t.get("qty"),
            "recipient": t.get("party"), "department": t.get("department"),
            "destination": t.get("destination"), "purpose": t.get("purpose"),
            "issueDate": t.get("txnDate"), "slipNo": t.get("slipNo"),
            "expectedReturnDate": t.get("expectedReturnDate"),
            "overdue": _is_overdue(db, t.get("expectedReturnDate")),
        })

    rows.sort(key=lambda r: (r["expectedReturnDate"] or "9999-99-99", r["itemName"]))
    return {"rows": rows}


def do_list_transactions(db, user, payload, ctx):
    f = payload.get("filters") or {}
    rows = sorted(db["transactions"], key=lambda r: r["timestamp"], reverse=True)
    if f.get("type"):
        rows = [r for r in rows if r["type"] == f["type"]]
    if f.get("itemCode"):
        rows = [r for r in rows if r["itemCode"] == f["itemCode"]]
    if f.get("user"):
        rows = [r for r in rows if r.get("processedBy") == f["user"]]
    if f.get("dateFrom"):
        rows = [r for r in rows if r["txnDate"] >= f["dateFrom"]]
    if f.get("dateTo"):
        rows = [r for r in rows if r["txnDate"] <= f["dateTo"]]
    limit = int(payload.get("limit") or 50)
    cursor = int(payload.get("cursor") or 0)
    page = rows[cursor:cursor + limit]
    nxt = cursor + limit if cursor + limit < len(rows) else None
    return {"rows": page, "nextCursor": nxt, "total": len(rows)}


# -------------------------------------------------------------------- dashboard
def do_get_dashboard(db, user, payload, ctx):
    skus = [s for s in db["inventory"] if s["active"]]
    units = db["units"]
    active_units = [u for u in units if u["status"] not in TERMINAL_STATUSES]
    borrowed_units = [u for u in units if u["status"] == "Borrowed"]
    issued_units = [u for u in units if u["status"] == "Issued-out"]
    inspection_units = [u for u in units if u["status"] == "Under inspection"]

    open_borrows = _open_borrows(db)
    borrowed_qty = sum(b["outstanding"] for b in open_borrows)
    overdue = [b for b in open_borrows if b["overdue"]]
    returnable_issue_qty = sum(t["qty"] for t in _returnable_issues(db))

    qty_total = sum(s["quantityOnHand"] for s in skus if s["trackingType"] == "quantity")
    low_stock = [s for s in skus if s["trackingType"] == "quantity"
                 and s["quantityOnHand"] <= db["config"]["lowStockThreshold"]]

    # charts
    by_cat = {}
    for s in skus:
        n = len(units_of(db, s["itemCode"])) if s["trackingType"] == "serialized" else s["quantityOnHand"]
        by_cat[s["category"]] = by_cat.get(s["category"], 0) + n
    status_break = {}
    for u in units:
        status_break[u["status"]] = status_break.get(u["status"], 0) + 1
    if qty_total:
        status_break["Available"] = status_break.get("Available", 0) + qty_total

    # Zero-fill every day in the window so the chart is a real 30-day timeline,
    # not just the handful of days that happen to have a transaction.
    activity = {}
    start = date.today() - timedelta(days=29)
    for i in range(30):
        key = (start + timedelta(days=i)).isoformat()
        activity[key] = {"RECEIVE": 0, "ISSUE": 0, "BORROW": 0, "RETURN": 0}
    for t in db["transactions"]:
        key = str(t.get("txnDate") or "")[:10]
        if key in activity and t["type"] in activity[key]:
            activity[key][t["type"]] += 1

    recent = sorted(db["transactions"], key=lambda r: r["timestamp"], reverse=True)[:10]

    return {
        "tiles": {
            "skus": len(skus),
            "totalStock": len(active_units) + qty_total,
            "available": len([u for u in units if u["status"] == "Available"]) + qty_total,
            "borrowed": borrowed_qty,
            "outside": borrowed_qty + returnable_issue_qty,
            "overdue": len(overdue),
            "lowStock": len(low_stock),
            "underInspection": len(inspection_units),
        },
        "recent": recent,
        "charts": {
            "byCategory": [{"label": k, "value": v} for k, v in sorted(by_cat.items())],
            "statusBreakdown": [{"label": k, "value": v} for k, v in sorted(status_break.items())],
            "activity30d": [
                {"date": k, **activity[k]} for k in sorted(activity.keys())
            ],
        },
        "lowStockItems": [{"itemCode": s["itemCode"], "name": s["name"],
                           "quantityOnHand": s["quantityOnHand"]} for s in low_stock],
        "overdueItems": overdue,
    }


# ----------------------------------------------------------------------- export
REPORT_DEFS = {
    "inventory": "view",
    "incoming": "view",
    "outgoing": "view",
    "borrowed": "view",
    "overdue": "view",
    "transactions": "view",
    "audit": "export_audit",
}


def do_export_data(db, user, payload, ctx):
    report = payload.get("report")
    if report not in REPORT_DEFS:
        raise ApiError("VALIDATION", "Unknown report.")
    require(user["role"], "export")
    if report == "audit":
        require(user["role"], "export_audit")
    f = payload.get("filters") or {}

    if report == "inventory":
        cols = ["itemCode", "name", "category", "brand", "model", "trackingType",
                "quantityOnHand", "unitsCount", "active"]
        rows = []
        for s in db["inventory"]:
            rows.append({**{c: s.get(c) for c in cols},
                         "unitsCount": len(units_of(db, s["itemCode"]))})
    elif report in ("incoming", "outgoing", "transactions"):
        tmap = {"incoming": ["RECEIVE"], "outgoing": ["ISSUE", "BORROW"],
                "transactions": None}
        cols = ["txnId", "slipNo", "txnDate", "type", "itemCode", "unitId", "qty",
                "qtyDamaged", "party", "department", "purpose", "expectedReturnDate",
                "condition", "processedBy", "notes"]
        rows = [{c: t.get(c) for c in cols} for t in sorted(db["transactions"], key=lambda r: r["timestamp"])
                if tmap[report] is None or t["type"] in tmap[report]]
        if f.get("dateFrom"):
            rows = [r for r in rows if (r["txnDate"] or "") >= f["dateFrom"]]
        if f.get("dateTo"):
            rows = [r for r in rows if (r["txnDate"] or "") <= f["dateTo"]]
    elif report == "borrowed":
        cols = ["slipNo", "itemCode", "unitId", "borrower", "employeeId", "department",
                "project", "purpose", "borrowDate", "expectedReturnDate", "outstanding", "overdue"]
        rows = [{c: b.get(c) for c in cols} for b in _open_borrows(db)]
    elif report == "overdue":
        cols = ["slipNo", "itemCode", "unitId", "borrower", "department",
                "borrowDate", "expectedReturnDate", "outstanding"]
        rows = [{c: b.get(c) for c in cols} for b in _open_borrows(db) if b["overdue"]]
    elif report == "audit":
        cols = ["auditId", "timestamp", "userEmail", "role", "action", "targetType",
                "targetId", "summary", "result"]
        rows = list(db["audit"])
        if not f.get("dateFrom") or not f.get("dateTo"):
            raise ApiError("VALIDATION", "Audit export requires a date range.")
        rows = [r for r in rows if f["dateFrom"] <= r["timestamp"][:10] <= f["dateTo"]]
        rows = [{c: r.get(c) for c in cols} for r in rows]

    if len(rows) > EXPORT_CAP:
        raise ApiError("BLOCKED", f"Export exceeds {EXPORT_CAP} rows; narrow the date range.")
    _audit(db, user["email"], user["role"], "EXPORT", "report", report,
           f"Exported {report} ({len(rows)} rows)", "success", ctx)
    return {"columns": cols, "rows": rows}


# ------------------------------------------------------------------------ audit
def _audit(db, email, role, action, target_type, target_id, summary, result, ctx):
    db["audit"].append({
        "auditId": new_uuid(), "timestamp": now_iso(),
        "userEmail": email, "role": role, "action": action,
        "targetType": target_type, "targetId": target_id, "summary": summary,
        "userAgent": ctx.get("userAgent", ""), "result": result,
    })


def do_list_audit(db, user, payload, ctx):
    require(user["role"], "audit")
    f = payload.get("filters") or {}
    rows = sorted(db["audit"], key=lambda r: r["timestamp"], reverse=True)
    if not f.get("dateFrom") or not f.get("dateTo"):
        raise ApiError("VALIDATION", "Audit log requires a date range.")
    rows = [r for r in rows if f["dateFrom"] <= r["timestamp"][:10] <= f["dateTo"]]
    if f.get("user"):
        rows = [r for r in rows if r.get("userEmail") == f["user"]]
    if f.get("action"):
        rows = [r for r in rows if r["action"] == f["action"]]
    limit = int(payload.get("limit") or 50)
    cursor = int(payload.get("cursor") or 0)
    page = rows[cursor:cursor + limit]
    nxt = cursor + limit if cursor + limit < len(rows) else None
    return {"rows": page, "nextCursor": nxt, "total": len(rows)}


# ------------------------------------------------------------------------ images
def do_upload_image(db, user, payload, ctx):
    require(user["role"], "inventory_write")
    data = payload.get("dataBase64") or ""
    if not data:
        raise ApiError("VALIDATION", "No image data.")
    file_id = "img_" + secrets.token_hex(8)
    # store as a data URL so the mock can serve it straight back to <img>
    mime = payload.get("mime") or "image/jpeg"
    db["images"][file_id] = f"data:{mime};base64,{data}"
    return {"fileId": file_id, "url": db["images"][file_id]}


# ---------------------------------------------------------------------- routing
PUBLIC = {"login", "ping"}

HANDLERS = {
    "logout": do_logout, "session": do_session, "changePassword": do_change_password,
    "listUsers": do_list_users, "createUser": do_create_user, "updateUser": do_update_user,
    "resetPassword": do_reset_password, "forceLogout": do_force_logout,
    "getConfig": do_get_config, "updateConfig": do_update_config,
    "addCategory": do_add_category, "renameCategory": do_rename_category, "deleteCategory": do_delete_category,
    "addLocation": do_add_location, "renameLocation": do_rename_location, "deleteLocation": do_delete_location,
    "listInventory": do_list_inventory, "getItem": do_get_item,
    "createSku": do_create_sku, "updateSku": do_update_sku, "deleteSku": do_delete_sku,
    "addUnits": do_add_units, "updateUnit": do_update_unit,
    "receive": do_receive, "issue": do_issue, "borrow": do_borrow,
    "returnItems": do_return, "clearInspection": do_clear_inspection,
    "itemHistory": do_item_history, "listBorrowed": do_list_borrowed, "listIssued": do_list_issued,
    "listTransactions": do_list_transactions, "getDashboard": do_get_dashboard,
    "exportData": do_export_data, "listAudit": do_list_audit,
    "uploadImage": do_upload_image,
}


def dispatch(body):
    action = body.get("action")
    payload = body.get("payload") or {}
    token = body.get("token")
    ctx = {"token": token, "userAgent": body.get("userAgent", "")}

    if action == "ping":
        return {"ok": True, "data": {"pong": True, "schemaVersion": 1}}

    with _lock:
        ensure_db()
        db = load_db()
        try:
            if action == "login":
                data = do_login(db, payload, ctx)
            else:
                handler = HANDLERS.get(action)
                if not handler:
                    raise ApiError("UNKNOWN_ACTION", f"Unknown action: {action}")
                user = auth(db, token, ctx)
                data = handler(db, user, payload, ctx)
            save_db(db)
            return {"ok": True, "data": data}
        except ApiError as e:
            save_db(db)  # persist audit rows / failed-login counters
            return {"ok": False, "error": {"code": e.code, "message": e.message}}
        except Exception as e:  # noqa
            import traceback
            traceback.print_exc()
            return {"ok": False, "error": {"code": "SERVER", "message": str(e)}}


# ------------------------------------------------------------------------ http
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        payload = json.dumps({"ok": True, "data": {"pong": True}}).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            body = {}
        result = dispatch(body)
        payload = json.dumps(result).encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + (fmt % args) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3000)
    ap.add_argument("--reset", action="store_true",
                    help="rebuild mock-db.json from mock-db.seed.json (discards all local data)")
    args = ap.parse_args()

    ensure_db(reset=args.reset)
    if args.reset:
        print("Rebuilt mock-db.json from seed.")

    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Warehouse mock backend on http://localhost:{args.port}")
    print("Seed logins: admin@warehouse.local / admin123  (also staff/eng/view @warehouse.local)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
