import { h } from "../util/dom.js";
import { call } from "../api.js";
import { getConfig } from "../store.js";
import { pageHead, card, btn, withBusy } from "./_shared.js";
import { dataTable } from "../components/table.js";
import { buildForm } from "../components/form.js";
import { openModal } from "../components/modal.js";
import { confirmDialog } from "../components/confirm.js";
import { toastOk, toastErr } from "../components/toast.js";
import { fmtDateTime } from "../util/dates.js";

export async function viewUsers() {
  const [{ users }, cfg] = await Promise.all([call("listUsers"), getConfig()]);
  const roles = cfg.roles;

  const table = dataTable({
    columns: [
      { key: "name", label: "Name" },
      { key: "email", label: "Email", render: (u) => h("span.mono", { text: u.email }) },
      { key: "role", label: "Role", render: (u) => h("span.badge.badge--info", { text: u.role }) },
      { key: "active", label: "Status", render: (u) => u.active ? h("span.badge.badge--ok", { text: "Active" }) : h("span.badge.badge--mut", { text: "Disabled" }) },
      { key: "createdAt", label: "Created", render: (u) => fmtDateTime(u.createdAt) },
      { key: "_a", label: "", sortable: false, render: (u) => h("div.row", [
        btn("Edit", "edit", { sm: true, onClick: () => openEdit(u) }),
        btn("Reset pw", null, { sm: true, onClick: () => openReset(u) }),
        btn("Force logout", null, { sm: true, onClick: () => forceLogout(u) }),
      ]) },
    ],
    rows: users,
    emptyText: "No users.",
  });

  function reload() { location.reload(); }

  function openCreate() {
    const form = buildForm([
      { name: "name", label: "Full name", required: true, full: true },
      { name: "email", label: "Email", required: true, full: true },
      { name: "role", label: "Role", type: "select", options: roles, required: true },
      { name: "password", label: "Password (min 8)", type: "password", required: true },
    ]);
    const m = openModal({ title: "Create user", body: form.el });
    const save = h("button.btn.btn--primary", { text: "Create" });
    m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), save]);
    save.addEventListener("click", () => withBusy(save, async () => {
      if (!form.validate()) return;
      const v = form.getValues();
      if (v.password.length < 8) { form.setError("password", "Min 8 characters"); return; }
      try { await call("createUser", v); toastOk("User created"); m.close(); reload(); }
      catch (e) { toastErr(e.message); }
    }));
  }

  function openEdit(u) {
    const form = buildForm([
      { name: "name", label: "Full name", value: u.name, required: true, full: true },
      { name: "role", label: "Role", type: "select", options: roles, value: u.role, required: true },
      { name: "active", label: "Account active", type: "checkbox", value: u.active },
    ]);
    const m = openModal({ title: `Edit ${u.email}`, body: form.el });
    const save = h("button.btn.btn--primary", { text: "Save" });
    m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), save]);
    save.addEventListener("click", () => withBusy(save, async () => {
      if (!form.validate()) return;
      try { await call("updateUser", { email: u.email, ...form.getValues() }); toastOk("User updated"); m.close(); reload(); }
      catch (e) { toastErr(e.message); }
    }));
  }

  function openReset(u) {
    const form = buildForm([{ name: "newPassword", label: "New password (min 8)", type: "password", required: true, full: true }]);
    const m = openModal({ title: `Reset password — ${u.email}`, body: form.el });
    const save = h("button.btn.btn--primary", { text: "Set password" });
    m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), save]);
    save.addEventListener("click", () => withBusy(save, async () => {
      if (!form.validate() || form.getValues().newPassword.length < 8) { form.setError("newPassword", "Min 8 characters"); return; }
      try { await call("resetPassword", { email: u.email, newPassword: form.getValues().newPassword }); toastOk("Password reset"); m.close(); }
      catch (e) { toastErr(e.message); }
    }));
  }

  async function forceLogout(u) {
    if (!(await confirmDialog({ title: "Force logout?", message: `End all active sessions for ${u.email}.`, confirmLabel: "Force logout", danger: true }))) return;
    try { await call("forceLogout", { email: u.email }); toastOk("Sessions ended"); }
    catch (e) { toastErr(e.message); }
  }

  return h("div.stack", [
    pageHead("Users", [
      btn("Roles & access", "shield", { onClick: openRolesMatrix }),
      btn("Add user", "plus", { primary: true, onClick: openCreate }),
    ]),
    card(null, table.el),
  ]);
}

// action label -> which roles can do it
const ROLE_MATRIX = [
  ["View dashboard, inventory, borrowed & issued lists, item history", ["Admin", "Warehouse Staff", "Engineer", "Viewer"]],
  ["Export reports (CSV / Excel / print)", ["Admin", "Warehouse Staff", "Engineer"]],
  ["Receive stock (new items and restock)", ["Admin", "Warehouse Staff"]],
  ["Edit item details & individual units; archive items", ["Admin", "Warehouse Staff"]],
  ["Issue permanently (sold / consumed)", ["Admin", "Warehouse Staff"]],
  ["Record a loan / borrow for themselves", ["Admin", "Warehouse Staff", "Engineer"]],
  ["Record a loan / borrow on behalf of someone else", ["Admin", "Warehouse Staff"]],
  ["Process returns & clear items out of inspection", ["Admin", "Warehouse Staff"]],
  ["Manage users & roles, reset passwords, force logout", ["Admin"]],
  ["View & export the Audit Log", ["Admin"]],
  ["Edit Settings (thresholds, categories, locations)", ["Admin"]],
  ["Delete transaction history", []],
];
const ROLE_COLS = ["Admin", "Warehouse Staff", "Engineer", "Viewer"];

function openRolesMatrix() {
  const thead = h("thead", h("tr", [
    h("th", { text: "Action" }),
    ...ROLE_COLS.map((r) => h("th", { style: "text-align:center", text: r })),
  ]));
  const tbody = h("tbody", ROLE_MATRIX.map(([label, allowed]) =>
    h("tr", [
      h("td.wrap", { text: label }),
      ...ROLE_COLS.map((r) => h("td", { style: "text-align:center" },
        allowed.includes(r)
          ? h("span", { style: "color:var(--c-ok);font-weight:700", text: "✓" })
          : h("span", { style: "color:var(--c-border-strong)", text: "—" }))),
    ])));
  const body = h("div.stack", [
    h("div.muted", { style: "font-size:.85rem", text:
      "The backend enforces these on every request — hiding a menu item is only cosmetic. “Engineer” covers Engineer / Employee." }),
    h("div.table-wrap", h("table.tbl", [thead, tbody])),
  ]);
  const m = openModal({ title: "Roles & access", body, wide: true });
  m.setFooter([btn("Close", null, { onClick: () => m.close() })]);
}
