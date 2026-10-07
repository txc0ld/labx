// Scoped compatibility adapter for AppKit 1.8.19's open shadow DOM.
export function observeWalletConnectModal(modal: HTMLElement): () => void {
  const observed = new Set<ShadowRoot | HTMLElement>();
  const named = new WeakSet<Element>();
  const pendingDefinitions = new Set<string>();
  const keyboardControls = new Map<HTMLElement, (event: KeyboardEvent) => void>();
  let disposed = false;

  function label(control: Element | null | undefined, value: string) {
    if (!control || control.getAttribute("aria-label")?.trim() && !named.has(control)) return;
    if (control.getAttribute("aria-label") !== value) control.setAttribute("aria-label", value);
    named.add(control);
  }
  function scan(root: ShadowRoot | HTMLElement) {
    if (disposed) return;
    if (!observed.has(root)) {
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["icon", "name", "aria-label"] });
      observed.add(root);
    }
    if (root instanceof HTMLElement && root.shadowRoot) scan(root.shadowRoot);
    for (const element of root.querySelectorAll("*")) {
      if (["w3m-header", "wui-icon-button", "wui-certified-switch", "wui-toggle", "w3m-all-wallets-view"].includes(element.localName) && !customElements.get(element.localName) && !pendingDefinitions.has(element.localName)) {
        pendingDefinitions.add(element.localName);
        void customElements.whenDefined(element.localName).then(() => { if (!disposed) scan(modal); });
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
  const observer = new MutationObserver(() => scan(modal));
  scan(modal);
  return () => {
    disposed = true;
    observer.disconnect();
    observed.clear();
    for (const [control, listener] of keyboardControls) control.removeEventListener("keydown", listener);
    keyboardControls.clear();
  };
}
