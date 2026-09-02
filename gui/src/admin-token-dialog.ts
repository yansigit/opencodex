import { DICTS, getActiveLocale, type Locale } from "./i18n/shared";

const ADMIN_TOKEN_DIALOG_ID = "opencodex-admin-token-dialog";
const ADMIN_TOKEN_USERNAME = "OpenCodex";

export type AdminTokenValidation = "accepted" | "rejected" | "unavailable";
export type AdminTokenVerifier = (token: string) => Promise<AdminTokenValidation>;

/**
 * Ask for the management credential with a real sign-in form so browsers and
 * password managers can offer save/autofill. OpenCodex itself still keeps the
 * submitted token in memory only; persistence remains entirely browser-owned.
 */
export function promptForAdminToken(
  verifyToken: AdminTokenVerifier,
  locale: Locale = getActiveLocale(),
): Promise<string | null> {
  const messages = DICTS[locale];
  const titleText = messages["auth.adminTokenTitle"];

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    let settled = false;

    const dialog = document.createElement("dialog");
    dialog.id = ADMIN_TOKEN_DIALOG_ID;
    dialog.className = "modal-overlay";
    dialog.setAttribute("aria-labelledby", `${ADMIN_TOKEN_DIALOG_ID}-title`);

    const form = document.createElement("form");
    form.className = "modal-card";
    form.method = "post";
    form.action = window.location.href;
    form.autocomplete = "on";
    form.style.display = "flex";
    form.style.flexDirection = "column";
    form.style.gap = "8px";

    const heading = document.createElement("div");
    heading.className = "modal-head";
    heading.style.marginBottom = "4px";
    const title = document.createElement("h3");
    title.id = `${ADMIN_TOKEN_DIALOG_ID}-title`;
    title.textContent = titleText;
    heading.append(title);

    const desc = document.createElement("p");
    desc.className = "modal-desc";
    desc.style.fontSize = "var(--text-label)";
    desc.style.color = "var(--muted)";
    desc.style.lineHeight = "var(--leading-body)";
    desc.style.margin = "0 0 8px";
    desc.textContent = messages["auth.adminTokenDesc"];

    const accountField = document.createElement("div");
    const accountLabel = document.createElement("label");
    accountLabel.className = "field-label";
    accountLabel.htmlFor = `${ADMIN_TOKEN_DIALOG_ID}-username`;
    accountLabel.textContent = messages["auth.adminAccountLabel"];
    const username = document.createElement("input");
    username.id = accountLabel.htmlFor;
    username.className = "input";
    username.type = "text";
    username.name = "username";
    username.autocomplete = "username";
    username.value = ADMIN_TOKEN_USERNAME;
    // ponytail: keep editable for iCloud Keychain — readonly breaks credential matching
    username.readOnly = false;
    username.setAttribute("aria-readonly", "true");
    username.autocapitalize = "none";
    username.spellcheck = false;
    accountField.append(accountLabel, username);

    const tokenField = document.createElement("div");
    tokenField.style.marginTop = "4px";
    const tokenLabel = document.createElement("label");
    tokenLabel.className = "field-label";
    tokenLabel.htmlFor = `${ADMIN_TOKEN_DIALOG_ID}-password`;
    tokenLabel.textContent = messages["auth.adminTokenFieldLabel"];
    const pwWrap = document.createElement("div");
    pwWrap.style.position = "relative";
    pwWrap.style.display = "flex";
    pwWrap.style.alignItems = "center";
    const password = document.createElement("input");
    password.id = tokenLabel.htmlFor;
    password.className = "input";
    password.type = "password";
    password.name = "password";
    password.autocomplete = "current-password";
    password.required = true;
    password.spellcheck = false;
    password.autocapitalize = "none";
    password.placeholder = messages["auth.adminTokenPlaceholder"];
    password.style.paddingRight = "64px";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn btn-ghost";
    toggle.textContent = messages["auth.adminTokenShow"];
    toggle.style.position = "absolute";
    toggle.style.right = "4px";
    toggle.style.minHeight = "28px";
    toggle.style.padding = "2px 10px";
    toggle.style.fontSize = "var(--text-label)";
    toggle.setAttribute("aria-label", messages["auth.adminTokenShow"]);
    toggle.addEventListener("click", () => {
      const show = password.type === "password";
      password.type = show ? "text" : "password";
      toggle.textContent = show ? messages["auth.adminTokenHide"] : messages["auth.adminTokenShow"];
      toggle.setAttribute("aria-label", toggle.textContent);
    });
    pwWrap.append(password, toggle);
    tokenField.append(tokenLabel, pwWrap);

    const validationError = document.createElement("div");
    validationError.className = "notice notice-err";
    validationError.setAttribute("role", "alert");
    validationError.hidden = true;

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    actions.style.marginTop = "8px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost";
    cancel.textContent = messages["common.cancel"];
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "btn btn-primary";
    submit.textContent = messages["common.ok"];
    actions.append(cancel, submit);

    form.append(heading, desc, accountField, tokenField, validationError, actions);
    dialog.append(form);

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      previouslyFocused?.focus();
      resolve(value);
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const token = password.value.trim();
      if (!token) {
        password.value = "";
        password.reportValidity();
        return;
      }
      password.disabled = true;
      submit.disabled = true;
      validationError.hidden = true;
      validationError.textContent = "";

      void verifyToken(token).then((result) => {
        if (settled) return;
        if (result === "accepted") {
          finish(token);
          return;
        }
        password.value = "";
        password.disabled = false;
        submit.disabled = false;
        validationError.textContent = result === "rejected"
          ? messages["auth.adminTokenRejected"]
          : messages["auth.adminTokenUnavailable"];
        validationError.hidden = !validationError.textContent;
        password.focus();
      }).catch(() => {
        if (settled) return;
        password.value = "";
        password.disabled = false;
        submit.disabled = false;
        validationError.textContent = messages["auth.adminTokenUnavailable"];
        validationError.hidden = !validationError.textContent;
        password.focus();
      });
    });
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    // ponytail: let WebKit scan the dialog before stealing focus — microtask races the autofill sheet
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(cb, 16);
    raf(() => password.focus());
  });
}
