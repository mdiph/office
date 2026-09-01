import { h } from "./util/dom.js";
import { call } from "./api.js";
import { setSession, clearSession, session } from "./store.js";
import { toastErr, toastOk } from "./components/toast.js";
import { buildForm } from "./components/form.js";
import { openModal } from "./components/modal.js";
import { CONFIG } from "../config.js";

// Renders the login screen into `root`; calls onSuccess() when signed in.
export function renderLogin(root, onSuccess, notice) {
  const form = buildForm([
    { name: "email", label: "Email", type: "text", required: true, full: true, placeholder: "you@company.com" },
    { name: "password", label: "Password", type: "password", required: true, full: true },
  ]);

  const btn = h("button.btn.btn--primary", { type: "submit", style: "width:100%", text: "Sign in" });
  const card = h("div.login-card", [
    h("h1", { text: CONFIG.APP_NAME }),
    h("div.sub", { text: "Sign in to continue" }),
    notice ? h("div.badge.badge--warn", { text: notice, style: "display:block;margin-bottom:12px" }) : null,
    form.el,
    h("div", { style: "margin-top:8px" }, btn),
    h("div.login-hint", { html: "Mock logins: <span class='mono'>admin@warehouse.local / admin123</span> (also staff / eng / view)." }),
  ]);
  form.el.appendChild(h("input", { type: "submit", hidden: true }));

  form.el.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.validate()) return;
    const { email, password } = form.getValues();
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const data = await call("login", { email, password });
      setSession({ token: data.token, user: data.user });
      toastOk(`Welcome, ${data.user.name}`);
      onSuccess();
    } catch (err) {
      toastErr(err.message || "Sign-in failed");
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });

  root.innerHTML = "";
  root.appendChild(h("div.login-wrap", [card]));
  form.field("email").focus();
}

export async function logout() {
  try { await call("logout"); } catch {}
  clearSession();
  location.hash = "#/";
  location.reload();
}

export function openChangePassword() {
  const form = buildForm([
    { name: "currentPassword", label: "Current password", type: "password", required: true, full: true },
    { name: "newPassword", label: "New password (min 8)", type: "password", required: true, full: true },
    { name: "confirm", label: "Confirm new password", type: "password", required: true, full: true },
  ]);
  const m = openModal({ title: "Change password", body: form.el });
  const save = h("button.btn.btn--primary", { text: "Update password" });
  m.setFooter([h("button.btn", { text: "Cancel", onclick: () => m.close() }), save]);
  save.addEventListener("click", async () => {
    if (!form.validate()) return;
    const v = form.getValues();
    if (v.newPassword !== v.confirm) { form.setError("confirm", "Passwords do not match"); return; }
    save.disabled = true;
    try {
      await call("changePassword", { currentPassword: v.currentPassword, newPassword: v.newPassword });
      toastOk("Password updated");
      m.close();
    } catch (e) {
      toastErr(e.message);
      save.disabled = false;
    }
  });
}

export function requireSession() { return !!session(); }
