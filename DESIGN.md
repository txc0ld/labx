# LABx design brief

LABx is a Sepolia membership bench for one escrowed piece at a time. The interface is a frosted gallery suspended over a lavender field: translucent plates, fine chrome edges, and restrained fluorescent signals frame the artwork without competing with it.

## Source of truth

| File | Role |
| --- | --- |
| `design/reference/colour-tokens.png` | Exact UI colour tokens. |
| `web/public/lab/hero-linked-panels.jpg` | Hero hardware: terminal, chrome junction, glossy filter panel, fluoro cables. No figure. |
| `web/public/lab/filter-panel.jpg` | Glossy filter panel with chunky buttons and a chrome port. |
| `web/public/lab/terminal-panel.jpg` | Purple terminal housing, chrome bezel, fluoro cable. |
| `web/public/lab/chrome-fluoro-run.jpg` | Mirrored chrome plumbing and fluoro cables between two panels. |

Photographs are props. Interface words are HTML set in Space Grotesk and IBM Plex Mono. Do not treat lettering baked into a render as navigation or data.

## Hard exclusions

- No human, head, face, figure, mannequin, eye, or wireframe body in UI, icons, alt text, or generated assets.
- Tubes, cables, ports, and junctions connect panels to panels. They do not connect to a character.
- Frosted surfaces must retain a bright inner edge, readable contrast, and a high-opacity lightweight fallback on mobile. Avoid stacking multiple broad blur layers.
- No public floor and no published private commitment. Membership pack prices are shown because they are the product.
- Do not call packs tickets. The product word is membership pack. The chance word is bonus entry.
- Ethereum mainnet is not a theme, a network option, or a deploy target.

## Colour tokens

Use these values exactly.

| Use | Token |
| --- | --- |
| Field | `#E6D8FA` soft lavender, matching the moodboard ground |
| Lavender accent | `#B09BE8` |
| Purple accent, primary CTA, active focus alternate | `#8049FF` |
| Text on purple | `#FFFFFF` |
| Lime, warning fill, active pack, focus ring | `#B9FF87` with black text |
| Pink, error fill, destructive | `#FF79C0` with black text |
| Mint, success lamp, fluoro cable | `#8FFFB6` |
| Body text | `#000000` |
| Secondary text | `#3C3B3C` |
| Text on the dark terminal | `#DBDBDB` |
| Inset ceramic well | `#D4DED2` |
| Terminal ground | `#140C2E` |

Fluoro `#B9FF87`, `#FF79C0`, `#8FFFB6`, `#8049FF`, and `#B09BE8` are for cables, ports, status lamps, active states, and CTAs. They sit bright against the matte-pearl panels. Body copy stays black or charcoal on pearl and on lime or pink fills.

Sage `#D4DED2` is the pigment inside inset wells. The page field is lavender, because that is the moodboard ground.

## Materials

**Lavender field.** The page background is a soft lilac wash with a hairline purple wordmark (`LAB`) stroked, not filled, behind the console.

**Frosted panel.** Translucent white over lavender with a fine inner highlight, a faint chrome-lavender edge, and a deep diffused purple shadow. Major surfaces use generous concentric corners. Mobile uses high-opacity layered gradients instead of broad live blur.

**Mirrored chrome bezel.** A tight metallic gradient (white, steel, white, graphite, white) wraps every photograph and the outer frame of a major panel. Specular, not blurred glass.

**Inset well.** Sage ceramic pressed in with an inner shadow. Use it for agreements, tables, and the complimentary-entry block.

**Purple terminal.** Dark violet instrument screen for wallet, chain, and VRF copy. Text on it is `#DBDBDB`, not body black.

**Controls.** Buttons are compact, weighty islands with a soft inset highlight and directional arrow feedback. Pressing scales them slightly. Lime and pink buttons use black text. Purple buttons use white text. The active pack key is translucent lime.

**Fluoro cable and chrome port.** SVG plumbing between sections: steel tube, black port, fluoro core in mint, purple, lime, or pink. A dash animation runs along the cable. Photographs repeat the same hardware at hero scale.

## Motion

Purposeful and staged.

- The hero title performs one short deterministic resolution effect while its complete semantic heading remains available to assistive technology.
- Hero, catalog, and detail surfaces resolve with a weighted fade and vertical transform as they enter view. Content stays visible before JavaScript initializes and if observation is unavailable.
- Artwork stacks open subtly on pointer hover; catalog artwork lifts inside its frame; arrows respond directionally. Nothing hijacks scrolling or loops for decoration.
- Motion uses transforms and opacity. Observers and timers clean up on navigation. A live `prefers-reduced-motion` change immediately reveals the final title, stops observers, and leaves all content visible.

## Surfaces

**Explore.** A floating frosted header holds the LABx mark, primary navigation, and Sepolia · USDC chip. Discovery uses an editorial split: a resolved headline and concise action block beside a layered preview of actual demo artwork. A compact disclosure replaces the former dashboard-like terminal. One frosted capsule per piece follows. Capsules keep artwork uncropped and show title, artist, phase, Entry pack price, lab fee, UTC sales deadline, and remaining sales time where valid. All pieces, Packs open, and Ended filters operate on browser demo records. Zero pieces has an explicit empty state; one capsule remains centered; multiple capsules form a responsive grid. Entire capsules are keyboard-accessible links to stable `/piece/[id]` routes. Drafts, expired deadlines, and unavailable packs are not presented as open. This is explicitly a demo catalog, not a live on-chain listing. A lime warning strip preserves the Sepolia/mainnet restriction.

The original discovery refinements draw on visually inspected public references: Atelier UI's fine construction grid and registration framing, Sora UI's clear catalog hierarchy and repeated image previews, and Refero Styles' breathing room and rounded preview wells. LABx retains its own fonts, exact colour tokens, original CSS, and existing hardware assets. No reference code, assets, logos, or proprietary components are imported.

**Piece.** A sticky double-bezel artwork stage sits beside a frosted purchase console. The artwork stays uncropped. Packs form a clear responsive selection grid from Entry to Platinum; every key shows bonus entries, USDC price, remaining supply, and the 5 USDC lab fee. Quantity and the live total share a compact order panel. Three real checkboxes gate the purchase. The commitment hash is mono type, not a private number.

**Studio.** Pearl form for a new piece, filter photograph as the console, then one pearl row per piece with escrow, open, close, snapshot, draw, reveal, settle, cancel, and claim. Settle and cancel leave the piece escrowed until claim. The private commitment field is cleared after submit and is never rendered on explore, the piece page, or fairness. The salt is not stored on the bench.

**Profile.** Terminal readout for wallet and points. Connect Sepolia, or use the bench wallet. Entries table with expiry. Receipt email. Agreement log.

**Fairness.** Three locks: escrow, commit, VRF. A table per piece. Revealed rows may show the public summary. They do not show the private commitment.

**Draw rules.** The complimentary entry lives here, after the rules, not in the header and not on the hero.

## Accessibility

- Landmarks: header, nav, main, footer. Skip link.
- One h1 per page. Buttons are buttons. Pack keys are radios.
- Labels point at inputs. Errors use `role="alert"`. Status uses `role="status"`.
- Checkboxes keep the native control and `accent-color: #8049FF`.
- Focus is a 3px lime ring, purple on lime controls.
- Warning and error fills use black text.
- Decorative plumbing has an accessible name. Piece photographs describe hardware, never a person.

## Copy

Short, physical, specific. “Membership pack”, “bonus entries”, “escrow”, “snapshot”, “lab fee”, “Sepolia”. Prices are pack prices. The 5 USDC lab fee is always visible next to the pack.

## Do not

- Add a figure back into a plate “for warmth”.
- Flatten the panels into solid grey cards.
- Put body text in fluoro green or pink.
- Use the prop lettering inside the photographs as real labels.
- Promote the complimentary entry on explore.
