# Pack readability

R0 presentation change. Raised prices to 40px, pack names to 20px, entry counts to 16px, and currency, selection and footer details to 14px. Relaxed price letter spacing. Added padding and a divider above fees/availability. The grid now requires 260px per column, collapsing to one column when needed. Non-Entry cards use pure black text; Entry retains white. Disabled cards use a dashed border and desaturation instead of reducing text opacity. Basetica, tier background shades and black dots remain.

124 web tests pass. Production build exits 0, including type checks, with its existing dependency warning. Browser verification exits 0 at 320, 390, 768, 900, 1024 and 1440px. Text meets intended sizes without clipping in checked content rows. No document overflow. Pack selection, quantity/fee totals, agreement gating, keyboard focus, sold-out and closed states, hover bounds, squish animation and live reduced-motion changes pass. Zero page errors. Mobile and desktop pack screenshots inspected. Evidence: `artifacts/pack-readability/`.

Local Preview refreshed. No push or deployment. No purchase or contract logic changed.
