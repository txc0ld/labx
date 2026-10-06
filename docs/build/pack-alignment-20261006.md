# Pack card alignment

R0 presentation adjustment. The card decorations now use black SVG fills with no SVG opacity reduction. Shapes occupy a separate column beside the price and entry count. Headers, selection labels and footers share consistent alignment. Mobile widths up to 540px use one card per row. Existing selection, disabled behavior, squish animation and reduced-motion handling are preserved.

Validation against the attached source diff: 124 web tests pass, production build exits 0 with its existing dependency warning, and browser verification exits 0. Browser widths 320, 390, 768 and 1440 have no overflow, black SVG fills and separate text/graphic columns. Pack selection, quantity totals, agreement gating, sold-out and closed states, keyboard focus, hover and live reduced-motion toggles pass with zero page errors. Mobile and desktop screenshots inspected. Evidence: `artifacts/pack-alignment/`, including `tested.patch`. The browser log identifies the parent revision because checks ran before this local commit.

Local Preview refreshed on port 3113. No push or deployment. No purchase, contract or backend logic changed. No additional standalone model review required for this R0 adjustment.
