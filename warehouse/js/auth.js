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

  // The submit button must be inside <form> (or reference it via a `form` attribute) —
  // otherwise clicking it does nothing: no submit event, no request, no error shown.
  const btn = h("button.btn.btn--primary", { type: "submit", style: "width:100%;margin-top:4px", text: "Sign in" });
  form.el.appendChild(h("div.field.full", btn));

  const errorBox = h("div.badge.badge--err", { style: "display:none;margin-top:10px" });

  const card = h("div.login-card", [
    h("h1", { text: CONFIG.APP_NAME }),
    h("div.sub", { text: "Sign in to continue" }),
    notice ? h("div.badge.badge--warn", { text: notice, style: "display:block;margin-bottom:12px" }) : null,
    form.el,
    errorBox,
  ]);

  form.el.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.style.display = "none";
    if (!form.validate()) return;
    const { email, password } = form.getValues();
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const data = await call("login", { email, password });
      setSession({ token: data.token, user: data.user });
      toastOk(`Welcome, ${data.user.name}`);
      onSuccess();
    } catch (err) {
      const msg = err.message || "Sign-in failed";
      errorBox.textContent = msg;
      errorBox.style.display = "block";
      toastErr(msg);
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
