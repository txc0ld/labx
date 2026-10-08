// Scoped compatibility adapter for AppKit 1.8.19's open shadow DOM.
export function observeWalletConnectModal(source: Document | HTMLElement): () => void {
  const observed = new Set<Document | ShadowRoot | HTMLElement>();
  const named = new WeakSet<Element>();
  const pendingDefinitions = new Set<string>();
  const keyboardControls = new Map<HTMLElement, (event: KeyboardEvent) => void>();
  let disposed = false;

  function label(control: Element | null | undefined, value: string) {
    if (!control || control.getAttribute("aria-label")?.trim() && !named.has(control)) return;
    if (control.getAttribute("aria-label") !== value) control.setAttribute("aria-label", value);
    named.add(control);
  }
  function observe(root: Document | ShadowRoot | HTMLElement) {
    if (observed.has(root)) return;
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["icon", "name", "aria-label"] });
    observed.add(root);
  }
  function scan(root: Document | ShadowRoot | HTMLElement) {
    if (disposed) return;
    observe(root);
    if (root instanceof HTMLElement && root.shadowRoot) scan(root.shadowRoot);
    for (const element of root.querySelectorAll("*")) {
      if (["w3m-header", "wui-icon-button", "wui-certified-switch", "wui-toggle", "w3m-all-wallets-view"].includes(element.localName) && !customElements.get(element.localName) && !pendingDefinitions.has(element.localName)) {
        pendingDefinitions.add(element.localName);
        void customElements.whenDefined(element.localName).then(() => { if (!disposed) scanSource(); });
      }
      if (element.matches('[data-testid="w3m-modal-card"][role="alertdialog"], [data-testid="w3m-modal-card"][role="dialog"]')) label(element, "WalletConnect");
      if (element.matches("w3m-header")) {
        for (const host of element.shadowRoot?.querySelectorAll("wui-icon-button") ?? []) {
          const icon = host.getAttribute("icon");
          const name = icon === "close" ? "Close wallet connection" : icon === "chevronLeft" ? "Back" : icon === "helpCircle" ? "What is a wallet?" : null;
          if (name) label(host.shadowRoot?.querySelector("button"), name);
        }
      }
      if (element.matches("wui-certified-switch")) {
        const toggle = element.shadowRoot?.querySelector("wui-toggle");
        label(toggle?.shadowRoot?.querySelector('input[type="checkbox"]'), "Only WalletConnect certified wallets");
      }
      if (element.matches("w3m-all-wallets-view")) {
        const qr = element.shadowRoot?.querySelector('wui-icon-box[icon="qrCode"]');
        if (qr instanceof HTMLElement) {
          label(qr, "Show WalletConnect QR code");
          if (!qr.hasAttribute("role")) qr.setAttribute("role", "button");
          if (!qr.hasAttribute("tabindex")) qr.tabIndex = 0;
          if (!keyboardControls.has(qr)) {
            const onKey = (event: KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (!event.repeat) qr.click();
              }
            };
            qr.addEventListener("keydown", onKey);
            keyboardControls.set(qr, onKey);
          }
        }
      }
      if (element.shadowRoot) scan(element.shadowRoot);
    }
  }
  function scanSource() {
    if (source instanceof HTMLElement) {
      scan(source);
      return;
    }
    observe(source);
    for (const modal of source.querySelectorAll("w3m-modal")) {
      if (modal instanceof HTMLElement) scan(modal);
    }
  }
  const observer = new MutationObserver(scanSource);
  scanSource();
  return () => {
    disposed = true;
    observer.disconnect();
    observed.clear();
    for (const [control, listener] of keyboardControls) control.removeEventListener("keydown", listener);
    keyboardControls.clear();
  };
}

export function refreshWalletConnectConnectorLists(source: Document | HTMLElement): void {
  const visit = (root: Document | ShadowRoot | HTMLElement) => {
    if (root instanceof HTMLElement && root.shadowRoot) visit(root.shadowRoot);
    for (const element of root.querySelectorAll("*")) {
      if (element.localName === "w3m-connector-list" && "requestUpdate" in element && typeof element.requestUpdate === "function") {
        element.requestUpdate();
      }
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  if (source instanceof HTMLElement) visit(source);
  else for (const modal of source.querySelectorAll("w3m-modal")) if (modal instanceof HTMLElement) visit(modal);
}
