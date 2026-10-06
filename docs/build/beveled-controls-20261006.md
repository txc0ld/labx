# Beveled buttons and controls

R0 presentation update. Interpreted the user's request to extend the treatment as applying the smooth beveled styling to buttons and controls. Primary, lime, pink and dark buttons use rounded gradient surfaces, soft bevels and restrained text shadows. Filters use a recessed group with raised options and a distinct selected option. The wallet control and form fields share the finish. Navigation/action links receive a light text bevel; Explore retains its transparent active background and footer links remain unboxed.

The existing Pixel Perfect purchase button retains its animated expanding face and action, with a softer dark finish and rounded lime face. Disabled controls retain readable opacity with a desaturated, dashed treatment. Reduced-motion styles prevent press transforms. Labels, handlers, wallet flows and purchase/consent logic are unchanged. No dependencies were added.

Verification: 124 web tests pass. Production build exits 0, including type validation, with the existing dependency warning. Browser checks pass for home, detail, profile, rules, seller and about at 320, 390, 768 and 1440px: 24 page/viewport combinations, no horizontal overflow, readable labels, at least 44px control height, rounded/inset styling, editable inputs, filtering, guide/wallet-page navigation, keyboard focus, disabled states, purchase hover animation and consent gate, and reduced motion. Zero page errors. No wallet connection, agreement acceptance, financial action or form submission was performed.

Evidence: `artifacts/beveled-controls/`. The initial browser script used an ambiguous How it works link locator; scoped it to the intended guide link and reran successfully. Home screenshots were recaptured after the text scramble finished. Mobile profile and desktop home/purchase screenshots inspected.

Local Preview refreshed on port 3113. No push or deployment. Model usage is not exposed; no delegated workers were required for this R0 change.
