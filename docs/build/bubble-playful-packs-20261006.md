# Bubble cards, playful type and purple Entry

R0 presentation update across the user's three consecutive requests. Cards now have 28px rounded corners, soft outer shadows, inset edge shading, an inner rim and a small glossy highlight. Decorative overlays do not capture input. Selected and keyboard focus states remain distinct, and the existing hover squish/reduced-motion behavior is preserved.

Pack names are larger lowercase Basetica, prices are 48px, and labels say "Pick me" or "Your pick". Disabled cards say "Unavailable". The section heading is "Pick your pack". Entry now uses the requested #B37DF6 purple with a lighter highlight and black text. Its three gradient stops have black-text contrast ratios of 5.48, 12.39 and 7.18. Bronze, silver, gold and lime Platinum gradients remain. Real fees, entry counts and availability are unchanged.

Final combined candidate: 124 web tests pass. Production build exits 0, including type validation, with the existing dependency warning. Browser checks pass at 320, 390, 768, 900, 1024 and 1440px: purple Entry, bubble CSS, selection copy, readable sizes, no text clipping or horizontal overflow, keyboard selection/focus, quantity/fee totals, agreement gating, sold-out/closed states, hover bounds and live reduced-motion behavior. Zero page errors. Mobile and desktop screenshots inspected. Evidence: `artifacts/playful-packs/`. Earlier bubble-only evidence is under `artifacts/bubble-packs/`; final evidence supersedes it.

Local Preview refreshed. No push or deployment. No purchase or contract logic changed.
